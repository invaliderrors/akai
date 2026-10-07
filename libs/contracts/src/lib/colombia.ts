import { z } from "zod";

/**
 * Colombia — the only country Akai sells to — as data every app agrees on:
 * the departamentos an address must name, the shape of a mobile number, and
 * the identity documents a buyer can present.
 *
 * Closed lists live here rather than in a web app because three readers need
 * them: the API validates against them, the storefront's checkout renders them
 * as `<select>`s, and the dashboard's address book and order views do both.
 */

// ---------------------------------------------------------------------------
// Language and time
// ---------------------------------------------------------------------------

/**
 * The shop is Spanish only. This BCP 47 tag is the one every `Intl` formatter
 * uses — money ("$ 89.000"), numbers and dates — and what `<html lang>` says.
 */
export const STORE_LOCALE = "es-CO";

/**
 * Every displayed date and time is Colombian time. A FIXED zone (rather than the
 * server's or the browser's) also keeps a server-rendered date identical to its
 * hydrated twin.
 */
export const STORE_TIME_ZONE = "America/Bogota";

// ---------------------------------------------------------------------------
// Departamentos
// ---------------------------------------------------------------------------

/**
 * The 32 departamentos plus Bogotá, D.C. (the capital district, which DANE
 * lists beside them). `code` is the two-digit DANE DIVIPOLA code — stable, and
 * what a tax or carrier integration keys on; `name` is the Spanish name an
 * address stores in `region` and a person reads.
 *
 * Ordered by name for the checkout `<select>`.
 */
export const COLOMBIAN_DEPARTAMENTOS = [
  { code: "91", name: "Amazonas" },
  { code: "05", name: "Antioquia" },
  { code: "81", name: "Arauca" },
  { code: "88", name: "Archipiélago de San Andrés, Providencia y Santa Catalina" },
  { code: "08", name: "Atlántico" },
  { code: "11", name: "Bogotá, D.C." },
  { code: "13", name: "Bolívar" },
  { code: "15", name: "Boyacá" },
  { code: "17", name: "Caldas" },
  { code: "18", name: "Caquetá" },
  { code: "85", name: "Casanare" },
  { code: "19", name: "Cauca" },
  { code: "20", name: "Cesar" },
  { code: "27", name: "Chocó" },
  { code: "23", name: "Córdoba" },
  { code: "25", name: "Cundinamarca" },
  { code: "94", name: "Guainía" },
  { code: "95", name: "Guaviare" },
  { code: "41", name: "Huila" },
  { code: "44", name: "La Guajira" },
  { code: "47", name: "Magdalena" },
  { code: "50", name: "Meta" },
  { code: "52", name: "Nariño" },
  { code: "54", name: "Norte de Santander" },
  { code: "86", name: "Putumayo" },
  { code: "63", name: "Quindío" },
  { code: "66", name: "Risaralda" },
  { code: "68", name: "Santander" },
  { code: "70", name: "Sucre" },
  { code: "73", name: "Tolima" },
  { code: "76", name: "Valle del Cauca" },
  { code: "97", name: "Vaupés" },
  { code: "99", name: "Vichada" },
] as const satisfies readonly { readonly code: string; readonly name: string }[];

export type ColombianDepartamento = (typeof COLOMBIAN_DEPARTAMENTOS)[number];
export type DepartamentoCode = ColombianDepartamento["code"];
export type DepartamentoName = ColombianDepartamento["name"];

/** Case-, accent- and spacing-insensitive key: "bogota d.c" ≡ "Bogotá, D.C.". */
function lookupKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const DEPARTAMENTO_BY_KEY: ReadonlyMap<string, ColombianDepartamento> = new Map(
  COLOMBIAN_DEPARTAMENTOS.flatMap((departamento) => [
    [lookupKey(departamento.name), departamento] as const,
    [departamento.code, departamento] as const,
  ]),
);

/**
 * The departamento a value names — by DANE code ("05") or by name, ignoring
 * case, accents and punctuation ("antioquia", "BOGOTA DC") — or null.
 */
export function findDepartamento(value: string): ColombianDepartamento | null {
  const trimmed = value.trim();
  return DEPARTAMENTO_BY_KEY.get(trimmed) ?? DEPARTAMENTO_BY_KEY.get(lookupKey(trimmed)) ?? null;
}

/** True only for a canonical name, exactly as `COLOMBIAN_DEPARTAMENTOS` spells it. */
export function isDepartamentoName(value: string): value is DepartamentoName {
  return COLOMBIAN_DEPARTAMENTOS.some((departamento) => departamento.name === value);
}

/**
 * An address's `region`: a departamento, NORMALISED to its canonical Spanish
 * name. A code or a loosely-typed name is accepted and rewritten, so what is
 * stored (and printed on a label) is always one of 33 exact strings.
 */
export const departamentoSchema = z
  .string()
  .max(120)
  .transform((value, ctx) => {
    const departamento = findDepartamento(value);
    if (departamento === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "region must be a Colombian departamento (or Bogotá, D.C.)",
      });
      return z.NEVER;
    }
    return departamento.name as string;
  });

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * A Colombian mobile number, normalised to its 10 national digits — no +57,
 * no spaces — e.g. "3001234567". Every Colombian mobile starts with 3.
 *
 * Accepts what people type: "300 123 4567", "+57 300-123-4567",
 * "(300) 123.4567", "573001234567". Anything else — a landline, a foreign
 * number, too few digits — is refused: the carrier calls this number, and so
 * will a payment provider's PSE flow.
 */
export function normaliseColombianMobile(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\+?[0-9 ().-]+$/.test(trimmed)) {
    return null;
  }
  let digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length === 12 && digits.startsWith("57")) {
    digits = digits.slice(2);
  }
  return /^3[0-9]{9}$/.test(digits) ? digits : null;
}

export const colombianMobileSchema = z
  .string()
  .max(32)
  .transform((value, ctx) => {
    const normalised = normaliseColombianMobile(value);
    if (normalised === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "phone must be a Colombian mobile number: 10 digits starting with 3",
      });
      return z.NEVER;
    }
    return normalised;
  });

// ---------------------------------------------------------------------------
// Postal code
// ---------------------------------------------------------------------------

/** Colombian postal codes are six digits ("110111"). Rarely used, so optional where it appears. */
export const colombianPostalCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{6}$/, "postalCode must be a six-digit Colombian postal code");

// ---------------------------------------------------------------------------
// Identity documents
// ---------------------------------------------------------------------------

/**
 * The documents a buyer can identify with at checkout (and that a PSE payment
 * asks for). Mirrors the Prisma enum `IdentityDocumentType`.
 *
 *  - CC  — Cédula de ciudadanía.
 *  - CE  — Cédula de extranjería.
 *  - NIT — Número de identificación tributaria (a company, or a taxpayer).
 *  - PP  — Pasaporte.
 *  - TI  — Tarjeta de identidad.
 *  - PPT — Permiso por protección temporal.
 */
export const identityDocumentTypeSchema = z.enum(["CC", "CE", "NIT", "PP", "TI", "PPT"]);
export type IdentityDocumentType = z.infer<typeof identityDocumentTypeSchema>;

/** The DIAN check digit ("dígito de verificación") of a NIT's base digits. */
export function nitCheckDigit(base: string): number {
  const WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  let total = 0;
  const digits = [...base].reverse();
  digits.forEach((digit, index) => {
    total += Number(digit) * (WEIGHTS[index] ?? 0);
  });
  const remainder = total % 11;
  return remainder > 1 ? 11 - remainder : remainder;
}

/**
 * A document number in its stored form, or null when it is not a valid number
 * for that document type.
 *
 *  - CC, TI   — digits only (dots and spaces as typed are dropped):
 *               CC 3–10 digits, TI 6–11.
 *  - NIT      — 5–15 digits, optionally followed by the check digit after a
 *               hyphen ("900.123.456-7" → "900123456-7"). A check digit that
 *               does not match DIAN's algorithm is refused: it is how a
 *               mistyped NIT is caught.
 *  - CE, PP, PPT — letters and digits (uppercased; spaces, dots and hyphens
 *               dropped): CE 3–15, PP 4–20, PPT 4–15.
 */
export function normaliseDocumentNumber(type: IdentityDocumentType, raw: string): string | null {
  const compact = raw.trim().replace(/[\s.]/g, "").toUpperCase();
  switch (type) {
    case "CC":
      return /^[0-9]{3,10}$/.test(compact) ? compact : null;
    case "TI":
      return /^[0-9]{6,11}$/.test(compact) ? compact : null;
    case "NIT": {
      const match = /^([0-9]{5,15})(?:-([0-9]))?$/.exec(compact);
      if (match === null) {
        return null;
      }
      const base = match[1] ?? "";
      const checkDigit = match[2];
      if (checkDigit === undefined) {
        return base;
      }
      return nitCheckDigit(base) === Number(checkDigit) ? `${base}-${checkDigit}` : null;
    }
    case "CE": {
      const value = compact.replace(/-/g, "");
      return /^[A-Z0-9]{3,15}$/.test(value) ? value : null;
    }
    case "PP": {
      const value = compact.replace(/-/g, "");
      return /^[A-Z0-9]{4,20}$/.test(value) ? value : null;
    }
    case "PPT": {
      const value = compact.replace(/-/g, "");
      return /^[A-Z0-9]{4,15}$/.test(value) ? value : null;
    }
  }
}

/** The raw document number as a request carries it — normalised against its type by the caller. */
export const documentNumberInputSchema = z.string().trim().min(1).max(32);

/**
 * A stored (already normalised) document number, as responses carry it. The
 * same character set the database CHECK enforces.
 */
export const documentNumberSchema = z
  .string()
  .max(20)
  .regex(/^[0-9A-Z]+(-[0-9])?$/);
