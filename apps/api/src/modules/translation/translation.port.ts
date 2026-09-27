import type { TranslationPort } from "@akai/contracts";

/**
 * Injection token for the TranslationPort.
 *
 * A token rather than a class because the binding is chosen at boot from
 * validated config — the DeepL gateway when a key is configured, the
 * unconfigured one when it is not — and a consumer must not be able to tell
 * which it got. `TranslationService` injects this and nothing else, so adding a
 * second vendor later is a factory change in one module.
 */
export const TRANSLATION_GATEWAY = Symbol("TRANSLATION_GATEWAY");

/** Re-exported so consumers in this module type against the port, not the adapter. */
export type { TranslationPort };
