import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serverEnvShape } from "./schema";

/**
 * Guards the documentation against the code.
 *
 * `.env.example` is how an operator learns what to set. When a new required
 * variable is added to the schema and not to the example, the failure mode is a
 * deploy that crashes at boot with a message about a variable nobody has ever
 * heard of. This test turns that into a failing unit test at authoring time.
 */

const ENV_EXAMPLE = path.resolve(__dirname, "../../../.env.example");

/** `FOO=…` at the start of a line — a value an operator gets just by copying. */
function activeKeys(contents: string): Set<string> {
  return new Set(
    [...contents.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );
}

/**
 * `# FOO=…` — documented but deliberately not set.
 *
 * This is the ONLY correct way to document an optional URL variable. The schema
 * for those is `z.string().url().optional()`, which admits `undefined` but not
 * `""` — so shipping a bare `SENTRY_DSN=` in the template makes every fresh
 * copy of it fail validation with "Invalid url", naming a variable the operator
 * never intentionally set.
 */
function commentedKeys(contents: string): Set<string> {
  return new Set(
    [...contents.matchAll(/^#\s*([A-Z][A-Z0-9_]*)=/gm)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );
}

/** The schema's own key list, so the test cannot drift from the schema either. */
function schemaShape() {
  // The object schema directly, NOT `serverEnvSchema.innerType()`. That one is
  // wrapped in effects — a refinement and a transform — and unwrapping by hand
  // breaks silently the next time one is added.
  return serverEnvShape.shape;
}

describe(".env.example", () => {
  it("documents every variable the server schema declares", () => {
    const contents = readFileSync(ENV_EXAMPLE, "utf8");
    const active = activeKeys(contents);
    const commented = commentedKeys(contents);
    const shape = schemaShape();

    const missing = Object.keys(shape).filter(
      (key) => !active.has(key) && !commented.has(key),
    );

    expect(
      missing,
      `.env.example is missing ${missing.length} variable(s) declared in libs/config/src/schema.ts. ` +
        `An undocumented required variable becomes a boot crash on deploy.`,
    ).toEqual([]);
  });

  it("leaves no REQUIRED variable commented out", () => {
    // The looser rule above would otherwise let a required variable be
    // "documented" purely as a comment, so a copied template would fail at boot
    // on a variable that looks present in the file.
    const contents = readFileSync(ENV_EXAMPLE, "utf8");
    const active = activeKeys(contents);
    const shape = schemaShape();

    const commentedButRequired = Object.entries(shape)
      .filter(([key, field]) => !field.isOptional() && !active.has(key))
      .map(([key]) => key);

    expect(
      commentedButRequired,
      "These variables are REQUIRED by the schema but are only present in .env.example as comments. " +
        "Copying the template would produce an environment that cannot boot.",
    ).toEqual([]);
  });

  it("contains no real-looking secrets", () => {
    const contents = readFileSync(ENV_EXAMPLE, "utf8");

    // Placeholders only. A live key committed here is a live key on GitHub.
    expect(contents).not.toMatch(/sk_live_/);
    expect(contents).not.toMatch(/rk_live_/);
    // `whsec_placeholder` is fine; a real signing secret is 32+ random chars.
    expect(contents).not.toMatch(/whsec_[A-Za-z0-9]{32,}/);
  });

  it("contains no real-looking Wompi credentials", () => {
    const contents = readFileSync(ENV_EXAMPLE, "utf8");

    // Placeholders only, and SANDBOX placeholders: a fresh clone must never be
    // one edit away from a live Wompi account.
    expect(contents).not.toMatch(/^WOMPI_[A-Z_]+=\S*prod/m);
    expect(/^WOMPI_ENVIRONMENT=(.*)$/m.exec(contents)?.[1]).toBe("sandbox");

    for (const name of [
      "WOMPI_PUBLIC_KEY",
      "WOMPI_PRIVATE_KEY",
      "WOMPI_INTEGRITY_SECRET",
      "WOMPI_EVENTS_SECRET",
    ]) {
      expect(new RegExp(`^${name}=(.*)$`, "m").exec(contents)?.[1] ?? "").toMatch(
        /placeholder$/,
      );
    }
  });
});
