import { createLogger } from "@akai/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TurnstileCaptchaVerifier } from "./turnstile-captcha.verifier";

/**
 * A real (silent) logger, not a mock — pino's Logger type is large and building
 * a typed fake would need a cast; `createLogger` hands back a genuine one.
 */
const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "test" });

function verifier(): TurnstileCaptchaVerifier {
  return new TurnstileCaptchaVerifier({ secretKey: "test-secret", timeoutMs: 1_000 }, logger);
}

/** The opt-in availability trade, for the one call site that ever wants it. */
function failOpenVerifier(): TurnstileCaptchaVerifier {
  return new TurnstileCaptchaVerifier(
    { secretKey: "test-secret", timeoutMs: 1_000, failOpen: true },
    logger,
  );
}

function siteverify(success: boolean, status = 200): Response {
  return new Response(JSON.stringify({ success }), { status });
}

/** Narrow a captured fetch init down to its URLSearchParams body, no cast. */
function bodyOf(init: unknown): URLSearchParams {
  if (
    typeof init === "object" &&
    init !== null &&
    "body" in init &&
    init.body instanceof URLSearchParams
  ) {
    return init.body;
  }
  throw new Error("fetch was not called with a URLSearchParams body");
}

describe("TurnstileCaptchaVerifier", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a token Cloudflare confirms, sending the secret and response", async () => {
    fetchMock.mockResolvedValue(siteverify(true));

    await expect(verifier().verify("good-token", null)).resolves.toBe(true);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const url: unknown = call?.[0];
    expect(String(url)).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    const body = bodyOf(call?.[1]);
    expect(body.get("secret")).toBe("test-secret");
    expect(body.get("response")).toBe("good-token");
    expect(body.get("remoteip")).toBeNull();
  });

  it("rejects a token Cloudflare says is invalid", async () => {
    fetchMock.mockResolvedValue(siteverify(false));
    await expect(verifier().verify("forged-token", null)).resolves.toBe(false);
  });

  it("forwards the caller IP when one is supplied", async () => {
    fetchMock.mockResolvedValue(siteverify(true));
    await verifier().verify("good-token", "203.0.113.7");
    const body = bodyOf(fetchMock.mock.calls[0]?.[1]);
    expect(body.get("remoteip")).toBe("203.0.113.7");
  });

  it("short-circuits an empty token without calling Cloudflare", async () => {
    await expect(verifier().verify("   ", null)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * THE FAILURE POLICY, REVERSED — and the reasoning is one specific fact.
   *
   * The old default admitted the request whenever siteverify was unreachable,
   * on the argument that captcha is abuse mitigation and must not couple
   * registration to Cloudflare's uptime. That argument does not survive contact
   * with the URLs involved: the widget script the browser loads is
   * `https://challenges.cloudflare.com/turnstile/v0/api.js` and siteverify is
   * `https://challenges.cloudflare.com/turnstile/v0/siteverify` — THE SAME HOST.
   * When that host is down, a legitimate customer cannot obtain a token in the
   * first place, so failing open buys them nothing. The only party still able to
   * submit is the one sending an arbitrary string, who never loaded the widget.
   * Fail-open therefore inverts precisely when it matters: it admits nobody but
   * the attacker, and it does so on the endpoint that mails an address of that
   * attacker's choosing.
   *
   * A one-sided outage (our egress broken, the customer's browser fine) is the
   * case fail-open genuinely serves, and `failOpen: true` keeps it reachable —
   * an explicit availability trade a call site opts into, not the default that
   * every call site silently inherits.
   */
  it("fails CLOSED on a transport error by default", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(verifier().verify("good-token", null)).resolves.toBe(false);
  });

  it("fails CLOSED on a non-2xx siteverify response by default", async () => {
    fetchMock.mockResolvedValue(siteverify(false, 503));
    await expect(verifier().verify("good-token", null)).resolves.toBe(false);
  });

  it("fails CLOSED when the siteverify body is not the expected shape", async () => {
    // An unreadable verdict is not a verdict. Reading it as "human" is the same
    // mistake the Whop webhook rule forbids: a total we cannot read exactly is a
    // total we must not agree with.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await expect(verifier().verify("good-token", null)).resolves.toBe(false);
  });

  it("fails OPEN on a transport error only when explicitly told to", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(failOpenVerifier().verify("good-token", null)).resolves.toBe(true);

    fetchMock.mockResolvedValue(siteverify(false, 503));
    await expect(failOpenVerifier().verify("good-token", null)).resolves.toBe(true);
  });

  it("still honours an explicit Cloudflare rejection when failing open", async () => {
    // The escape hatch is about REACHABILITY, never about a verdict. A verified
    // `success:false` is the abuse traffic the control exists to stop, and no
    // option may admit it.
    fetchMock.mockResolvedValue(siteverify(false));
    await expect(failOpenVerifier().verify("forged-token", null)).resolves.toBe(false);
  });
});
