import type { TranslationOutcome, TranslationPort } from "@akai/contracts";

/**
 * The binding used when DEEPL_API_KEY is unset.
 *
 * THE FEATURE IS ABSENT, NOT BROKEN. Every call answers NOT_CONFIGURED, which
 * the controller turns into a typed 409 the dashboard branches on to hide or
 * disable its translate action. The three alternatives are all worse:
 *  - Failing at boot would make a convenience feature a deployment
 *    prerequisite, and would stop every contributor without a DeepL account
 *    from running the API at all.
 *  - Throwing at call time would produce a 500 — our-bug shaped, paging
 *    someone, and indistinguishable in a dashboard from the vendor being down.
 *  - Returning empty translations would silently write blank copy over a
 *    product's other locale, which is the only genuinely destructive option.
 */
export class UnconfiguredTranslationGateway implements TranslationPort {
  // The request is not read at all: there is nothing to translate WITH, so
  // inspecting it could only produce a more specific way to say the same no.
  translate(): Promise<TranslationOutcome> {
    return Promise.resolve({ ok: false, reason: "NOT_CONFIGURED" });
  }
}
