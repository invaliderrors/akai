import { describe, expect, it } from "vitest";

import { SUPPORTED_CURRENCIES, currencyFlag, currencyLabel } from "./currency";

describe("SUPPORTED_CURRENCIES", () => {
  it("leads with the store's base currency", () => {
    // EUR is DEFAULT_CART_CURRENCY. An operator scoping a discount reaches for
    // it far more often than for the other 83, so it does not sit under E.
    expect(SUPPORTED_CURRENCIES[0]).toBe("EUR");
  });

  it("lists the rest alphabetically, with no duplicates", () => {
    const rest = SUPPORTED_CURRENCIES.slice(1);
    expect(rest).toEqual([...rest].sort());
    expect(new Set(SUPPORTED_CURRENCIES).size).toBe(SUPPORTED_CURRENCIES.length);
  });

  it("holds only well-formed ISO-4217 codes", () => {
    // The same shape `currencyCodeSchema` enforces at the boundary. A lowercase
    // code here would be a half-done conversion from the provider's enum, which
    // speaks lowercase.
    for (const code of SUPPORTED_CURRENCIES) {
      expect(code, `${code} is not an uppercase three-letter code`).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("covers the currencies this business actually charges in", () => {
    for (const code of ["EUR", "GBP", "USD", "CHF", "SEK", "PLN"]) {
      expect(SUPPORTED_CURRENCIES).toContain(code);
    }
  });
});

describe("currencyFlag", () => {
  it("derives the flag from the country half of the code", () => {
    expect(currencyFlag("EUR")).toBe("🇪🇺");
    expect(currencyFlag("GBP")).toBe("🇬🇧");
    expect(currencyFlag("USD")).toBe("🇺🇸");
    expect(currencyFlag("JPY")).toBe("🇯🇵");
  });

  it("returns null for a currency belonging to no single country", () => {
    // ISO reserves the X range for supranational units: XOF is the West African
    // CFA franc across eight states. Any flag here would be a claim about a
    // currency union that is not ours to make.
    expect(currencyFlag("XOF")).toBeNull();
    expect(currencyFlag("XCD")).toBeNull();
  });

  it("gives every supported currency either a flag or an honest null", () => {
    for (const code of SUPPORTED_CURRENCIES) {
      const flag = currencyFlag(code);
      if (code.startsWith("X")) {
        expect(flag, `${code} is supranational and should carry no flag`).toBeNull();
      } else {
        // Two regional indicators, four UTF-16 units. A partial flag would
        // render as stray letters rather than failing.
        expect(flag, `${code} should resolve to a flag`).not.toBeNull();
        expect(flag?.length, `${code} produced a malformed flag`).toBe(4);
      }
    }
  });
});

describe("currencyLabel", () => {
  it("puts the code first so a native select's type-ahead still works", () => {
    // The control replaced a three-letter code input, so an operator types
    // "EUR". A leading flag is two code points of regional indicator and would
    // swallow the keystroke, leaving 84 options navigable only by scrolling.
    expect(currencyLabel("EUR", "es").startsWith("EUR")).toBe(true);
    expect(currencyLabel("USD", "en").startsWith("USD")).toBe(true);
  });

  it("carries the flag and the localised name", () => {
    const english = currencyLabel("EUR", "en");
    expect(english).toContain("🇪🇺");
    expect(english.toLowerCase()).toContain("euro");
  });

  it("names the currency in the reader's language", () => {
    // The whole reason the name is not a hardcoded table: a Spanish operator
    // should not read "Japanese Yen".
    const es = currencyLabel("JPY", "es");
    const en = currencyLabel("JPY", "en");
    expect(es).toContain("🇯🇵");
    expect(en).toContain("🇯🇵");
    expect(en.toLowerCase()).toContain("yen");
  });

  it("falls back to the bare code when there is no flag", () => {
    const label = currencyLabel("XOF", "es");
    expect(label.startsWith("XOF")).toBe(true);
    // No stray separator where the flag would have been.
    expect(label).not.toContain("XOF  ");
  });

  it("produces a distinct label for every supported currency", () => {
    // Two options reading the same is a picker an operator cannot use.
    const labels = SUPPORTED_CURRENCIES.map((code) => currencyLabel(code, "es"));
    expect(new Set(labels).size).toBe(labels.length);
  });
});
