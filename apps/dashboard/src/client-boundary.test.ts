import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * REGRESSION: a module that imports a client-only React hook must carry
 * `"use client"`.
 *
 * Next's server/client check is STATIC AND MODULE-LEVEL. It does not ask whether
 * the hook is reachable — it asks whether a server component's import graph
 * contains a module that imports the hook at all. So a component can be
 * genuinely unreachable from a server tree and still fail the build.
 *
 * That is exactly how this was found, and it cost a failed deployment.
 * `ui/timeline.tsx` held a note composer using `useState` and carried no
 * directive, on the reasoning that a composer requiring an `onSubmit` function
 * could only ever be rendered from a client tree. True at runtime. Irrelevant
 * here: the order detail page renders a READ-ONLY rail with no composer at all,
 * and still could not compile.
 *
 * Nothing else in the suite catches it. `typecheck`, `test` and `lint` all pass
 * on the broken tree — the error surfaces only in `next build`, which is to say
 * in CI or on the deployment host. This test moves it back to the unit suite.
 */

const SRC = path.resolve(__dirname);

/**
 * Hooks and APIs that force a client component. `use` is deliberately absent:
 * it is valid in a server component, and its one-letter name makes it a
 * false-positive magnet.
 */
const CLIENT_ONLY = [
  "useState",
  "useReducer",
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useRef",
  "useImperativeHandle",
  "useCallback",
  "useMemo",
  "useContext",
  "useTransition",
  "useDeferredValue",
  "useOptimistic",
  "useSyncExternalStore",
  "useId",
  "useActionState",
  "createContext",
] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The identifiers a file imports from "react" or "react-dom".
 *
 * Parsed from the import statement rather than grepped from the whole file,
 * because every one of these names also appears in prose: `card.tsx` explains
 * why every id is a prop "rather than a `useId()`", and the admin products page
 * notes there is "no `useEffect` race between two filter changes". A grep flags
 * both and teaches the reader to ignore this test.
 */
function reactImports(source: string): Set<string> {
  const names = new Set<string>();
  const importRe = /import\s+([\s\S]*?)\s+from\s+["']react(?:-dom)?["']/g;

  let match = importRe.exec(source);
  while (match !== null) {
    const clause = match[1] ?? "";
    const braced = /\{([\s\S]*?)\}/.exec(clause);
    for (const raw of (braced?.[1] ?? "").split(",")) {
      // Strips `type` modifiers and `as` aliases: `type FormEvent`, `useState as s`.
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
      if (name !== "") {
        names.add(name);
      }
    }
    match = importRe.exec(source);
  }
  return names;
}

function hasDirective(source: string): boolean {
  // The directive must be the first statement, so only the head is inspected —
  // a "use client" inside a comment further down does not make a module client.
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/.test(source);
}

describe("dashboard client boundary", () => {
  const files = walk(SRC);

  it("finds source files to check", () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(50);
  });

  it("marks every module importing a client-only React API with \"use client\"", () => {
    const offenders = files
      .map((file) => {
        const source = readFileSync(file, "utf8");
        const imported = reactImports(source);
        const used = CLIENT_ONLY.filter((api) => imported.has(api));
        return used.length > 0 && !hasDirective(source)
          ? `${path.relative(SRC, file)} imports ${used.join(", ")}`
          : null;
      })
      .filter((entry): entry is string => entry !== null);

    expect(
      offenders,
      "these modules import a client-only React API without a \"use client\" " +
        "directive. Next's check is static, so this fails `next build` even when " +
        "the hook is unreachable from any server component. Either add the " +
        "directive, or split the stateful part into its own client module — the " +
        "split keeps the rest of the file server-renderable, which is usually " +
        "what you want.",
    ).toEqual([]);
  });
});
