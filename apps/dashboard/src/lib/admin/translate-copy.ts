import { z } from "zod";
import {
  localeSchema,
  translationFailureReasonSchema,
  type TranslationFailureReason,
  type TranslationResult,
  type TranslationSource,
} from "@akai/contracts";

/**
 * The seam between the product form's three copy fields and the API's keyed
 * translation batch.
 *
 * PURE, AND SEPARATE FROM THE ACTION THAT USES IT. `actions.ts` is
 * `"use server"`, so everything in it is an HTTP endpoint and nothing in it can
 * be unit-tested without standing up a request context. The two mappings below
 * are where the interesting decisions live — which fields are worth sending and
 * what comes back for the ones that were not — so they live here, where a test
 * calls them directly.
 *
 * WHY A MAPPING EXISTS AT ALL. The form edits `{ name, shortDescription,
 * description }`; the contract takes `{ key, text }[]` with `text` trimmed and
 * NON-EMPTY (`translationSourceSchema`). A product with a name and no
 * description is the ordinary state of a half-written draft, so sending the
 * blank field verbatim would fail request validation and refuse to translate the
 * two fields that do have text. The blanks are dropped on the way out and
 * restored as `""` on the way back.
 */

/**
 * The three fields, named once.
 *
 * These strings are the wire keys AND the draft's property names, deliberately:
 * one vocabulary means the pairing on the way back is a lookup rather than a
 * translation table nobody remembers to update. They satisfy the contract's
 * identifier rule (`/^[a-zA-Z][a-zA-Z0-9_.-]*$/`).
 */
export const COPY_FIELDS = ["name", "shortDescription", "description"] as const;

export type CopyField = (typeof COPY_FIELDS)[number];

/** One locale's product copy, exactly as the form holds it. */
export const productCopySchema = z
  .object({
    name: z.string(),
    shortDescription: z.string(),
    description: z.string(),
  })
  .strict();

export type ProductCopy = z.infer<typeof productCopySchema>;

/**
 * What the translate action accepts.
 *
 * `.strict()` because this is a REQUEST shape reaching a server action — a
 * public HTTP endpoint with a generated name, callable by anyone who can read
 * the page bundle. An unknown key here is either a client that has drifted or
 * somebody probing, and both are better answered with a 400 than with a
 * silently-ignored field.
 *
 * The lengths are NOT capped here. `translateRequestSchema` owns every ceiling
 * that protects the metered vendor (per text, per batch, per request) and the
 * action parses against it before sending; a second set of numbers in this file
 * could only ever disagree with those.
 */
export const translateCopyInputSchema = z
  .object({
    /** The locale the copy is written in — the one NOT on screen. */
    from: localeSchema,
    /** The locale being filled in — the one the operator is looking at. */
    to: localeSchema,
    copy: productCopySchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    // Same-locale is always a caller bug, and the contract rejects it too. It
    // is caught here as well so the round trip is never spent finding out.
    if (input.from === input.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "source and target must differ",
      });
    }
  });

export type TranslateCopyInput = z.infer<typeof translateCopyInputSchema>;

/**
 * The batch to send, with every blank field left out.
 *
 * Returns an EMPTY array when nothing has text, and the caller is expected to
 * stop there rather than pass it on: `translateRequestSchema` requires at least
 * one entry, so an empty batch is a 400 — but more to the point, asking a
 * metered vendor to translate nothing is a request that can only be answered
 * with nothing.
 */
export function toTranslationTexts(copy: ProductCopy): TranslationSource[] {
  return COPY_FIELDS.flatMap((key) => {
    const text = copy[key].trim();
    return text === "" ? [] : [{ key, text }];
  });
}

/**
 * Re-attach the translated texts to the three fields.
 *
 * Starts from blanks and fills what came back, so a field that was dropped on
 * the way out arrives as `""` — which is what it was. The alternative, echoing
 * the SOURCE text for a field that was not translated, would put Spanish prose
 * in an English box and mark it as translated.
 *
 * An unrecognised key is ignored rather than rejected: the response has already
 * been parsed against the contract, and a newer API answering with a fourth
 * field is not a reason to throw away three good translations.
 */
export function mergeTranslations(results: readonly TranslationResult[]): ProductCopy {
  const byKey = new Map(results.map((result) => [result.key, result.text]));

  return {
    name: byKey.get("name") ?? "",
    shortDescription: byKey.get("shortDescription") ?? "",
    description: byKey.get("description") ?? "",
  };
}

/**
 * Every reason this action can fail for, as one closed vocabulary.
 *
 * `EMPTY_SOURCE` is the dashboard's OWN addition and never comes off the wire:
 * it is what the action answers when there is nothing to translate, decided
 * before any request is made. Folding it into the same union means the caller
 * branches once, over a set the compiler can prove is total, instead of
 * branching on a vendor reason and then handling one local case beside it.
 */
export const translateCopyReasonSchema = z.union([
  translationFailureReasonSchema,
  z.literal("EMPTY_SOURCE"),
]);

export type TranslateCopyReason = TranslationFailureReason | "EMPTY_SOURCE";

/**
 * Narrow an envelope's `reason` to something the caller can render a sentence
 * for, or `null` when it cannot.
 *
 * `null` is a REAL outcome, not a failure of this function: the envelope's
 * `reason` is `z.string().max(64)` precisely so the API can add one without a
 * lockstep dashboard deploy, and an unrecognised value must fall back to the
 * coarse `code` rather than crash or, worse, be printed.
 */
export function translateCopyReasonOf(reason: string | null): TranslateCopyReason | null {
  const parsed = translateCopyReasonSchema.safeParse(reason);
  return parsed.success ? parsed.data : null;
}
