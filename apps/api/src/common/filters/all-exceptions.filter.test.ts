import "reflect-metadata";
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { discountFailureReasonSchema, errorEnvelopeSchema } from "@akai/contracts";
import { RecordNotFoundError } from "@akai/db";
import type { Logger } from "@akai/observability";
import { RawBodyTooLargeError } from "../middleware/raw-body";
import { AllExceptionsFilter } from "./all-exceptions.filter";

interface CapturedResponse {
  status: number;
  body: unknown;
}

/** Minimal ArgumentsHost double exposing just what the filter reads. */
function makeHost(): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined };

  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  };

  const request = { method: "GET", url: "/v1/orders/1" };

  const host = {
    switchToHttp: () => ({
      getResponse: <T>(): T => response as T,
      getRequest: <T>(): T => request as T,
    }),
  } as ArgumentsHost;

  return { host, captured };
}

function makeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function run(exception: unknown, isProduction = false): CapturedResponse {
  const { host, captured } = makeHost();
  new AllExceptionsFilter(makeLogger(), isProduction).catch(exception, host);
  return captured;
}

describe("AllExceptionsFilter", () => {
  it("always emits the contract error envelope, whatever was thrown", () => {
    for (const exception of [
      new Error("boom"),
      new NotFoundException("nope"),
      new RecordNotFoundError("Order"),
      "a bare string",
      42,
    ]) {
      const { body } = run(exception);
      // The envelope is the contract. If this ever fails, some client is
      // parsing a shape that no longer exists.
      expect(errorEnvelopeSchema.safeParse(body).success).toBe(true);
    }
  });

  it("maps a ZodError to 400 with per-field detail", () => {
    const schema = z.object({ email: z.string().email(), age: z.number() });
    const result = schema.safeParse({ email: "not-an-email", age: "x" });
    expect(result.success).toBe(false);
    if (result.success) return;

    const { status, body } = run(result.error);
    expect(status).toBe(400);

    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe("VALIDATION_FAILED");
    expect(parsed.error.fields?.map((field) => field.path)).toEqual(
      expect.arrayContaining(["email", "age"]),
    );
  });

  it("maps RecordNotFoundError to 404 — never 403, which would confirm existence", () => {
    const { status, body } = run(new RecordNotFoundError("Order"));
    const parsed = errorEnvelopeSchema.parse(body);

    expect(status).toBe(404);
    expect(parsed.error.code).toBe("NOT_FOUND");
    // A 403 here would let an attacker enumerate other customers' order ids.
    expect(status).not.toBe(403);
  });

  it("preserves the status and code of an intentional HttpException", () => {
    expect(run(new ForbiddenException()).status).toBe(403);
    expect(
      errorEnvelopeSchema.parse(run(new ForbiddenException()).body).error.code,
    ).toBe("FORBIDDEN");

    expect(run(new BadRequestException("bad")).status).toBe(400);
    expect(run(new HttpException("conflict", HttpStatus.CONFLICT)).status).toBe(409);
  });

  /**
   * The distinguishing case.
   *
   * Three different 409s must not collapse into one client-visible code. A cart
   * has to tell "someone took the last unit" (retry with less) apart from an
   * illegal state transition (do not retry at all), and both from a plain
   * uniqueness conflict — they drive different UI, so the code has to survive
   * the trip through the filter.
   */
  it("prefers a domain code carried on the exception over the status-derived one", () => {
    const outOfStock = new HttpException(
      { code: "OUT_OF_STOCK", message: "Only 2 left" },
      HttpStatus.CONFLICT,
    );
    const illegalTransition = new HttpException(
      { code: "ILLEGAL_STATE_TRANSITION", message: "Cannot ship a cancelled order" },
      HttpStatus.CONFLICT,
    );

    const first = errorEnvelopeSchema.parse(run(outOfStock).body);
    const second = errorEnvelopeSchema.parse(run(illegalTransition).body);

    expect(first.error.code).toBe("OUT_OF_STOCK");
    expect(first.error.message).toBe("Only 2 left");
    expect(second.error.code).toBe("ILLEGAL_STATE_TRANSITION");
    // Same status, different codes — which is the whole point.
    expect(run(outOfStock).status).toBe(409);
    expect(run(illegalTransition).status).toBe(409);
  });

  /**
   * The SECOND distinguishing case, one level down.
   *
   * `code` separates failures that share a status; `reason` separates failures
   * that share a CODE. Every discount refusal is a VALIDATION_FAILED, so
   * without this a shopper who is EUR 10 short of the minimum and a shopper
   * holding a code that expired last year get byte-identical responses — and
   * the only sentence the storefront can honestly show for both is "that did
   * not work".
   */
  it("carries a domain reason from the exception payload into the envelope", () => {
    // The shape DiscountError.belowMinimum() throws (discounts.errors.ts).
    const belowMinimum = new HttpException(
      {
        code: "VALIDATION_FAILED",
        reason: "BELOW_MINIMUM",
        message: "Your basket does not meet the minimum for that discount code.",
      },
      HttpStatus.BAD_REQUEST,
    );

    const parsed = errorEnvelopeSchema.parse(run(belowMinimum).body);

    expect(parsed.error.code).toBe("VALIDATION_FAILED");
    expect(parsed.error.reason).toBe("BELOW_MINIMUM");
    // It survives as a member of the CLOSED domain enum, which is the only
    // form a client is allowed to act on — never as rendered text.
    expect(discountFailureReasonSchema.safeParse(parsed.error.reason).success).toBe(true);
  });

  /**
   * A stock refusal can name the variant that ran short and what is left, so a
   * pack add can tell the shopper WHICH component is the problem. Parsed
   * against `stockShortageSchema`, never passed through blind.
   */
  it("carries a well-formed stock shortage from the exception payload", () => {
    const shortage = { variantId: "20000000-0000-4000-8000-000000000002", availableQuantity: 3 };
    const parsed = errorEnvelopeSchema.parse(
      run(
        new HttpException(
          { code: "OUT_OF_STOCK", message: "RETA: only 3 units are available", shortage },
          HttpStatus.CONFLICT,
        ),
      ).body,
    );

    expect(parsed.error.code).toBe("OUT_OF_STOCK");
    expect(parsed.error.shortage).toEqual(shortage);
  });

  it("drops a malformed shortage and keeps the rest of the envelope", () => {
    const parsed = errorEnvelopeSchema.parse(
      run(
        new HttpException(
          { code: "OUT_OF_STOCK", message: "nope", shortage: { variantId: "not-a-uuid", availableQuantity: 3 } },
          HttpStatus.CONFLICT,
        ),
      ).body,
    );

    expect(parsed.error).not.toHaveProperty("shortage");
    expect(parsed.error.code).toBe("OUT_OF_STOCK");
  });

  it("omits reason entirely when the payload carries none", () => {
    const parsed = errorEnvelopeSchema.parse(
      run(new HttpException({ code: "CONFLICT", message: "nope" }, HttpStatus.CONFLICT))
        .body,
    );
    // Absent, not null and not "": every pre-existing envelope must parse
    // exactly as it did before this field existed.
    expect(parsed.error.reason).toBeUndefined();
    expect(parsed.error).not.toHaveProperty("reason");
  });

  /**
   * A non-string reason is dropped rather than coerced. The client parses this
   * against a closed enum, and `"[object Object]"` would fail that parse
   * looking like contract drift instead of like the bad thrower it is.
   */
  it("drops a reason that is not a string", () => {
    const bogus = new HttpException(
      { code: "VALIDATION_FAILED", reason: { nested: true }, message: "nope" },
      HttpStatus.BAD_REQUEST,
    );

    const { body } = run(bogus);
    const parsed = errorEnvelopeSchema.parse(body);

    expect(parsed.error).not.toHaveProperty("reason");
    // The rest of the envelope is untouched — one bad field must not cost the
    // client the code it actually branches on.
    expect(parsed.error.code).toBe("VALIDATION_FAILED");
  });

  /**
   * The envelope schema caps `reason` at 64 characters. An over-long value must
   * be dropped HERE, because a body this filter emits that fails the client's
   * `.strict()` parse loses the code, the requestId and the fields as well —
   * degrading a precise error into "this did not come from our API at all".
   */
  it("drops an over-long reason rather than emitting an unparseable envelope", () => {
    const oversized = new HttpException(
      { code: "VALIDATION_FAILED", reason: "X".repeat(65), message: "nope" },
      HttpStatus.BAD_REQUEST,
    );

    const { body } = run(oversized);

    expect(errorEnvelopeSchema.safeParse(body).success).toBe(true);
    expect(errorEnvelopeSchema.parse(body).error).not.toHaveProperty("reason");
  });

  it("falls back to the status-derived code when no domain code is attached", () => {
    const plain = new HttpException("conflict", HttpStatus.CONFLICT);
    expect(errorEnvelopeSchema.parse(run(plain).body).error.code).toBe("CONFLICT");
  });

  /**
   * An unrecognised code must not reach the client. The error envelope is a
   * published contract; a typo'd or attacker-influenced string appearing in it
   * would be a code no client has been told how to handle.
   */
  it("ignores a code that is not in the published enum", () => {
    const bogus = new HttpException(
      { code: "TOTALLY_MADE_UP", message: "nope" },
      HttpStatus.CONFLICT,
    );
    expect(errorEnvelopeSchema.parse(run(bogus).body).error.code).toBe("CONFLICT");
  });

  it("flattens a ValidationPipe message array into fields", () => {
    const exception = new BadRequestException({
      message: ["email must be an email", "age must be a number"],
      error: "Bad Request",
      statusCode: 400,
    });

    const parsed = errorEnvelopeSchema.parse(run(exception).body);
    expect(parsed.error.fields).toHaveLength(2);
    expect(parsed.error.message).toBe("Request validation failed");
  });

  it("HIDES internal detail in production", () => {
    // An unexpected exception's message routinely contains a connection string,
    // a file path or a SQL fragment. None of that belongs in a response.
    const leaky = new Error(
      "connect ECONNREFUSED postgresql://akai:hunter2@10.0.0.5:5432/akai",
    );

    const parsed = errorEnvelopeSchema.parse(run(leaky, true).body);
    expect(parsed.error.message).toBe("An unexpected error occurred");
    expect(parsed.error.message).not.toContain("hunter2");
    expect(parsed.error.message).not.toContain("10.0.0.5");
  });

  it("SHOWS the detail in development, where it is the whole point", () => {
    const parsed = errorEnvelopeSchema.parse(run(new Error("boom"), false).body);
    expect(parsed.error.message).toBe("boom");
  });

  /**
   * The webhook raw-body cap, end to end.
   *
   * The middleware hands `RawBodyTooLargeError` to Express `next()`; Nest's registered
   * error handler rethrows it here. While it extended plain `Error` it fell to the
   * catch-all below and answered 500 — our bug, reported for a caller's oversized
   * request, on the ONE route whose contract treats a non-2xx as a retry instruction. An
   * over-cap body is refused identically on every attempt, so that 500 was a permanent
   * retry loop reachable by anyone on the internet. This is the assertion that the
   * refusal is a 413 and stays one.
   */
  it("maps an over-sized raw webhook body to 413, not 500", () => {
    const { status, body } = run(new RawBodyTooLargeError(1_048_576));
    const parsed = errorEnvelopeSchema.parse(body);

    expect(status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(status).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    // No `PAYLOAD_TOO_LARGE` member is added to the published code enum for this: the
    // enum is a client contract and nothing branches on it. The 4xx fallback is correct.
    expect(parsed.error.code).toBe("VALIDATION_FAILED");
    expect(parsed.error.message).toContain("1048576");
  });

  it("returns 500 with INTERNAL_ERROR for an unknown throwable", () => {
    const { status, body } = run({ weird: true });
    expect(status).toBe(500);
    expect(errorEnvelopeSchema.parse(body).error.code).toBe("INTERNAL_ERROR");
  });

  it('includes a requestId — "system" outside a request context', () => {
    const parsed = errorEnvelopeSchema.parse(run(new Error("boom")).body);
    expect(parsed.error.requestId).toBe("system");
  });

  it("logs 5xx at error and 4xx at warn, so alerting is not drowned in 404s", () => {
    const logger = makeLogger();

    const serverError = makeHost();
    new AllExceptionsFilter(logger, false).catch(new Error("boom"), serverError.host);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();

    const clientError = makeHost();
    new AllExceptionsFilter(logger, false).catch(
      new NotFoundException(),
      clientError.host,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
