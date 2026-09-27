import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { ProductMediaItem } from "@/components/ui/media-uploader";

import { LiveProductMedia, StagedProductMedia } from "./product-media";
import esMessages from "../../../messages/es.json";
import enMessages from "../../../messages/en.json";

/**
 * ONE property, and it is the one nothing else can catch.
 *
 * `MediaUploader` takes all twenty-odd of its strings as props, deliberately —
 * its copy is split across `admin.productMedia` and the shared `ui` namespace.
 * That means a renamed or deleted message leaf is not a compile error anywhere:
 * `useTranslations` resolves a missing key at RUNTIME, and next-intl's default
 * behaviour is to log and render the key path itself. So an operator would see
 * `ui.altRequired` printed under a photo and the build would stay green.
 *
 * Supplying `onError` replaces that logging, which turns a missing message into
 * a failed assertion here — against the REAL catalogues, in BOTH locales.
 */

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const ITEM: ProductMediaItem = {
  id: "9f1c6c5e-0000-4000-8000-000000000001",
  url: "https://cdn.example.test/products/camiseta-front.jpg",
  alt: { es: "Bote de camiseta", en: "Tub of tee" },
  width: 1200,
  height: 1200,
  sortOrder: 0,
};

const CATALOGUES = [
  { locale: "es" as const, messages: esMessages },
  { locale: "en" as const, messages: enMessages },
];

function renderWithIntl(
  locale: "es" | "en",
  messages: typeof esMessages,
  children: ReactNode,
): readonly string[] {
  const errors: string[] = [];

  render(
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      onError={(error) => errors.push(error.message)}
    >
      <ToastProvider closeLabel={messages.ui.close}>{children}</ToastProvider>
    </NextIntlClientProvider>,
  );

  return errors;
}

describe("<StagedProductMedia />", () => {
  it.each(CATALOGUES)("supplies every label from the $locale catalogue", ({ locale, messages }) => {
    const errors = renderWithIntl(
      locale,
      messages,
      <StagedProductMedia images={[]} onChange={() => {}} />,
    );

    expect(errors).toEqual([]);
    expect(screen.getByText(messages.admin.productMedia.stagedHint)).toBeInTheDocument();
  });
});

describe("<LiveProductMedia />", () => {
  it.each(CATALOGUES)("supplies every label from the $locale catalogue", ({ locale, messages }) => {
    const errors = renderWithIntl(
      locale,
      messages,
      <LiveProductMedia
        productId="22222222-2222-4222-8222-222222222222"
        items={[ITEM]}
        onRequestUpload={vi.fn()}
        onAttach={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(errors).toEqual([]);
    // The primary marker is the one label that comes from the `ui` namespace and
    // appears on screen, so it is the cheapest proof that both halves of the
    // split are wired rather than only the product-specific half.
    expect(screen.getByText(messages.ui.primary)).toBeInTheDocument();
  });
});
