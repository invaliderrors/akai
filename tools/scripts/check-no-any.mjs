#!/usr/bin/env node
/**
 * CI gate: fail the build on any escape hatch from the type system.
 *
 * The "zero any" rule is non-negotiable, and a rule enforced only by reviewer
 * diligence is not enforced. ESLint covers `no-explicit-any`, but it does NOT
 * catch `@ts-ignore`, `@ts-expect-error` or non-null assertions, and it can be
 * disabled inline — which is exactly what someone does at 2am. This script has
 * no inline escape.
 *
 * Scope: apps/api, apps/worker, libs/** — the server and shared code where the
 * typing standard is absolute. The frontend apps rely on ESLint's type-aware
 * `no-unsafe-*` rules instead.
 *
 * Usage: node tools/scripts/check-no-any.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["apps/api/src", "apps/worker/src", "libs"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "generated", "migrations"]);

/**
 * Each rule pairs a detector with the reason it exists, because a CI failure
 * that only says "forbidden pattern" gets worked around rather than fixed.
 */
/**
 * Rules checked against CODE (comments and literals stripped first).
 */
const CODE_RULES = [
  {
    name: "explicit-any",
    // `: any`, `<any>`, `as any`, `any[]`, `Array<any>` — but NOT identifiers
    // that merely contain "any" (company, many, anywhere).
    pattern: /(?<![A-Za-z0-9_$])any(?![A-Za-z0-9_$])/,
    why: "Use `unknown` plus narrowing for external data, or a typed adapter if a library forces a loose type.",
  },
];

/**
 * Rules checked against the RAW source.
 *
 * These MUST bypass comment stripping: a `@ts-ignore` IS a comment, so
 * scanning stripped source would make these three rules permanently
 * unfirable — a gate that reports success while checking nothing, which is
 * worse than no gate at all. (Caught exactly that way, by probing the gate
 * with a deliberate violation.)
 */
const RAW_RULES = [
  {
    name: "ts-ignore",
    pattern: /@ts-ignore/,
    why: "Silencing the compiler hides a real type error. Fix the type.",
  },
  {
    name: "ts-expect-error",
    pattern: /@ts-expect-error/,
    why: "Only legitimate in a test asserting a compile error, and none exist here yet. Fix the type instead.",
  },
  {
    name: "ts-nocheck",
    pattern: /@ts-nocheck/,
    why: "Disables checking for an entire file.",
  },
];

/**
 * Non-null assertions need their own detector: `!` is far too common a
 * character to regex naively (`!==`, `!value`, `a! + b`). This matches the
 * postfix form specifically — `identifier!.`, `identifier!)`, `identifier!;`
 * and friends — while excluding comparison operators.
 */
const NON_NULL_ASSERTION = /[A-Za-z0-9_$\])]\!(?=[.,;)\]\s]|$)/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      yield* walk(full);
    } else if (/\.tsx?$/.test(entry)) {
      yield full;
    }
  }
}

/**
 * Strip comments and string/template literals before scanning.
 *
 * Without this, every prose mention of "any" in a doc comment — and this
 * codebase has many, deliberately — is a false positive, and the gate gets
 * disabled within a week for crying wolf.
 */
function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    // Vitest's asymmetric matcher `expect.any(String)` is a FUNCTION CALL, not
    // a type annotation, but the explicit-any detector sees the bare token
    // `any` and fails the build. That made the gate fire on the most idiomatic
    // assertion in the framework, so test authors had to contort around it —
    // and a gate that punishes correct code is a gate that gets deleted.
    // Neutralised here rather than by weakening the explicit-any pattern, so
    // `: any` and `as any` still fail.
    //
    // `.anything()` needs no handling: "anything" has trailing word characters,
    // so the detector's word boundary already excludes it.
    .replace(/expect\s*\.\s*any\s*\(/g, "expect.__asymmetricMatcher(");
}

const violations = [];

for (const scanDir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, scanDir))) {
    const relativePath = relative(ROOT, file).split(sep).join("/");
    const source = readFileSync(file, "utf8");
    const rawLines = source.split("\n");
    const lines = stripNonCode(source).split("\n");

    rawLines.forEach((rawLine, index) => {
      for (const rule of RAW_RULES) {
        if (rule.pattern.test(rawLine)) {
          violations.push({
            file: relativePath,
            line: index + 1,
            rule: rule.name,
            why: rule.why,
          });
        }
      }
    });

    lines.forEach((line, index) => {
      for (const rule of CODE_RULES) {
        if (rule.pattern.test(line)) {
          violations.push({
            file: relativePath,
            line: index + 1,
            rule: rule.name,
            why: rule.why,
          });
        }
      }

      if (NON_NULL_ASSERTION.test(line)) {
        violations.push({
          file: relativePath,
          line: index + 1,
          rule: "non-null-assertion",
          why: "A `!` asserts away a null the compiler proved possible. Narrow with a check, or use a helper such as assertFound().",
        });
      }
    });
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `\n✖ Type-safety gate failed — ${violations.length} violation(s):\n\n`,
  );
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file}:${violation.line}  [${violation.rule}]\n`);
    process.stderr.write(`    ${violation.why}\n`);
  }
  process.stderr.write("\n");
  process.exit(1);
}

process.stdout.write("✔ Type-safety gate passed: no any / ts-ignore / non-null assertions.\n");
