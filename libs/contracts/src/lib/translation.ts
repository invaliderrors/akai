import { z } from "zod";
import { localeSchema } from "./common";
import type { TranslationFailureReason } from "./enums";

/**
 * Machine translation of product copy — the admin product form's ES <-> EN fill.
 *
 * WHY A BATCH SHAPE RATHER THAN ONE CALL PER FIELD. The vendor bills per
 * character and per request, and the form translates name, summary and
 * description together, from one button, as one action. Three round trips would
 * triple the per-request overhead, and — worse — make a partial result possible:
 * a name that translated and a description that did not is a state the operator
 * has to reconcile by hand, and nothing in the UI would say which half is stale.
 *
 * WHY EVERY BOUND LIVES IN THE SCHEMA. This body is the only thing standing
 * between a metered vendor account and an accidental loop in a form effect. An
 * unbounded array or an unbounded string is a billing incident that arrives as
 * an invoice rather than as an error, so the ceilings are part of the contract
 * both sides validate, not a check somebody remembered to write in a handler.
 */

/**
 * Longest single field, matching `productTranslationSchema.description` — the
 * largest thing the product form can possibly send.
 */
export const TRANSLATION_MAX_TEXT_LENGTH = 20_000;

/** name + summary + description is three. The ceiling leaves headroom without admitting a bulk job. */
export const TRANSLATION_MAX_TEXTS = 8;

/**
 * Ceiling on the whole batch, across every entry.
 *
 * The per-field cap alone is not a budget: eight fields at 20 000 characters is
 * 160 000 characters in ONE request. This is the number that actually bounds
 * what a single call can cost, and it still admits the real payload with room
 * to spare (200 + 500 + 20 000).
 */
export const TRANSLATION_MAX_TOTAL_CHARACTERS = 30_000;

/**
 * Names which field a text belongs to, and is echoed back untouched.
 *
 * An IDENTIFIER, not free text: it is a map key on both sides and it lands in
 * logs. Constraining it here keeps it from becoming a second, unvalidated
 * channel for prose alongside `text`.
 */
export const translationKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, "Translation key must be an identifier");

/** One field on the way OUT, to be translated. */
export const translationSourceSchema = z
  .object({
    key: translationKeySchema,
    /**
     * Trimmed and non-empty. An empty field has nothing to translate, and
     * admitting one means paying for a vendor round trip that returns `""`;
     * the caller drops empty fields rather than sending them.
     */
    text: z.string().trim().min(1).max(TRANSLATION_MAX_TEXT_LENGTH),
  })
  .strict();

export type TranslationSource = z.infer<typeof translationSourceSchema>;

/**
 * One field on the way BACK.
 *
 * Deliberately NOT `translationSourceSchema`. Its `min(1)` states what we are
 * willing to SEND; it is not a claim about what comes back. A source string
 * that is entirely punctuation or a bare unit can legitimately translate to an
 * empty string, and reusing the stricter schema would turn that into a contract
 * violation on our own response.
 */
export const translationResultSchema = z
  .object({
    key: translationKeySchema,
    text: z.string().max(TRANSLATION_MAX_TEXT_LENGTH),
  })
  .strict();

export type TranslationResult = z.infer<typeof translationResultSchema>;

/**
 * The translation request.
 *
 * `source` and `target` are the store's own locales, reusing `localeSchema`
 * rather than accepting an arbitrary language tag: the only translations this
 * platform has anywhere to PUT are the ones `productTranslationSchema` holds,
 * so a second language vocabulary would be a wider surface with no consumer.
 */
export const translateRequestSchema = z
  .object({
    source: localeSchema,
    target: localeSchema,
    texts: z.array(translationSourceSchema).min(1).max(TRANSLATION_MAX_TEXTS),
  })
  .strict()
  .superRefine((request, ctx) => {
    // A same-locale request is always a caller bug — a stale form field, or a
    // locale picker that did not update — and answering it by paying for a
    // round trip that returns the input would hide the bug behind a bill.
    if (request.source === request.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "source and target must differ; there is nothing to translate",
      });
    }

    // Duplicate keys make "which translation belongs to this field" unanswerable
    // on the way back: the response is keyed, so a caller building a map would
    // silently keep whichever entry it happened to read last.
    const seen = new Set<string>();
    for (const [index, entry] of request.texts.entries()) {
      if (seen.has(entry.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["texts", index, "key"],
          message: `Duplicate translation key: ${entry.key}`,
        });
      }
      seen.add(entry.key);
    }

    const total = request.texts.reduce((sum, entry) => sum + entry.text.length, 0);
    if (total > TRANSLATION_MAX_TOTAL_CHARACTERS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["texts"],
        message: `Batch exceeds ${String(TRANSLATION_MAX_TOTAL_CHARACTERS)} characters`,
      });
    }
  });

export type TranslateRequest = z.infer<typeof translateRequestSchema>;

/**
 * The translated fields, in the SAME ORDER as the request and under the SAME
 * KEYS. Order is preserved as well as keys because it costs nothing and it
 * makes a pairing bug visible in a diff rather than only in a mismatched field.
 */
export const translateResponseSchema = z
  .object({
    translations: z.array(translationResultSchema).min(1).max(TRANSLATION_MAX_TEXTS),
  })
  .strict();

export type TranslateResponse = z.infer<typeof translateResponseSchema>;

// ---------------------------------------------------------------------------
// The driven port.
// ---------------------------------------------------------------------------

export interface TranslationSuccess {
  readonly ok: true;
  readonly translations: readonly TranslationResult[];
}

/**
 * A failure carries a CLOSED reason and nothing else.
 *
 * This is the load-bearing part of the port. There is no field here for a
 * vendor message, so "never surface the vendor's own prose" is a property of
 * the type rather than a rule an implementer has to remember — a gateway that
 * wanted to leak DeepL's error text would have nowhere to put it. The vendor's
 * body is logged server-side, where it is useful, and stops there.
 */
export interface TranslationFailure {
  readonly ok: false;
  readonly reason: TranslationFailureReason;
}

export type TranslationOutcome = TranslationSuccess | TranslationFailure;

/**
 * THE translation port.
 *
 * Returns an outcome and NEVER throws for a vendor failure, unlike most ports
 * here. Every reason in the union is an expected, actionable state of a
 * third-party dependency — no key configured, quota gone, rate limited — not an
 * exceptional one, and the caller has to branch on all of them anyway to tell
 * the operator which happened. Exceptions would push that branch into a catch
 * block typed `unknown`, which is where the reason would get lost.
 */
export interface TranslationPort {
  translate(request: TranslateRequest): Promise<TranslationOutcome>;
}
