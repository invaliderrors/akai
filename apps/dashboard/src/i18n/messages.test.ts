import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { STATUS_TONE, type BadgeTone, messageKey } from "@/lib/status";

import { MessageCatalogError, loadMessages, messageCatalogSchema } from "./messages";

/**
 * Same contract as the storefront's `src/i18n/messages.test.ts`, against this
 * app's own (Spanish-only) catalogue. The dashboard is where an account holder reads their
 * order history and an admin reads the store's numbers; a message key silently
 * resolving to `undefined` there is a blank field next to money.
 *
 * TWO GATES, AND THEY CATCH TWO DIFFERENT FAILURES.
 *
 *   enum        a status vocabulary that grew a member with no label. The tone
 *               side is asserted in `lib/status/index.test.ts`; the LABEL side
 *               is here, because a badge with a tone and no translation renders
 *               `status.order.WHATEVER` in colour.
 *   orphan      a namespace retired out from under a live reader. This is the
 *               one nothing else can see: `t()` keys are plain strings, so a
 *               deletion is neither a type error nor a failing render — the
 *               page just prints the key path to an operator.
 */

function leafPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  if (Array.isArray(value)) return [`${prefix}[]`];

  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

/**
 * One step down a catalog, without a cast.
 *
 * The obvious `(node as Record<string, unknown>)[segment]` is banned repo-wide
 * and `Object.entries` on a bare `object` reintroduces `any`, so the narrowing
 * is done by the same library that validates the catalog in the first place.
 * `z.record` rejects arrays as well as primitives, which is what we want: an
 * array leaf has no children to walk into.
 */
const branchSchema = z.record(z.unknown());

function resolvePath(catalog: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((node, segment) => {
      const parsed = branchSchema.safeParse(node);
      return parsed.success ? parsed.data[segment] : undefined;
    }, catalog);
}

describe("loadMessages", () => {
  it("returns the Spanish catalogue", () => {
    expect(leafPaths(loadMessages()).length).toBeGreaterThan(0);
    expect(resolvePath(loadMessages(), "status.order.PAID")).toEqual(expect.any(String));
  });

  it("returns the SAME object on repeated calls, not a rebuilt copy", () => {
    expect(loadMessages()).toBe(loadMessages());
  });
});

describe("messageCatalogSchema", () => {
  it("accepts strings, nested namespaces and arrays of entries", () => {
    expect(
      messageCatalogSchema.safeParse({
        account: { orders: { title: "Pedidos" } },
        statuses: ["PAID", "SHIPPED"],
      }).success,
    ).toBe(true);
  });

  it("rejects a numeric leaf", () => {
    expect(messageCatalogSchema.safeParse({ orders: { total: 42 } }).success).toBe(false);
  });

  it("rejects a catalog that is not an object at all", () => {
    expect(messageCatalogSchema.safeParse("es").success).toBe(false);
  });
});

describe("MessageCatalogError", () => {
  it("names the deepest failing path", () => {
    const parsed = messageCatalogSchema.safeParse({ orders: { total: 42 } });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const error = new MessageCatalogError(parsed.error.issues);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("orders.total");
  });
});

/**
 * GATE (a) — every badged value has a label.
 *
 * Driven off `STATUS_TONE` rather than a hand-written list, so the rule really
 * is "add a status, add one row": a new member of a contract enum is already a
 * compile error in `StatusVocabulary`, and the moment it is given a tone this
 * test demands the sentence that goes with it.
 */
describe("the status vocabulary is fully labelled", () => {
  const domains = Object.entries<Readonly<Record<string, BadgeTone>>>(STATUS_TONE);

  it("covers every domain lib/status knows about", () => {
    // A domain deleted from STATUS_TONE would otherwise make this whole
    // describe pass by iterating nothing.
    expect(domains.length).toBe(12);
  });

  it("builds the same path the badge asks for", () => {
    // The loop below composes `status.<domain>.<member>` by hand because the
    // iteration is over widened strings; this pins that spelling to the real
    // `messageKey`, so the two cannot drift apart unnoticed.
    expect(messageKey("order", "PAYMENT_MISMATCH")).toBe("status.order.PAYMENT_MISMATCH");
  });

  for (const [domain, members] of domains) {
    it(`labels every ${domain} member`, () => {
      const missing = Object.keys(members).flatMap((member) => {
        const path = `status.${domain}.${member}`;
        const leaf = resolvePath(loadMessages(), path);
        return typeof leaf === "string" && leaf.trim() !== "" ? [] : [path];
      });

      expect(missing).toEqual([]);
    });
  }
});

/**
 * GATE (b) — no page reads a key that no longer exists.
 *
 * WHY A SOURCE SCAN AND NOT A TYPE. next-intl can be taught the catalog shape
 * with an `IntlMessages` augmentation, but that types the KEY and not the
 * namespace argument, and this app has never had one — so the honest guard is
 * to read what the source actually asks for.
 *
 * KNOWN BLIND SPOT, AND IT IS DELIBERATE: keys built from a template literal
 * (`t(\`type.${discount.type}\`)`, `t(\`refundReasons.${value}\`)`,
 * `t(\`taxClasses.${taxClass}\`)`, `t(\`timeline${step}\`)`, and the
 * `t.has(code) ? t(code) : t("generic")` fallback in `ui/states.tsx`) cannot be
 * resolved statically. Each of those enumerates a CLOSED set that is checked
 * elsewhere — the status gate above, `lib/status/index.test.ts`, and the
 * component tests that render every option — so the gap is covered rather than
 * ignored. A key literal is what this scan is for.
 */
describe("no source file reads a retired message key", () => {
  const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

  /**
   * `const t = useTranslations("admin.orders")`, in every shape the app uses:
   * the hook, the awaited server helper, the `{ namespace }` object
   * form, and the no-argument form that reads from the catalog root.
   */
  const DECLARATION =
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*(?:"([^"]*)"|\{[^}]*namespace:\s*"([^"]*)"[^}]*\})?\s*\)/g;

  interface Declaration {
    /** Character offset, so a call resolves against the NEAREST one above it. */
    readonly at: number;
    readonly name: string;
    readonly namespace: string;
  }

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  function keyReads(file: string): string[] {
    const source = readFileSync(file, "utf8");
    const declarations: Declaration[] = [];

    DECLARATION.lastIndex = 0;
    for (let match = DECLARATION.exec(source); match !== null; match = DECLARATION.exec(source)) {
      const name = match[1];
      if (name === undefined) continue;
      declarations.push({ at: match.index, name, namespace: match[2] ?? match[3] ?? "" });
    }

    return [...new Set(declarations.map((declaration) => declaration.name))].flatMap((name) => {
      // `.rich` and `.markup` take the same key as `t` itself; `.has` is a
      // presence probe and is deliberately excluded, since asking about a key
      // that is absent is the whole point of it.
      const call = new RegExp(
        `\\b${name.replace(/\$/g, "\\$")}(?:\\.rich|\\.markup)?\\(\\s*"([^"]+)"`,
        "g",
      );
      const reads: string[] = [];

      for (let match = call.exec(source); match !== null; match = call.exec(source)) {
        const key = match[1];
        const at = match.index;
        if (key === undefined) continue;

        // Shadowing is real — `ui/states.tsx` declares `t` three times against
        // two namespaces — so bind each call to the last declaration ABOVE it
        // rather than to a per-file map, which would resolve the file's early
        // `errors` keys against its final `common` namespace.
        const owner = declarations.filter((d) => d.name === name && d.at < at).at(-1);
        if (owner === undefined) continue;

        reads.push(owner.namespace === "" ? key : `${owner.namespace}.${key}`);
      }

      return reads;
    });
  }

  it("scans a meaningful number of call sites", () => {
    // A regex that quietly stops matching would make the assertion below pass
    // over nothing at all, which is the failure mode of every scanner test.
    const total = sourceFiles(SRC_ROOT).flatMap(keyReads).length;
    expect(total).toBeGreaterThan(500);
  });

  it("resolves every literal key against the catalogue", () => {
    const catalog = loadMessages();

    const unresolved = sourceFiles(SRC_ROOT).flatMap((file) =>
      keyReads(file)
        .filter((path) => typeof resolvePath(catalog, path) !== "string")
        .map((path) => `${relative(SRC_ROOT, file)}: ${path}`),
    );

    expect([...new Set(unresolved)]).toEqual([]);
  });
});

/**
 * The retirement this scan was built to make safe: the account area used to
 * carry its own copies of the order, payment and shipment vocabularies beside
 * the shared `status` namespace, and the two drifted — a PAID order read one
 * way in the account area and another in admin. One vocabulary, one place.
 */
describe("the superseded duplicates stay retired", () => {
  it.each(["account.orderStatus", "account.paymentStatus", "account.shipmentStatus"])(
    "has no %s namespace",
    (path) => {
      expect(resolvePath(loadMessages(), path)).toBeUndefined();
    },
  );

  it("keeps the status namespace that replaced them", () => {
    expect(resolvePath(loadMessages(), "status.order.PAID")).toEqual(expect.any(String));
  });
});
