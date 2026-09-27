import { z } from "zod";
import type { Logger } from "@akai/observability";
import type {
  Locale,
  TranslateRequest,
  TranslationFailureReason,
  TranslationOutcome,
  TranslationPort,
  TranslationResult,
} from "@akai/contracts";

/**
 * The real DeepL adapter.
 *
 * WHY DEEPL: it is an EU company, so product copy for an EU business stays in
 * the EU; it is best-in-class for ES <-> EN; and it is a TRANSLATION API rather
 * than a general LLM, so the product copy we send cannot act as a prompt
 * against it. That last property is why no prompt-injection defence appears in
 * this file — there is no prompt to inject into.
 *
 * WHAT THIS CLASS OWES THE REST OF THE SYSTEM:
 *  1. The vendor's JSON is EXTERNAL INPUT and is parsed through zod. A typed
 *     `await response.json() as DeeplResponse` would assert exactly the shape
 *     that a vendor change is about to break, and the failure would land as a
 *     `undefined is not an object` deep inside the pairing loop.
 *  2. Order and key association are re-established EXPLICITLY. DeepL returns a
 *     positional array with no echo of our keys, so pairing by index without
 *     checking the length is how a summary ends up written into a description.
 *  3. Nothing the vendor says escapes into the outcome. `TranslationOutcome`'s
 *     failure variant has no field for prose; the body is logged here, where an
 *     operator can read it, and goes no further.
 */

/** A FREE DeepL key ends in ":fx" and is only valid against the free host. */
const FREE_TIER_SUFFIX = ":fx";

export const DEEPL_FREE_BASE_URL = "https://api-free.deepl.com";
export const DEEPL_PRO_BASE_URL = "https://api.deepl.com";

/**
 * Derive the host from the key rather than from a second env var.
 *
 * DEEPL_BASE_URL as a companion variable could only ever disagree with the key,
 * and the symptom of that disagreement is a 403 that reads exactly like a
 * revoked credential — an operator would rotate a perfectly good key trying to
 * fix a wrong hostname. The key already carries the answer.
 */
export function deeplBaseUrl(apiKey: string): string {
  return apiKey.trim().endsWith(FREE_TIER_SUFFIX) ? DEEPL_FREE_BASE_URL : DEEPL_PRO_BASE_URL;
}

/**
 * DeepL's source and target language codes are NOT the same vocabulary.
 *
 * `target_lang` requires a regional English variant — bare "EN" is deprecated
 * as a target and DeepL picks a variant for you — while `source_lang` takes the
 * unqualified language. EN-GB rather than EN-US because the store is an EU
 * business writing for an EU audience.
 *
 * Both are total `Record<Locale, …>` maps, so adding a locale to the platform
 * is a compile error here rather than a runtime 400 from the vendor.
 */
const SOURCE_LANG: Readonly<Record<Locale, string>> = { es: "ES", en: "EN" };
const TARGET_LANG: Readonly<Record<Locale, string>> = { es: "ES", en: "EN-GB" };

/**
 * Only `translations[].text` is load-bearing; everything else DeepL sends
 * (`detected_source_language`, and whatever it adds next) is dropped.
 *
 * NOT `.strict()`, and that is the opposite of the rule for our own request
 * schemas for a good reason: strictness on an INBOUND vendor payload turns a
 * harmless additive change on their side into an outage on ours. We whitelist
 * the field we consume instead.
 */
const deeplResponseSchema = z.object({
  translations: z.array(z.object({ text: z.string() })),
});

/** Vendor prose is for OUR logs only; cap it so a stack trace cannot ride along. */
const VENDOR_LOG_PREVIEW_LENGTH = 300;

/**
 * A 20 000-character description is a real request that takes seconds. Too
 * short a timeout turns a translation we have already been billed for into a
 * failure the operator retries — paying twice for one result.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Narrow logger, as in EmailModule's `TransportLogger`: this class needs one
 * method, and depending on the full pino surface would force every test to
 * build or cast one.
 */
export type TranslationLogger = Pick<Logger, "warn">;

export interface DeeplGatewayOptions {
  readonly apiKey: string;
  readonly timeoutMs?: number;
}

/** JSON.parse over an unknown body, without letting its `any` return escape. */
function parseJson(raw: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const value: unknown = JSON.parse(raw);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Map a vendor status onto our closed reason vocabulary.
 *
 * Each branch is a DIFFERENT thing for an operator to do — top up the account,
 * rotate the key, wait, or page someone — which is exactly why these are
 * distinct reasons rather than one "translation failed".
 */
function reasonForStatus(status: number): TranslationFailureReason {
  if (status === 429) {
    return "RATE_LIMITED";
  }
  // 456 is DeepL's own code for "character quota exhausted". Distinct from 429:
  // waiting does not fix it, and only a human with a billing login can.
  if (status === 456) {
    return "QUOTA_EXCEEDED";
  }
  if (status === 401 || status === 403) {
    return "INVALID_KEY";
  }
  // The only caller-controlled parts of the body are the language pair and the
  // texts, and the texts are schema-bounded before they get here — so a 400 is
  // DeepL refusing the pair.
  if (status === 400) {
    return "UNSUPPORTED_LANGUAGE";
  }
  return "VENDOR_UNAVAILABLE";
}

async function vendorPreview(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, VENDOR_LOG_PREVIEW_LENGTH);
  } catch {
    return "";
  }
}

export class DeeplTranslationGateway implements TranslationPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: DeeplGatewayOptions, private readonly logger: TranslationLogger) {
    // Trimmed ONCE, and the trimmed value is what both the header and the host
    // derivation see. A key pasted with a trailing newline would otherwise
    // authenticate against the wrong host and fail as a bad credential.
    this.apiKey = options.apiKey.trim();
    this.baseUrl = deeplBaseUrl(this.apiKey);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async translate(request: TranslateRequest): Promise<TranslationOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/v2/translate`, {
        method: "POST",
        headers: {
          // DeepL's own scheme name. `Bearer` is silently rejected as 403.
          authorization: `DeepL-Auth-Key ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: request.texts.map((entry) => entry.text),
          source_lang: SOURCE_LANG[request.source],
          target_lang: TARGET_LANG[request.target],
          // Product copy carries deliberate line breaks and unit strings
          // ("70 cm", "100% cotton"); DeepL's default formatting correction moves
          // sentence-final punctuation around, which reads as corruption in a
          // spec table.
          preserve_formatting: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const reason = reasonForStatus(response.status);
        this.logger.warn(
          { status: response.status, reason, vendor: await vendorPreview(response) },
          "DeepL refused a translation request",
        );
        return { ok: false, reason };
      }

      // Read as TEXT, then parse. `response.json()` collapses "the connection
      // dropped mid-body" and "the body is not JSON" into one rejection, and
      // those are VENDOR_UNAVAILABLE and MALFORMED_RESPONSE respectively.
      return this.pair(request, await response.text());
    } catch (cause) {
      const reason: TranslationFailureReason = controller.signal.aborted
        ? "VENDOR_TIMEOUT"
        : "VENDOR_UNAVAILABLE";
      this.logger.warn(
        { err: cause instanceof Error ? cause.message : String(cause), reason },
        "DeepL translation request failed",
      );
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Re-attach our keys to DeepL's positional array.
   *
   * The length check is the whole point. DeepL guarantees one translation per
   * input text, so a mismatch means we are talking to something that is not the
   * API we think it is — and pairing anyway would write field N's translation
   * into field N's neighbour with no error anywhere.
   */
  private pair(request: TranslateRequest, raw: string): TranslationOutcome {
    const json = parseJson(raw);
    if (!json.ok) {
      this.logger.warn(
        { reason: "MALFORMED_RESPONSE", preview: raw.slice(0, VENDOR_LOG_PREVIEW_LENGTH) },
        "DeepL returned a body that is not JSON",
      );
      return { ok: false, reason: "MALFORMED_RESPONSE" };
    }

    const parsed = deeplResponseSchema.safeParse(json.value);
    if (!parsed.success) {
      this.logger.warn(
        { reason: "MALFORMED_RESPONSE" },
        "DeepL returned JSON that does not match the documented shape",
      );
      return { ok: false, reason: "MALFORMED_RESPONSE" };
    }

    const translated = parsed.data.translations;
    if (translated.length !== request.texts.length) {
      this.logger.warn(
        { sent: request.texts.length, received: translated.length },
        "DeepL returned a different number of translations than were sent",
      );
      return { ok: false, reason: "MALFORMED_RESPONSE" };
    }

    const results: TranslationResult[] = [];
    for (const [index, source] of request.texts.entries()) {
      const translation = translated[index];
      // Unreachable after the length check — but an indexed read is still
      // `T | undefined`, and the alternative spelling is the non-null assertion
      // that would hide a genuine off-by-one here forever.
      if (translation === undefined) {
        return { ok: false, reason: "MALFORMED_RESPONSE" };
      }
      results.push({ key: source.key, text: translation.text });
    }

    return { ok: true, translations: results };
  }
}
