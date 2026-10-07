import { describe, expect, it } from "vitest";

import { SUPPORTED_CURRENCIES, currencyFlag, currencyLabel } from "./currency";

describe("SUPPORTED_CURRENCIES", () => {
  it("is exactly what Wompi can charge: COP", () => {
    // A discount scoped to a currency the provider cannot charge in would
    // silently never apply, so the picker offers nothing else.
    expect(SUPPORTED_CURRENCIES).toEqual(["COP"]);
  });

  it("holds only well-formed ISO-4217 codes", () => {
    // The same shape `currencyCodeSchema` enforces at the boundary.
    for (const code of SUPPORTED_CURRENCIES) {
      expect(code, `${code} is not an uppercase three-letter code`).toMatch(/^[A-Z]{3}$/);
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
    expect(currencyLabel("EUR").startsWith("EUR")).toBe(true);
    expect(currencyLabel("COP").startsWith("COP")).toBe(true);
  });

  it("carries the flag and the Spanish name", () => {
    // The whole reason the name is not a hardcoded table: ICU already knows
    // every currency's Spanish name.
    const peso = currencyLabel("COP");
    expect(peso).toContain("🇨🇴");
    expect(peso.toLowerCase()).toContain("peso colombiano");
  });

  it("falls back to the bare code when there is no flag", () => {
    const label = currencyLabel("XOF");
    expect(label.startsWith("XOF")).toBe(true);
    // No stray separator where the flag would have been.
    expect(label).not.toContain("XOF  ");
  });

  it("produces a distinct label for every supported currency", () => {
    // Two options reading the same is a picker an operator cannot use.
    const labels = SUPPORTED_CURRENCIES.map((code) => currencyLabel(code));
    expect(new Set(labels).size).toBe(labels.length);
  });
});
