import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/**
 * Locale-aware navigation primitives.
 *
 * EVERY component in this app imports Link/useRouter/usePathname/redirect from
 * here, never from next/link or next/navigation — enforced by the
 * `no-restricted-imports` rule in eslint.config.mjs, which grants this file
 * (and only this file) the exemption. Importing `next/link` directly produces
 * hrefs that drop the locale prefix, silently kicking English users back to
 * Spanish on the next click.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
