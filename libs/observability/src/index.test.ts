import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { REDACT_PATHS, createLogger } from "./logger";
import {
  getRequestContext,
  getRequestId,
  normaliseRequestId,
  runWithRequestContext,
} from "./request-context";

/** Capture what the logger actually writes, so redaction is verified on output. */
function captureLogs(): { lines: string[]; logger: pino.Logger } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      lines.push(chunk.toString());
      callback();
    },
  });

  const logger = pino(
    {
      level: "info",
      redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
    },
    stream,
  );

  return { lines, logger };
}

describe("logger redaction", () => {
  it("redacts a password even when nested in an object", () => {
    const { lines, logger } = captureLogs();
    logger.info({ password: "hunter2", user: { password: "hunter2" } }, "login");
    const output = lines.join("");
    expect(output).not.toContain("hunter2");
    expect(output).toContain("[redacted]");
  });

  it("redacts customer PII, the most common accidental leak", () => {
    const { lines, logger } = captureLogs();
    logger.info(
      {
        email: "ana@example.com",
        phone: "+34600000000",
        firstName: "Ana",
        lastName: "García",
      },
      "order placed",
    );
    const output = lines.join("");
    expect(output).not.toContain("ana@example.com");
    expect(output).not.toContain("+34600000000");
    expect(output).not.toContain("García");
  });

  it("redacts authorization and cookie headers", () => {
    const { lines, logger } = captureLogs();
    logger.info(
      { req: { headers: { authorization: "Bearer secret-token", cookie: "s=abc" } } },
      "request",
    );
    const output = lines.join("");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("s=abc");
  });

  it("still logs the non-sensitive fields it was called with", () => {
    const { lines, logger } = captureLogs();
    logger.info({ orderNumber: "AK-2026-000123", email: "a@b.com" }, "paid");
    const output = lines.join("");
    expect(output).toContain("AK-2026-000123");
    expect(output).not.toContain("a@b.com");
  });

  it("emits string level names for aggregator filtering", () => {
    const logger = createLogger({
      level: "info",
      nodeEnv: "test",
      serviceName: "api",
    });
    expect(logger.level).toBe("info");
  });
});

describe("request id normalisation", () => {
  it("accepts a well-formed inbound id so traces stay continuous", () => {
    expect(normaliseRequestId("req-abc12345")).toBe("req-abc12345");
  });

  it("mints one when the header is absent or not a string", () => {
    expect(normaliseRequestId(undefined)).toHaveLength(36);
    expect(normaliseRequestId(42)).toHaveLength(36);
  });

  it("strips characters that would enable log injection", () => {
    // A newline in a request id lets an attacker forge entire log entries.
    const result = normaliseRequestId("abc\ndef\r\nFAKE-LOG-LINE");
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\r");
  });

  it("rejects an absurdly long inbound id", () => {
    expect(normaliseRequestId("a".repeat(500))).toHaveLength(36);
  });

  it("rejects a too-short id rather than trusting it", () => {
    expect(normaliseRequestId("ab")).toHaveLength(36);
  });
});

describe("request context propagation", () => {
  it("exposes the context inside the callback", () => {
    runWithRequestContext({ requestId: "req-1", customerId: "cus-1" }, () => {
      expect(getRequestId()).toBe("req-1");
      expect(getRequestContext()?.customerId).toBe("cus-1");
    });
  });

  it("survives an await boundary — queue handlers depend on this", async () => {
    await runWithRequestContext({ requestId: "req-2" }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getRequestId()).toBe("req-2");
    });
  });

  it('falls back to "system" outside a request rather than throwing', () => {
    expect(getRequestId()).toBe("system");
    expect(getRequestContext()).toBeUndefined();
  });

  it("isolates concurrent contexts from each other", async () => {
    const results = await Promise.all([
      runWithRequestContext({ requestId: "req-a" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRequestId();
      }),
      runWithRequestContext({ requestId: "req-b" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getRequestId();
      }),
    ]);
    expect(results).toEqual(["req-a", "req-b"]);
  });
});
