import createNextIntlPlugin from "next-intl/plugin";
import path from "node:path";
import type { NextConfig } from "next";

// Standalone output makes Next copy/symlink the traced node_modules into
// `.next/standalone`. On Windows that copy uses symlinks, which fail with
// `EPERM: operation not permitted, symlink` unless Developer Mode or an elevated
// shell is active — the compile, type-check and static generation all succeed
// and only the trace-copy step throws. The Docker image is built on Linux, where
// this never happens, so gate standalone on the platform: Linux/CI keep the
// self-contained bundle the Dockerfile needs, and a local Windows `next build`
// completes instead of dying at the very last step. Force it back on anywhere
// with NEXT_FORCE_STANDALONE=1.
const useStandalone =
  process.platform !== "win32" || process.env.NEXT_FORCE_STANDALONE === "1";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle with only the traced dependencies, so
  // the runtime image does not need node_modules at all. Required by the
  // Dockerfile in this directory; without it the image would have to carry the
  // entire pnpm store.
  ...(useStandalone ? { output: "standalone" as const } : {}),
  // Workspace root, not the app dir — standalone tracing otherwise misses
  // deps hoisted into the root node_modules/.pnpm store.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Baseline security headers on every response. A full nonce-based CSP is a
  // followUp: it needs per-request nonce middleware to coexist with Next's
  // inline hydration scripts. The dashboard is authenticated, so framing and
  // MIME-sniffing protection matter here even more than on the storefront.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
    ];
  },
};

/**
 * The next-intl plugin points the build at `src/i18n/request.ts` (its default
 * location). Without it `getTranslations`/`setRequestLocale` have no request
 * config to read and every server component that translates throws at render —
 * a runtime failure that typecheck and lint cannot see, exactly like the
 * template-literal message import the request config itself uses.
 */
const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
