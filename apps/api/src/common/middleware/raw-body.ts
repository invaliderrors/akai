import { PayloadTooLargeException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/**
 * Capture the UNPARSED request bytes, for the webhook route and nothing else.
 *
 * WHY NOT `NestFactory.create(AppModule, { rawBody: true })`. That flag is
 * global: it hangs a `verify` callback on the JSON and urlencoded parsers, so
 * EVERY request in the platform retains a second, full copy of its body as a
 * Buffer for the lifetime of the request. One route needs those bytes. Paying
 * for them on `/v1/cart`, `/v1/orders` and every authenticated admin call means
 * doubling the resident body memory of the whole API, and — worse — parking a
 * verbatim copy of every password-reset and address payload in a place nothing
 * is looking at. Scoping it is not a micro-optimisation; it is keeping raw
 * credentials out of memory they have no reason to be in.
 *
 * WHY THE BYTES ARE NEEDED AT ALL. Resend (Svix) signs the raw body: the HMAC is
 * computed over the exact octets it transmitted. `JSON.parse` followed by
 * `JSON.stringify` does not reliably reproduce them — key order, unicode
 * escaping and number formatting are all free to differ — so a signature
 * verified against a re-serialised body fails for authentic deliveries and, far
 * worse, could be made to pass for a body that is not what was signed. There is
 * a test asserting exactly that round-trip fails to verify.
 *
 * HOW IT COOPERATES WITH THE PARSER THAT RUNS AFTER IT. This middleware consumes
 * the request stream, so the body-parser Nest registers downstream would find an
 * exhausted stream and hang until the socket timed out. `body-parser` has a
 * documented opt-out for precisely this case: it checks `req._body === true`
 * first and skips a request already parsed by someone else. Setting that flag
 * (with `body` set to a real value alongside it) is what makes the handoff
 * clean, rather than racing two readers on one stream.
 *
 * The webhook controller never reads `req.body` — it parses `rawBody` itself,
 * after the signature has been verified — so `body` is populated only to keep
 * the contract with anything downstream that expects the property to exist.
 */

/**
 * The properties this middleware writes onto the Express request.
 *
 * Declared as its own interface and assigned through a typed local rather than
 * cast: `Request` is structurally compatible with this shape, so the compiler
 * checks the assignment instead of being told to stop looking. No `any`, no
 * module augmentation of a third-party namespace.
 */
interface RawBodyCarrier {
  rawBody?: Buffer;
  body?: unknown;
  /** `body-parser`'s own "already parsed, skip me" flag. */
  _body?: boolean;
}

export interface RawBodyOptions {
  /**
   * Hard ceiling on buffered bytes.
   *
   * An unbounded reader on a public, unauthenticated endpoint is a
   * memory-exhaustion primitive: the signature cannot be checked until the body
   * has been read, so anyone on the internet can make us buffer whatever they
   * send. Webhook payloads are a few kilobytes; 1 MiB is generous and still
   * bounded.
   */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1_048_576;

/**
 * The over-limit refusal. **An `HttpException`, and that is the whole point.**
 *
 * This used to extend plain `Error`, and nothing anywhere mapped it. The middleware hands
 * it to Express `next()`, Nest's registered error handler rethrows it through
 * `AllExceptionsFilter`, and an unrecognised `Error` there is classified
 * `INTERNAL_ERROR` — so the one input an unauthenticated caller fully controls the size of
 * produced a **500**. That is wrong twice over. It reports our bug for their oversized
 * request, and it lands on the single route whose documented contract says a non-2xx is a
 * retry instruction: a body over the cap is refused IDENTICALLY on every attempt, so a
 * genuine sender that ever exceeded the limit would retry a permanent 500 forever.
 *
 * Carrying the status ON THE EXCEPTION rather than adding a case to the filter is the
 * root-cause form: the filter already handles every `HttpException` correctly, so there is
 * no second place that has to be remembered, and no way to add another middleware error
 * that silently falls through to 500 again. 413 is the honest answer — the request was
 * refused for its size, the caller can see that, and it is not retryable-by-shrinking-time.
 *
 * The response code in the envelope is `VALIDATION_FAILED`, the filter's designed fallback
 * for a 4xx with no domain code attached. There is deliberately no new member added to the
 * published `errorCodeSchema` enum for this: the enum is a client-facing contract and no
 * client branches on "your webhook body was too big".
 *
 * Answering 200 with a deduped operator alert — what the controller does for a verified
 * body it cannot parse — is NOT available here. The cap fires before the signature is
 * checked, so these bytes are of unknown provenance; acknowledging them, or writing a row
 * per delivery on their behalf, hands an unauthenticated caller the write amplification
 * the cap exists to deny.
 */
export class RawBodyTooLargeError extends PayloadTooLargeException {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeded the ${maxBytes}-byte webhook limit`);
    this.name = "RawBodyTooLargeError";
  }
}

/**
 * Express middleware that buffers the request body and exposes it as
 * `request.rawBody`.
 *
 * Mount it on ONE path. Mounting it globally reintroduces exactly the cost this
 * exists to avoid.
 */
export function createRawBodyMiddleware(
  options: RawBodyOptions = {},
): (request: Request, response: Response, next: NextFunction) => void {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return (request, response, next) => {
    const carrier: RawBodyCarrier = request;

    // Already read by something upstream. Re-reading would produce an empty
    // buffer and a signature failure that looks like an attack rather than a
    // misconfiguration.
    if (carrier._body === true) {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      next(error);
    };

    function onData(chunk: Buffer | string): void {
      if (settled) {
        return;
      }

      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += buffer.length;

      if (total > maxBytes) {
        // Stop reading immediately — the point of the limit is not to have
        // buffered the bytes in the first place.
        request.pause();
        fail(new RawBodyTooLargeError(maxBytes));
        return;
      }

      chunks.push(buffer);
    }

    function onEnd(): void {
      if (settled) {
        return;
      }
      settled = true;

      const rawBody = Buffer.concat(chunks);
      carrier.rawBody = rawBody;

      // Signal to the downstream body-parser that this request is done. Both
      // properties are required: `_body` is what body-parser checks, and `body`
      // is what every handler after it assumes exists.
      carrier.body = {};
      carrier._body = true;

      next();
    }

    function onError(error: Error): void {
      fail(error);
    }

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  };
}
