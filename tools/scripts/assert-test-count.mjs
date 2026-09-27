#!/usr/bin/env node
/**
 * CI gate: assert the suite still contains at least the expected number of tests.
 *
 * WHY THIS EXISTS. Vitest exits 0 when its `include` glob matches nothing — the
 * projects are even configured with `--passWithNoTests`, which is correct for a
 * library that genuinely has no tests yet and catastrophic for one whose tests
 * stopped being discovered. A misconfigured `include`, a moved directory or a
 * renamed file extension all produce "0 tests, exit 0", which is
 * indistinguishable in a CI log from a green run.
 *
 * That is not hypothetical here: the monorepo migration moved every suite from
 * the repository root into apps/*, and a stale glob would have reported success
 * while checking nothing.
 *
 * The floor is deliberately a FLOOR, not an exact count — tests are added
 * constantly and an exact assertion would fail on every legitimate PR. Raise it
 * when the suite grows meaningfully. NEVER lower it to make CI pass: a drop in
 * test count is either a deletion that needs justifying or a discovery bug, and
 * both deserve a human looking at them.
 *
 * Usage: node tools/scripts/assert-test-count.mjs
 */

import { execFileSync } from "node:child_process";

/**
 * Per-project minimums, measured at the time of the integration pass.
 *
 * Kept per project rather than as one workspace total so that a project whose
 * tests all vanish is caught even if another project grew enough to mask it in
 * an aggregate.
 */
/**
 * Pull `numTotalTests` out of a Vitest JSON report embedded in surrounding text.
 *
 * Scans to the matching close brace rather than to end-of-buffer, and tracks
 * string literals so a `}` inside a test NAME does not terminate the object
 * early — test names in this repo routinely contain braces and quotes.
 *
 * Returns 0 when no report is found, which the caller treats as a failure. That
 * is the correct direction: an unparseable report is exactly as suspicious as a
 * report of zero tests.
 */
function extractTotalTests(output) {
  const start = output.indexOf('{"numTotalTestSuites"');
  if (start < 0) {
    return 0;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < output.length; i += 1) {
    const char = output[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const report = JSON.parse(output.slice(start, i + 1));
        return Number(report.numTotalTests ?? 0);
      }
    }
  }

  return 0;
}

const MINIMUMS = [
  { project: "api", minimum: 900 },
  { project: "dashboard", minimum: 300 },
  { project: "storefront", minimum: 4 },
];

let failed = false;

for (const { project, minimum } of MINIMUMS) {
  let output;
  try {
    // `--reporter=json` gives a machine-readable count. Running through Nx
    // rather than vitest directly keeps the cwd and config resolution identical
    // to how CI actually runs the suite — otherwise this could pass against a
    // config the real run never uses.
    output = execFileSync(
      "pnpm",
      ["exec", "nx", "run", `${project}:test`, "--", "--reporter=json", "--silent"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" },
    );
  } catch (error) {
    // A non-zero exit means the suite itself failed. That is already reported by
    // the test step; this gate should not double-report it as a count problem.
    process.stderr.write(
      `\n! Could not measure ${project}: the suite did not complete.\n` +
        `  This gate reports COUNTS; see the test step for the actual failure.\n`,
    );
    failed = true;
    continue;
  }

  // Nx brackets the report with its own banner text on BOTH sides, so the JSON
  // must be extracted by scanning to its matching close brace. Slicing from the
  // start index to the end of the buffer fails with "unexpected non-whitespace
  // character" on Nx's trailing "Successfully ran target" line.
  const count = extractTotalTests(output);

  if (!Number.isFinite(count) || count < minimum) {
    process.stderr.write(
      `\n✖ ${project}: ${String(count)} tests discovered, expected at least ${String(minimum)}.\n` +
        `  A count at or near zero almost always means the vitest \`include\` glob\n` +
        `  no longer matches the test files — not that the tests pass.\n`,
    );
    failed = true;
  } else {
    process.stdout.write(`✔ ${project}: ${String(count)} tests (floor ${String(minimum)})\n`);
  }
}

if (failed) {
  process.exit(1);
}

process.stdout.write("✔ Test-count gate passed.\n");
