import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import tseslint from "typescript-eslint";
import nxPlugin from "@nx/eslint-plugin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

/** The Next.js app. Next-specific rules must not leak onto NestJS source. */
const NEXT_APPS = ["apps/dashboard/**/*.{ts,tsx}"];

// -----------------------------------------------------------------------------
// TYPE-AWARE LINTING — what makes the zero-`any` mandate actually hold.
//
// `no-explicit-any` catches the `any` TOKEN: an `any` somebody TYPED. It is
// blind to the far more common case, an `any` that FLOWS IN from a declaration
// file. A template-literal `import()`, `res.json()`, `JSON.parse()`, `vi.fn()`,
// a zod generic constrained to `z.ZodTypeAny` (which IS `ZodType<any, any,
// any>`) — none of those contain the token, every one of them produces the
// value, and all of them were silently green while the repo claimed zero `any`.
//
// Only the `no-unsafe-*` family sees them, and it needs type information, which
// needs a parser that has loaded the TypeScript program.
//
// The REST of `recommendedTypeChecked` is deliberately not enabled. It bundles a
// large set of unrelated opinions (`no-floating-promises`,
// `restrict-template-expressions`, `require-await`, `unbound-method` …) that are
// a separate decision from "no unchecked `any` reaches production". Adopting
// them as a side effect of switching on type awareness would be the wrong way to
// take that decision; add them deliberately, one at a time.
// -----------------------------------------------------------------------------
const UNSAFE_ANY_RULES = {
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-declaration-merging": "error",
};

/**
 * Candidate tsconfigs for one project, WIDEST FIRST.
 *
 * `tsconfig.spec.json` leads because it is the only config in every project that
 * includes `src/**` *plus* `*.test.ts` plus `vitest.config.ts` — the app/lib
 * configs deliberately exclude tests. Type-aware rules cannot run on a file that
 * belongs to no program, so a narrow-config-first order would silently leave
 * every test file unlinted, which is exactly where the library-sourced `any`
 * values live.
 */
const TSCONFIG_CANDIDATES = [
  "tsconfig.spec.json",
  "tsconfig.lib.json",
  "tsconfig.app.json",
  "tsconfig.json",
];

/**
 * One type-aware config block per project, each pointing ONLY at that project's
 * own tsconfigs.
 *
 * `projectService: true` was the first attempt and is wrong here: it resolves a
 * file to the nearest `tsconfig.json`, and every app/lib config in this
 * workspace excludes tests, so every `*.test.ts` failed to parse. A single
 * repo-wide `project: [...]` glob is wrong for a different reason — it builds
 * every project's program on every lint invocation, and `nx lint` runs one
 * project at a time.
 *
 * Generated from the filesystem rather than hand-listed so a new project is
 * type-aware the moment it exists. A project with none of the candidate configs
 * is skipped instead of throwing.
 */
function typeAwareConfigs() {
  const configs = [];

  for (const workspace of ["apps", "libs"]) {
    const workspaceDir = join(__dirname, workspace);
    if (!existsSync(workspaceDir)) continue;

    for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const projectDir = `${workspace}/${entry.name}`;
      const project = TSCONFIG_CANDIDATES.map((name) => `${projectDir}/${name}`).filter(
        (relativePath) => existsSync(join(__dirname, relativePath)),
      );
      if (project.length === 0) continue;

      configs.push({
        files: [`${projectDir}/**/*.{ts,tsx}`],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { project, tsconfigRootDir: __dirname },
        },
        rules: { ...UNSAFE_ANY_RULES },
      });
    }
  }

  return configs;
}

const eslintConfig = [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      ".nx/**",
      "**/next-env.d.ts",
      "**/postcss.config.mjs",
      // Reference material, not buildable source — kept in place but out of the
      // lint path so it cannot fail CI.
      "docs/**",
      ".claude/**",
      "**/.astro/**",
    ],
  },

  // ---------------------------------------------------------------------------
  // Baseline TypeScript rules for EVERY project, Next and Nest alike.
  // Applied via typescript-eslint directly rather than via `next/typescript`,
  // because that preset is scoped to the Next apps below.
  // ---------------------------------------------------------------------------
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["apps/**/*.{ts,tsx}", "libs/**/*.{ts,tsx}", "tools/**/*.ts"],
  })),

  {
    files: ["apps/**/*.{ts,tsx}", "libs/**/*.{ts,tsx}", "tools/**/*.ts"],
    rules: {
      // The zero-`any` mandate. Mechanically enforced, never reviewer diligence.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          // Allowed only with a real justification, never to silence a genuine error.
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 20,
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Nx module boundaries. This is the only MECHANICAL guard keeping libs/db
  // (and therefore Prisma) out of a browser bundle — a Next app importing it
  // is a lint error rather than a 4MB surprise at build time.
  // ---------------------------------------------------------------------------
  {
    files: ["apps/**/*.{ts,tsx}", "libs/**/*.{ts,tsx}"],
    plugins: { "@nx": nxPlugin },
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: false,
          // `@/…` is an app-LOCAL alias (each app maps it to its own ./src).
          // Nx would otherwise read every such import as a cross-project one
          // and demand relative paths.
          // Cross-project imports still go through @akai/* and are still
          // fully constrained by depConstraints below.
          allow: ["@/*", "@/**"],
          depConstraints: [
            {
              sourceTag: "scope:web",
              onlyDependOnLibsWithTags: ["scope:shared"],
            },
            {
              sourceTag: "scope:server",
              onlyDependOnLibsWithTags: ["scope:shared", "scope:server"],
            },
            {
              // Shared libs (money, config, ui) are imported by BOTH Next
              // apps, so they may only depend on other shared libs. This is what
              // stops @akai/money from one day importing @akai/db and dragging
              // Prisma into a browser bundle.
              sourceTag: "scope:shared",
              onlyDependOnLibsWithTags: ["scope:shared"],
            },
            {
              // libs/contracts is the shared vocabulary: it must stay importable
              // from a browser bundle, so it depends on nothing but zod.
              sourceTag: "type:contract",
              onlyDependOnLibsWithTags: [],
            },
            {
              // libs/testing binds fakes for both server and shared ports, so it
              // needs to see both. It is kept out of production bundles by the
              // `type:testing` tag plus the import restriction below, not by
              // limiting what it may depend on.
              sourceTag: "type:testing",
              onlyDependOnLibsWithTags: ["scope:shared", "scope:server"],
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // apps/api-e2e may reach into apps/api's source. Nothing else may.
  //
  // The integration suites exist to boot the REAL Nest graph — AppModule, the
  // real repository, the real webhook controller — against a real Postgres. A
  // suite that hand-assembled a smaller graph, or imported a copy of the module
  // under test, would be verifying a container the application never builds,
  // which is the one thing an integration test must not do.
  //
  // There is no `@akai/*` alias to route this through: those exist for `libs/*`
  // only, deliberately, because an application is not an importable package. So
  // a relative path is the only mechanism available, and this override is scoped
  // to `apps/api-e2e/**` + `../../api/src/**` so it cannot become a general
  // licence for apps to import each other's internals. The depConstraints above
  // still apply to every other import in these files: api-e2e is tagged
  // `scope:server`, so it still cannot reach a `scope:web` lib.
  // ---------------------------------------------------------------------------
  {
    files: ["apps/api-e2e/**/*.ts"],
    plugins: { "@nx": nxPlugin },
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: false,
          allow: ["@/*", "@/**", "../../api/src/*", "../../api/src/**"],
          depConstraints: [
            {
              sourceTag: "scope:server",
              onlyDependOnLibsWithTags: ["scope:shared", "scope:server"],
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Next.js presets — scoped with `files:` so React-hooks and next/* rules are
  // never applied to NestJS source in apps/api and apps/worker.
  // ---------------------------------------------------------------------------
  ...compat.extends("next/core-web-vitals", "next/typescript").map((config) => ({
    ...config,
    files: NEXT_APPS,
  })),
  {
    files: NEXT_APPS,
    settings: { next: { rootDir: "apps/dashboard" } },
  },


  // ---------------------------------------------------------------------------
  // Type-aware `no-unsafe-*`. LAST, so the project-scoped parserOptions win over
  // anything the Next preset above sets for the same files.
  // ---------------------------------------------------------------------------
  ...typeAwareConfigs(),
];

export default eslintConfig;
