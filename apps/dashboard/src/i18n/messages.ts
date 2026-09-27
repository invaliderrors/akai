import { z } from "zod";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import { routing } from "./routing";

/**
 * The dashboard's message catalogs, loaded STATICALLY and checked twice.
 *
 * Same defect, same fix as `apps/storefront/src/i18n/messages.ts` — read that
 * file for the full reasoning. In short: `request.ts` used to end with
 * `` (await import(`../../messages/${locale}.json`)).default ``, a specifier
 * TypeScript cannot resolve, so the entire user-facing string catalog entered
 * the app as `any` and was handed to next-intl unvalidated.
 *
 * The two catalogs are duplicated between the apps rather than shared because
 * they are different vocabularies (a shop and an account area), and `@/*` is
 * app-local by design. The MECHANISM is duplicated with them.
 */

/** A locale this app routes, taken from the routing config so the two agree. */
type DashboardLocale = (typeof routing.locales)[number];

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

/** A whole catalog: a namespace map whose leaves are message nodes. */
export const messageCatalogSchema = z.record(messageNodeSchema);

/** Spanish is the default locale, so its catalog is the reference shape. */
export type MessageCatalog = typeof es;

/**
 * Every catalog, keyed by locale. The `satisfies` is the COMPILE-TIME half of
 * the check: a key present in one catalog and missing from the other, or a
 * locale with no catalog at all, is a build error.
 *
 * IT IS ONLY HALF, AND THE OTHER HALF IS IN THE TEST BESIDE THIS FILE. What
 * the compiler cannot see is the READ side: `t()` keys are plain strings (there
 * is no `IntlMessages` augmentation in this app), so a namespace retired from
 * both catalogs while a page still reads it is neither a type error nor a
 * failing render — next-intl prints the key path, and an operator gets
 * `admin.metrics.title` next to a euro figure. `messages.test.ts` scans the
 * source for namespace and key literals and resolves each against `es`, which
 * is what makes a retirement commit safe to write.
 */
const catalogs = { es, en } satisfies Record<DashboardLocale, MessageCatalog>;

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

/** Thrown when a catalog in the bundle is not a message tree. */
export class MessageCatalogError extends Error {
  readonly locale: DashboardLocale;

  constructor(locale: DashboardLocale, issues: readonly z.ZodIssue[]) {
    const seen = new Set<string>();
    const detail = flattenIssues(issues)
      .sort((a, b) => b.path.length - a.path.length)
      .map((issue) => issue.path.join(".") || "<root>")
      .filter((path) => (seen.has(path) ? false : seen.add(path) !== undefined))
      .slice(0, 5)
      .join(", ");

    super(`Message catalog for locale "${locale}" is malformed at: ${detail}`);
    this.name = "MessageCatalogError";
    this.locale = locale;
  }
}

/**
 * The validated catalog for one locale.
 *
 * The parse is a GATE, not a transform: on success the statically-typed import
 * is handed on, because `messageCatalogSchema`'s output is the widened
 * `Record<string, MessageNode>` and returning that would discard the precise
 * key type callers get from `MessageCatalog`.
 */
export function loadMessages(locale: DashboardLocale): MessageCatalog {
  const catalog = catalogs[locale];
  const parsed = messageCatalogSchema.safeParse(catalog);
  if (!parsed.success) {
    throw new MessageCatalogError(locale, parsed.error.issues);
  }
  return catalog;
}
