import { beforeEach, describe, expect, it, vi } from "vitest";

const { listProducts } = vi.hoisted(() => ({ listProducts: vi.fn() }));
vi.mock("./api", () => ({ listProducts }));

const { loadAddOnCandidates } = await import("./add-on-candidates");

import type { AdminHttp } from "./http";

const http = {} as AdminHttp;

function row(
  id: string,
  slug: string,
  listed: boolean,
  translations: readonly { locale: string; name: string }[] = [
    { locale: "es", name: `${slug} es` },
    { locale: "en", name: `${slug} en` },
  ],
  extra: Record<string, unknown> = {},
) {
  // SHAPED LIKE THE REAL ROW, including `status` and `variants`. The earlier
  // fixture carried neither, and when the helper grew to read them the crash
  // was swallowed by its own never-throws catch and surfaced as an empty list —
  // a reminder that a fixture which has drifted from the API fails in the least
  // informative way available.
  return {
    id,
    slug,
    listed,
    status: "ACTIVE",
    translations,
    variants: [{ isActive: true, price: { gross: 4999, currency: "EUR" } }],
    ...extra,
  };
}

beforeEach(() => {
  // Braced: an arrow returning the mock is read by Vitest as a teardown callback.
  listProducts.mockReset();
});

describe("loadAddOnCandidates", () => {
  it("offers only the products marked as add-ons", async () => {
    listProducts.mockResolvedValue({
      items: [row("a", "agua", false), row("b", "camiseta", true)],
    });

    const result = await loadAddOnCandidates(http, "es");

    expect(result.map((candidate) => candidate.slug)).toEqual(["agua"]);
  });

  it("never offers the product being edited", async () => {
    // A page cannot offer itself, and listing it only invites the 400 the
    // service answers with.
    listProducts.mockResolvedValue({
      items: [row("a", "agua", false), row("self", "camiseta", false)],
    });

    const result = await loadAddOnCandidates(http, "es", "self");

    expect(result.map((candidate) => candidate.id)).toEqual(["a"]);
  });

  it("names each candidate in the operator's locale", async () => {
    listProducts.mockResolvedValue({ items: [row("a", "agua", false)] });

    expect((await loadAddOnCandidates(http, "en"))[0]?.name).toBe("agua en");
    expect((await loadAddOnCandidates(http, "es"))[0]?.name).toBe("agua es");
  });

  it("falls back to another translation, then to the slug", async () => {
    listProducts.mockResolvedValue({
      items: [
        row("a", "agua", false, [{ locale: "es", name: "Agua" }]),
        row("b", "pegatinas", false, []),
      ],
    });

    const result = await loadAddOnCandidates(http, "en");

    // No English translation — the Spanish one still names it better than an id.
    expect(result[0]?.name).toBe("Agua");
    // No translation at all — the slug is always present and always unique.
    expect(result[1]?.name).toBe("pegatinas");
  });

  it("returns nothing rather than throwing when the catalogue read fails", async () => {
    // The create page had no failure mode before the picker existed, and a
    // picker is not worth giving it one.
    listProducts.mockRejectedValue(new Error("API request failed (503)"));

    await expect(loadAddOnCandidates(http, "es")).resolves.toEqual([]);
  });
});

describe("loadAddOnCandidates — status and price", () => {
  it("carries a DRAFT through rather than hiding it", async () => {
    // Attaching an add-on before publishing it is a legitimate order of work, so
    // a draft stays offered — it is the PICKER's job to say it will not appear
    // in the shop yet. Hiding it here would make that impossible to explain.
    listProducts.mockResolvedValue({
      items: [row("a", "agua", false, undefined, { status: "DRAFT" })],
    });

    const result = await loadAddOnCandidates(http, "es");

    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("DRAFT");
  });

  it("carries the first ACTIVE variant's price, for the preview's card", async () => {
    listProducts.mockResolvedValue({
      items: [
        row("a", "agua", false, undefined, {
          variants: [
            { isActive: false, price: { gross: 100, currency: "EUR" } },
            { isActive: true, price: { gross: 2550, currency: "EUR" } },
          ],
        }),
      ],
    });

    const result = await loadAddOnCandidates(http, "es");

    expect(result[0]?.priceGross).toBe(2550);
    expect(result[0]?.currency).toBe("EUR");
  });

  it("reports no price when nothing is sellable, rather than inventing one", async () => {
    listProducts.mockResolvedValue({
      items: [row("a", "agua", false, undefined, { variants: [] })],
    });

    const result = await loadAddOnCandidates(http, "es");

    expect(result[0]?.priceGross).toBeNull();
  });
});
