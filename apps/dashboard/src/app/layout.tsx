import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Schibsted_Grotesk, JetBrains_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { STORE_LOCALE } from "@akai/contracts";
import "./globals.css";

/**
 * The dashboard's root layout.
 *
 * This file IS the root layout and owns `<html>`. The dashboard is Spanish
 * only: there is no `[locale]` segment, and next-intl reads its one catalogue
 * from `src/i18n/request.ts`.
 *
 * The two fonts are loaded with the same families, weights and CSS variable
 * names as the storefront so `--font-sans`/`--font-mono` in globals.css resolve
 * identically in both apps. A user moving from the shop to their account must
 * not see the typography change.
 *
 * INSTRUMENT SERIF IS DELIBERATELY NOT LOADED. It is the storefront's display
 * face and no dashboard rule and no dashboard component ever asked for it — the
 * app was downloading four woff2 files (roman and italic, two subsets) to
 * render them zero times. `--font-serif` is declared `Georgia, serif` in
 * globals.css precisely so dropping the load leaves no `var(--font-instrument)`
 * leg behind: an undefined `var()` with no fallback is invalid at computed-value
 * time and would take the whole declaration with it.
 */

const schibsted = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-schibsted",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: { default: t("title"), template: "%s | Akai" },
    description: t("description"),
    // The account area must never appear in a search index: its URLs are
    // per-customer and its pages are meaningless (or 404) to a crawler.
    robots: { index: false, follow: false },
  };
}

interface RootLayoutProps {
  readonly children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang={STORE_LOCALE} className={`${schibsted.variable} ${jetbrains.variable}`}>
      <body className="font-sans antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
