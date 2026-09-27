import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLogger } from "@akai/observability";
import { translateRequestSchema, type TranslateRequest } from "@akai/contracts";

import {
  DEEPL_FREE_BASE_URL,
  DEEPL_PRO_BASE_URL,
  DeeplTranslationGateway,
  deeplBaseUrl,
} from "./deepl.gateway";

/**
 * A real (silent) logger, not a mock — pino's Logger type is large and building
 * a typed fake would need a cast; `createLogger` hands back a genuine one.
 */
const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "test" });

const REQUEST: TranslateRequest = translateRequestSchema.parse({
  source: "es",
  target: "en",
  texts: [
    { key: "name", text: "Camiseta oversize de algodón" },
    { key: "summary", text: "Algodón 100 %" },
    { key: "description", text: "Cada prenda se confecciona en algodón orgánico." },
  ],
});

function gateway(apiKey = "test-key", timeoutMs = 1_000): DeeplTranslationGateway {
  return new DeeplTranslationGateway({ apiKey, timeoutMs }, logger);
}

function deeplBody(texts: readonly string[]): string {
  return JSON.stringify({
    translations: texts.map((text) => ({ text, detected_source_language: "ES" })),
  });
}

// --- narrowing helpers: the captured fetch arguments are `unknown` ------------

function bodyOf(init: unknown): string {
  if (
    typeof init === "object" &&
    init !== null &&
    "body" in init &&
    typeof init.body === "string"
  ) {
    return init.body;
  }
  throw new Error("fetch was not called with a string body");
}

function signalOf(init: unknown): AbortSignal {
  if (
    typeof init === "object" &&
    init !== null &&
    "signal" in init &&
    init.signal instanceof AbortSignal
  ) {
    return init.signal;
  }
  throw new Error("fetch was not called with an abort signal");
}

function headerOf(init: unknown, name: string): string {
  if (typeof init === "object" && init !== null && "headers" in init) {
    const headers: unknown = init.headers;
    if (typeof headers === "object" && headers !== null && name in headers) {
      const value: unknown = Reflect.get(headers, name);
      if (typeof value === "string") {
        return value;
      }
    }
  }
  throw new Error(`fetch was not called with a ${name} header`);
}

const sentBodySchema = z.object({
  text: z.array(z.string()),
  source_lang: z.string(),
  target_lang: z.string(),
  preserve_formatting: z.boolean(),
});

function sentBody(init: unknown): z.infer<typeof sentBodySchema> {
  const raw: unknown = JSON.parse(bodyOf(init));
  return sentBodySchema.parse(raw);
}

describe("deeplBaseUrl", () => {
  it("routes a free key to the free host and everything else to the paid one", () => {
    // The ":fx" suffix is the ONLY signal, and it is why there is no second
    // environment variable for the host.
    expect(deeplBaseUrl("abc-123:fx")).toBe(DEEPL_FREE_BASE_URL);
    expect(deeplBaseUrl("abc-123")).toBe(DEEPL_PRO_BASE_URL);
    // A key pasted with a trailing newline is still a free key.
    expect(deeplBaseUrl("abc-123:fx\n")).toBe(DEEPL_FREE_BASE_URL);
  });
});

describe("DeeplTranslationGateway", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends one request for the whole batch and pairs the answers back by key", async () => {
    fetchMock.mockResolvedValue(
      new Response(deeplBody(["Oversized tee", "100 % cotton", "Every garment is made from organic cotton."])),
    );

    const outcome = await gateway().translate(REQUEST);

    // One round trip for three fields: the whole reason the contract is batched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      ok: true,
      translations: [
        { key: "name", text: "Oversized tee" },
        { key: "summary", text: "100 % cotton" },
        { key: "description", text: "Every garment is made from organic cotton." },
      ],
    });
  });

  it("sends the texts in request order with DeepL's own language codes", async () => {
    fetchMock.mockResolvedValue(new Response(deeplBody(["a", "b", "c"])));

    await gateway("paid-key").translate(REQUEST);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(String(call?.[0])).toBe(`${DEEPL_PRO_BASE_URL}/v2/translate`);
    expect(headerOf(call?.[1], "authorization")).toBe("DeepL-Auth-Key paid-key");

    const body = sentBody(call?.[1]);
    expect(body.text).toEqual([
      "Camiseta oversize de algodón",
      "Algodón 100 %",
      "Cada prenda se confecciona en algodón orgánico.",
    ]);
    expect(body.source_lang).toBe("ES");
    // A regional variant, because bare "EN" is deprecated as a TARGET.
    expect(body.target_lang).toBe("EN-GB");
    expect(body.preserve_formatting).toBe(true);
  });

  it("uses the free host when the key ends in :fx", async () => {
    fetchMock.mockResolvedValue(new Response(deeplBody(["a", "b", "c"])));

    await gateway("free-key:fx").translate(REQUEST);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${DEEPL_FREE_BASE_URL}/v2/translate`);
  });

  const STATUS_CASES = [
    { status: 429, reason: "RATE_LIMITED" },
    { status: 456, reason: "QUOTA_EXCEEDED" },
    { status: 403, reason: "INVALID_KEY" },
    { status: 401, reason: "INVALID_KEY" },
    { status: 400, reason: "UNSUPPORTED_LANGUAGE" },
    { status: 503, reason: "VENDOR_UNAVAILABLE" },
  ] as const;

  for (const { status, reason } of STATUS_CASES) {
    it(`maps HTTP ${String(status)} onto ${reason}`, async () => {
      fetchMock.mockResolvedValue(new Response("{}", { status }));

      await expect(gateway().translate(REQUEST)).resolves.toEqual({ ok: false, reason });
    });
  }

  it("never lets the vendor's own prose into the outcome", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Quota for this billing period has been exceeded, contact sales@deepl.com",
        }),
        { status: 456 },
      ),
    );

    const outcome = await gateway().translate(REQUEST);

    // A deep equality, not a property check: an extra field carrying vendor
    // text would fail here, which is the assertion that matters. The prose is
    // logged server-side and goes no further.
    expect(outcome).toEqual({ ok: false, reason: "QUOTA_EXCEEDED" });
    expect(JSON.stringify(outcome)).not.toMatch(/sales@deepl\.com/);
  });

  it("refuses a response with fewer translations than texts sent", async () => {
    // The failure this guards against is silent: pairing two answers to three
    // fields writes the summary's translation into the description.
    fetchMock.mockResolvedValue(new Response(deeplBody(["one", "two"])));

    await expect(gateway().translate(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "MALFORMED_RESPONSE",
    });
  });

  it("refuses a response with more translations than texts sent", async () => {
    fetchMock.mockResolvedValue(new Response(deeplBody(["one", "two", "three", "four"])));

    await expect(gateway().translate(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "MALFORMED_RESPONSE",
    });
  });

  it("refuses a body that is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>502 Bad Gateway</html>"));

    await expect(gateway().translate(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "MALFORMED_RESPONSE",
    });
  });

  it("refuses JSON that does not match the documented shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ translations: [{ txt: "wrong key" }] })),
    );

    await expect(gateway().translate(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "MALFORMED_RESPONSE",
    });
  });

  it("reports a timeout distinctly from an outage", async () => {
    fetchMock.mockImplementation(
      (_url: unknown, init: unknown) =>
        new Promise((_resolve, reject) => {
          signalOf(init).addEventListener("abort", () => {
            reject(new Error("The operation was aborted"));
          });
        }),
    );

    await expect(gateway("test-key", 5).translate(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "VENDOR_TIMEOUT",
    });
  });

  it("reports a transport failure as VENDOR_UNAVAILABLE", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(gateway().translate(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "VENDOR_UNAVAILABLE",
    });
  });
});
