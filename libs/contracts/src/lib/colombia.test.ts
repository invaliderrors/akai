import { describe, expect, it } from "vitest";

import {
  COLOMBIAN_DEPARTAMENTOS,
  colombianMobileSchema,
  departamentoSchema,
  findDepartamento,
  identityDocumentTypeSchema,
  isDepartamentoName,
  nitCheckDigit,
  normaliseColombianMobile,
  normaliseDocumentNumber,
} from "./colombia";

describe("COLOMBIAN_DEPARTAMENTOS", () => {
  it("lists the 32 departamentos plus Bogotá, D.C. — 33 entries, each code and name once", () => {
    expect(COLOMBIAN_DEPARTAMENTOS).toHaveLength(33);
    expect(new Set(COLOMBIAN_DEPARTAMENTOS.map((d) => d.code)).size).toBe(33);
    expect(new Set(COLOMBIAN_DEPARTAMENTOS.map((d) => d.name)).size).toBe(33);
  });

  it("uses two-digit DANE codes", () => {
    for (const departamento of COLOMBIAN_DEPARTAMENTOS) {
      expect(departamento.code).toMatch(/^[0-9]{2}$/);
    }
    expect(findDepartamento("11")?.name).toBe("Bogotá, D.C.");
    expect(findDepartamento("05")?.name).toBe("Antioquia");
    expect(findDepartamento("76")?.name).toBe("Valle del Cauca");
  });

  it("is sorted by name for the checkout select", () => {
    const names = COLOMBIAN_DEPARTAMENTOS.map((d) => d.name);
    expect([...names].sort((a, b) => a.localeCompare(b, "es"))).toEqual(names);
  });
});

describe("departamentoSchema", () => {
  it("normalises a code or a loosely typed name to the canonical Spanish name", () => {
    expect(departamentoSchema.parse("Antioquia")).toBe("Antioquia");
    expect(departamentoSchema.parse("  antioquia ")).toBe("Antioquia");
    expect(departamentoSchema.parse("BOGOTA DC")).toBe("Bogotá, D.C.");
    expect(departamentoSchema.parse("Atlantico")).toBe("Atlántico");
    expect(departamentoSchema.parse("08")).toBe("Atlántico");
  });

  it("refuses anything that is not a departamento", () => {
    expect(departamentoSchema.safeParse("Madrid").success).toBe(false);
    expect(departamentoSchema.safeParse("").success).toBe(false);
    expect(departamentoSchema.safeParse("Medellín").success).toBe(false);
    expect(departamentoSchema.safeParse("00").success).toBe(false);
  });

  it("recognises canonical names exactly", () => {
    expect(isDepartamentoName("Nariño")).toBe(true);
    expect(isDepartamentoName("Narino")).toBe(false);
  });
});

describe("Colombian mobile numbers", () => {
  it.each([
    ["3001234567", "3001234567"],
    ["300 123 4567", "3001234567"],
    ["+57 300 123 4567", "3001234567"],
    ["+57-300-123-4567", "3001234567"],
    ["573001234567", "3001234567"],
    ["(300) 123.4567", "3001234567"],
  ])("normalises %s to %s", (raw, expected) => {
    expect(normaliseColombianMobile(raw)).toBe(expected);
    expect(colombianMobileSchema.parse(raw)).toBe(expected);
  });

  it.each([
    ["a landline", "6012345678"],
    ["too few digits", "300123456"],
    ["too many digits", "30012345678"],
    ["a foreign number", "+34 612 345 678"],
    ["letters", "300-ABC-4567"],
    ["empty", "   "],
  ])("refuses %s", (_label, raw) => {
    expect(normaliseColombianMobile(raw)).toBeNull();
    expect(colombianMobileSchema.safeParse(raw).success).toBe(false);
  });
});

describe("identity documents", () => {
  it("has exactly the six document types", () => {
    expect(identityDocumentTypeSchema.options).toEqual(["CC", "CE", "NIT", "PP", "TI", "PPT"]);
  });

  it("computes DIAN's NIT check digit", () => {
    expect(nitCheckDigit("800197268")).toBe(4);
    expect(nitCheckDigit("890903938")).toBe(8);
    expect(nitCheckDigit("899999068")).toBe(1);
    expect(nitCheckDigit("860034313")).toBe(7);
  });

  it("keeps a CC to its digits, dropping the dots people type", () => {
    expect(normaliseDocumentNumber("CC", "1.020.304.050")).toBe("1020304050");
    expect(normaliseDocumentNumber("CC", " 79 123 456 ")).toBe("79123456");
    expect(normaliseDocumentNumber("CC", "10203040501")).toBeNull();
    expect(normaliseDocumentNumber("CC", "12")).toBeNull();
    expect(normaliseDocumentNumber("CC", "AB123456")).toBeNull();
  });

  it("keeps a TI to 6–11 digits", () => {
    expect(normaliseDocumentNumber("TI", "1001234567")).toBe("1001234567");
    expect(normaliseDocumentNumber("TI", "12345")).toBeNull();
    expect(normaliseDocumentNumber("TI", "10012345A7")).toBeNull();
  });

  it("accepts a NIT with or without its check digit, and normalises the separator", () => {
    expect(normaliseDocumentNumber("NIT", "900.373.913-4")).toBe("900373913-4");
    expect(normaliseDocumentNumber("NIT", "800197268 - 4".replace(/ /g, ""))).toBe("800197268-4");
    expect(normaliseDocumentNumber("NIT", "860034313-7")).toBe("860034313-7");
    expect(normaliseDocumentNumber("NIT", "800197268")).toBe("800197268");
  });

  it("refuses a NIT whose check digit does not match", () => {
    expect(normaliseDocumentNumber("NIT", "800197268-5")).toBeNull();
    expect(normaliseDocumentNumber("NIT", "800197268-45")).toBeNull();
    expect(normaliseDocumentNumber("NIT", "NIT800197268")).toBeNull();
  });

  it("accepts letters and digits for CE, PP and PPT, uppercased", () => {
    expect(normaliseDocumentNumber("CE", "e-123456")).toBe("E123456");
    expect(normaliseDocumentNumber("PP", "ab 1234567")).toBe("AB1234567");
    expect(normaliseDocumentNumber("PPT", "1234567")).toBe("1234567");
  });

  it("bounds the alphanumeric documents' length and charset", () => {
    expect(normaliseDocumentNumber("PP", "AB1")).toBeNull();
    expect(normaliseDocumentNumber("PP", "A".repeat(21))).toBeNull();
    expect(normaliseDocumentNumber("CE", "12_34")).toBeNull();
    expect(normaliseDocumentNumber("PPT", "1".repeat(16))).toBeNull();
  });
});
