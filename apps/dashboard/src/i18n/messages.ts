import { z } from "zod";
import es from "../../messages/es.json";

/**
 * The dashboard's message catalogue — Spanish, the shop's only language —
 * loaded STATICALLY and checked twice.
 *
 * Same defect, same fix as `apps/storefront/src/i18n/messages.ts`. In short:
 * `request.ts` used to end with
 * `` (await import(`../../messages/${locale}.json`)).default ``, a specifier
 * TypeScript cannot resolve, so the entire user-facing string catalogue entered
 * the app as `any` and was handed to next-intl unvalidated.
 *
 * next-intl stays as the catalogue's reader (`t()`, ICU plurals and
 * interpolation); there is no locale routing.
 */

/** One node of a message tree: a string, a list of nodes, or a nested namespace. */
export type MessageNode = string | readonly MessageNode[] | { readonly [key: string]: MessageNode };

/**
 * Structural validation of a message tree. The annotation is required (`z.lazy`
 * cannot infer its own recursion) and the input parameter is `unknown` because
 * that is what a JSON blob is until this schema has run.
 */
const messageNodeSchema: z.ZodType<MessageNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([z.string(), z.array(messageNodeSchema), z.record(messageNodeSchema)]),
);

/** A whole catalogue: a namespace map whose leaves are message nodes. */
export const messageCatalogSchema = z.record(messageNodeSchema);

/** The catalogue's static shape. */
export type MessageCatalog = typeof es;

/**
 * The compiler cannot see the READ side: `t()` keys are plain strings (there
 * is no `IntlMessages` augmentation in this app), so a namespace retired from
 * the catalogue while a page still reads it is neither a type error nor a
 * failing render — next-intl prints the key path. `messages.test.ts` scans the
 * source for namespace and key literals and resolves each against this
 * catalogue, which is what makes a retirement commit safe to write.
 */

/**
 * Expand union failures down to the leaf that actually failed — a `z.union`
 * reports at the point it was tried, so `{"cart":{"total":42}}` yields `cart`
 * and the useful `cart.total` is nested inside `unionErrors`.
 */
function flattenIssues(issues: readonly z.ZodIssue[]): z.ZodIssue[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_union"
      ? flattenIssues(issue.unionErrors.flatMap((error) => error.issues))
      : [issue],
  );
}

/** Thrown when the catalogue in the bundle is not a message tree. */
export class MessageCatalogError extends Error {
  constructor(issues: readonly z.ZodIssue[]) {
    const seen = new Set<string>();
    const detail = flattenIssues(issues)
      .sort((a, b) => b.path.length - a.path.length)
      .map((issue) => issue.path.join(".") || "<root>")
      .filter((path) => (seen.has(path) ? false : seen.add(path) !== undefined))
      .slice(0, 5)
      .join(", ");

    super(`Message catalog is malformed at: ${detail}`);
    this.name = "MessageCatalogError";
  }
}

/**
 * The validated catalogue.
 *
 * The parse is a GATE, not a transform: on success the statically-typed import
 * is handed on, because `messageCatalogSchema`'s output is the widened
 * `Record<string, MessageNode>` and returning that would discard the precise
 * key type callers get from `MessageCatalog`.
 */
export function loadMessages(): MessageCatalog {
  const parsed = messageCatalogSchema.safeParse(es);
  if (!parsed.success) {
    throw new MessageCatalogError(parsed.error.issues);
  }
  return es;
}
