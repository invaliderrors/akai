import { HttpException, HttpStatus } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { RawBodyTooLargeError, createRawBodyMiddleware } from "./raw-body";

/**
 * The raw-body middleware is the load-bearing half of webhook authentication.
 *
 * Whop signs the exact octets it sent. If these bytes are wrong — parsed
 * and re-serialised, truncated, or simply absent — every authentic delivery
 * fails verification and every order stalls in AWAITING_PAYMENT. That failure
 * mode is invisible to the type-checker and to every test that stubs
 * verification, which is why it is tested here directly.
 */

/** The properties the middleware writes, for assertions. */
interface Carrier {
  rawBody?: Buffer;
  body?: unknown;
  _body?: boolean;
}

/**
 * A fake Express request backed by a real stream.
 *
 * `Readable` genuinely emits `data`/`end`, so the middleware's listener wiring
 * is exercised rather than simulated.
 */
function requestFrom(chunks: readonly (Buffer | string)[]): Request & Carrier {
  const stream = Readable.from(chunks);
  // `Readable` is not an Express `Request`, but the middleware touches only the
  // stream surface. The double assertion is confined to this test helper and
  // never reaches production code.
  return stream as unknown as Request & Carrier;
}

function noopResponse(): Response {
  return {} as unknown as Response;
}

async function run(
  request: Request & Carrier,
  options?: Parameters<typeof createRawBodyMiddleware>[0],
): Promise<{ error: unknown }> {
  return new Promise((resolve) => {
    const next: NextFunction = (error?: unknown) => {
      resolve({ error: error ?? null });
    };
    createRawBodyMiddleware(options)(request, noopResponse(), next);
  });
}

describe("createRawBodyMiddleware", () => {
  it("exposes the body as a Buffer of the exact bytes received", async () => {
    const payload = '{"type":"payment/succeeded","amount":4999}';
    const request = requestFrom([Buffer.from(payload, "utf8")]);

    const { error } = await run(request);

    expect(error).toBeNull();
    expect(Buffer.isBuffer(request.rawBody)).toBe(true);
    expect(request.rawBody?.toString("utf8")).toBe(payload);
  });

  it("preserves bytes a JSON round trip would NOT preserve", async () => {
    // Insertion order and unicode survive `JSON.parse` -> `JSON.stringify` in V8,
    // so those make a weak example. WHITESPACE AND NUMBER FORMATTING DO NOT, and
    // both occur in the wild: senders pretty-print, and `4999.0` / `1e3` are
    // valid JSON that re-serialise to `4999` / `1000`. Any of these changes the
    // byte sequence and therefore the HMAC, which is why the middleware must be
    // byte-transparent rather than merely semantics-preserving.
    const payload = '{\n  "amount": 4999.0,\n  "count": 1e3\n}';
    const request = requestFrom([Buffer.from(payload, "utf8")]);

    await run(request);

    expect(request.rawBody?.toString("utf8")).toBe(payload);

    // Guard the premise: if the round trip were lossless, this would prove nothing.
    const roundTripped = JSON.stringify(JSON.parse(payload) as unknown);
    expect(roundTripped).not.toBe(payload);
    expect(roundTripped).toBe('{"amount":4999,"count":1000}');
  });

  it("reassembles a body split across multiple chunks", async () => {
    // A body large enough to arrive in several TCP segments is the normal case,
    // not an edge case. Concatenating in the wrong order or dropping a chunk
    // produces a signature failure indistinguishable from an attack.
    const request = requestFrom([
      Buffer.from('{"type":"order', "utf8"),
      Buffer.from('/paid","amount"', "utf8"),
      Buffer.from(":4999}", "utf8"),
    ]);

    await run(request);

    expect(request.rawBody?.toString("utf8")).toBe('{"type":"order/paid","amount":4999}');
  });

  it("handles an empty body without throwing", async () => {
    const request = requestFrom([]);

    const { error } = await run(request);

    expect(error).toBeNull();
    expect(request.rawBody?.length).toBe(0);
  });

  it("marks the request parsed so the downstream body-parser skips it", async () => {
    const request = requestFrom([Buffer.from("{}", "utf8")]);

    await run(request);

    // `body-parser` checks `req._body` first and skips a request someone else
    // already read. Without this flag it would wait on an exhausted stream until
    // the socket timed out — the webhook would hang, not 400.
    expect(request._body).toBe(true);
    expect(request.body).toEqual({});
  });

  it("rejects a body over the limit instead of buffering it", async () => {
    const request = requestFrom([Buffer.alloc(64, 0x61)]);

    const { error } = await run(request, { maxBytes: 32 });

    // The endpoint is public and unauthenticated — the signature cannot be
    // checked until the body has been read — so an unbounded reader here is a
    // memory-exhaustion primitive anyone on the internet can reach.
    expect(error).toBeInstanceOf(RawBodyTooLargeError);
    expect(request.rawBody).toBeUndefined();
  });

  it("refuses an over-limit body with 413, never a 500", async () => {
    // The error is handed to Express `next()`, which Nest rethrows through
    // AllExceptionsFilter. As a plain `Error` it classified as INTERNAL_ERROR, so the one
    // input an unauthenticated caller controls the size of answered 500 — our bug, for
    // their oversized request, on the single route whose contract reads a non-2xx as
    // "retry". An over-cap body is refused identically every time, so that 500 is a
    // permanent retry loop. The status has to travel ON the exception; the filter already
    // maps every HttpException correctly.
    const request = requestFrom([Buffer.alloc(64, 0x61)]);

    const { error } = await run(request, { maxBytes: 32 });

    expect(error).toBeInstanceOf(HttpException);

    // Narrowed, not cast: the status is the assertion, so reading it through an
    // unchecked assertion would let the test pass on an exception that has none.
    if (!(error instanceof HttpException)) {
      throw new Error("Expected the over-limit refusal to be an HttpException");
    }

    expect(error.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(error.getStatus()).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it("allows a body exactly at the limit", async () => {
    const request = requestFrom([Buffer.alloc(32, 0x61)]);

    const { error } = await run(request, { maxBytes: 32 });

    expect(error).toBeNull();
    expect(request.rawBody?.length).toBe(32);
  });

  it("calls next exactly once when the limit is exceeded mid-stream", async () => {
    const request = requestFrom([Buffer.alloc(40, 0x61), Buffer.alloc(40, 0x62)]);
    let calls = 0;

    await new Promise<void>((resolve) => {
      const next: NextFunction = () => {
        calls += 1;
        // Give any further stream events a turn to fire before asserting.
        setImmediate(resolve);
      };
      createRawBodyMiddleware({ maxBytes: 32 })(request, noopResponse(), next);
    });

    // A second `next()` after the response has been settled is an
    // ERR_HTTP_HEADERS_SENT crash in production, from a request an attacker
    // controls the size of.
    expect(calls).toBe(1);
  });

  it("forwards a stream error rather than hanging", async () => {
    const stream = new Readable({
      read(): void {
        this.destroy(new Error("connection reset"));
      },
    });
    const request = stream as unknown as Request & Carrier;

    const { error } = await run(request);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("connection reset");
  });

  it("passes through untouched when something upstream already read the body", async () => {
    const request = requestFrom([Buffer.from("{}", "utf8")]);
    request._body = true;

    const { error } = await run(request);

    expect(error).toBeNull();
    // Re-reading an exhausted stream yields an empty buffer, and a signature
    // computed over it fails in a way that looks like an attack rather than the
    // misconfiguration it is. Better to attach nothing.
    expect(request.rawBody).toBeUndefined();
  });
});
