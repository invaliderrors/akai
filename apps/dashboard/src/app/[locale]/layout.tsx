import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Schibsted_Grotesk, JetBrains_Mono } from "next/font/google";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import "../globals.css";

/**
 * The dashboard's root layout.
 *
 * There is deliberately NO `src/app/layout.tsx`: this file IS the root layout
 * and owns `<html>`. Two layouts both rendering `<html>` nests one inside the
 * other, which browsers silently paper over and hydration then fails on. The
 * storefront is structured the same way.
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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: { default: t("title"), template: "%s | Akai" },
    description: t("description"),
    // The account area must never appear in a search index: its URLs are
    // per-customer and its pages are meaningless (or 404) to a crawler.
    robots: { index: false, follow: false },
  };
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

interface LocaleLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ locale: string }>;
}

export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const { locale } = await params;

  // Middleware normally prevents an unknown locale from reaching here, but a
  // direct request to a statically-generated path can bypass it. `hasLocale`
  // narrows the string to the union, so this is a type guard as much as a
  // runtime one.
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  return (
    <html lang={locale} className={`${schibsted.variable} ${jetbrains.variable}`}>
      <body className="font-sans antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
