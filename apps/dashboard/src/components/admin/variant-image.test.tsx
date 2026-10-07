import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { MediaAsset } from "@akai/contracts";

import type { StagedImage } from "@/components/ui/media-uploader";
import { ToastProvider } from "@/components/ui/toast";

import { VariantImageField, type VariantImageUploads } from "./variant-image";
import esMessages from "../../../messages/es.json";

/**
 * The variant image control, at its two seams.
 *
 * WHAT IS ACTUALLY UNDER TEST, and it is not the uploader: `MediaUploader` has
 * its own suite and this component deliberately adds no second copy of the
 * presign → PUT → attach dance. What is new here is (1) that every control names
 * WHICH variant it belongs to — a column of buttons all called "Añadir imagen"
 * is a column of buttons called nothing, and a column header does not name a
 * cell for a screen reader moving cell by cell — (2) that the attach carries the
 * `variantId`, without which the picture lands in the product gallery, and (3)
 * that a variant holds ONE image however many files are dropped on it.
 *
 * The labels come from the REAL catalogue through `onError`:
 * every string this component passes down is a prop, so a renamed message leaf
 * is not a compile error anywhere — next-intl resolves a missing key at runtime
 * and prints the key path at the operator.
 */

const refresh = vi.fn();

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

const SKU = "AK-HOOD-M";
const VARIANT_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";

const variant = esMessages.admin.variantImage;
const ui = esMessages.ui;

const ASSET: MediaAsset = {
  id: "9f1c6c5e-0000-4000-8000-000000000001",
  url: "https://cdn.example.test/products/camiseta-m.jpg",
  alt: "Camiseta negra, talla M",
  width: 1200,
  height: 1200,
  sortOrder: 0,
};

const messages = esMessages;

const png = (name = "tee.png") =>
  new File([new Uint8Array(64)], name, { type: "image/png" });

function named(template: string, value = SKU): string {
  return template.replace("{variant}", value);
}

/**
 * jsdom decodes nothing, so `Image.onload` never fires and `naturalWidth` is 0.
 * Without this stub every upload would take the "not an image" branch — the same
 * stub `media-uploader.test.tsx` installs, for the same reason.
 */
function stubImageDecoding(): void {
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 1200;
      naturalHeight = 1200;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
}

/**
 * Staged mode is CONTROLLED, so a bare spy would freeze the value at `null` and
 * the "only one survives" assertion would pass against a component that never
 * re-rendered. The harness holds the state the form holds.
 */
function StagedHarness({
  onChange,
}: {
  readonly onChange: (image: StagedImage | null) => void;
}) {
  const [image, setImage] = useState<StagedImage | null>(null);

  return (
    <VariantImageField
      mode="staged"
      variantName={SKU}
      image={image}
      onChange={(next) => {
        setImage(next);
        onChange(next);
      }}
    />
  );
}

function wrap(children: React.ReactNode) {
  const errors: string[] = [];

  render(
    <NextIntlClientProvider locale="es"
      messages={messages}
      onError={(error) => errors.push(error.message)}
    >
      <ToastProvider closeLabel={messages.ui.close}>{children}</ToastProvider>
    </NextIntlClientProvider>,
  );

  return errors;
}

function uploads(): VariantImageUploads & { readonly onAttach: ReturnType<typeof vi.fn> } {
  const onAttach = vi.fn().mockResolvedValue({ ok: true, data: { id: PRODUCT_ID } });

  return {
    productId: PRODUCT_ID,
    onRequestUpload: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        uploadUrl: "https://storage.test/signed",
        objectKey: "products/p1/tee.png",
        publicUrl: "https://cdn.test/tee.png",
        expiresInSeconds: 600,
      },
    }),
    onAttach,
    onRemove: vi.fn().mockResolvedValue({ ok: true, data: { id: PRODUCT_ID } }),
  };
}

let previews = 0;

beforeEach(() => {
  // Braced: an arrow body returning the mock would register it as a teardown
  // callback, and Vitest would invoke it again after every test.
  refresh.mockReset();
  previews = 0;
  URL.createObjectURL = () => `blob:preview-${String((previews += 1))}`;
  URL.revokeObjectURL = () => undefined;
  stubImageDecoding();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<VariantImageField /> — naming", () => {
  it("names the add control after the variant, not after the column", () => {
    wrap(<StagedHarness onChange={vi.fn()} />);

    // The assertion that fails if the label is ever shortened to "Añadir
    // imagen": nine of those down a column tell a screen-reader user nothing
    // about which row they are on.
    expect(
      screen.getByRole("button", { name: named(variant.add) }),
    ).toBeInTheDocument();
  });

  it("names the thumbnail after the variant once there is an image", () => {
    wrap(
      <VariantImageField
        mode="live"
        variantName={SKU}
        variantId={VARIANT_ID}
        asset={ASSET}
        uploads={uploads()}
      />,
    );

    expect(
      screen.getByRole("button", { name: named(variant.change) }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: named(variant.add) })).toBeNull();
  });

  it("supplies every label from the catalogue", async () => {
    const errors = wrap(
      <VariantImageField mode="staged" variantName={SKU} image={null} onChange={vi.fn()} />,
    );

    // Opened, because most of the copy lives inside the dialog: the uploader's
    // own twenty-odd strings are only resolved once it renders.
    await userEvent.click(
      screen.getByRole("button", { name: named(messages.admin.variantImage.add) }),
    );

    expect(errors).toEqual([]);
    expect(
      screen.getByRole("dialog", { name: named(messages.admin.variantImage.title) }),
    ).toBeInTheDocument();
  });
});

describe("<VariantImageField /> — staged", () => {
  it("keeps ONE image however many files are dropped on the variant", async () => {
    const onChange = vi.fn();
    wrap(<StagedHarness onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: named(variant.add) }));
    await userEvent.upload(screen.getByLabelText(/Arrastra una imagen/), [
      png("first.png"),
      png("second.png"),
    ]);

    // A variant has exactly one image, so the second file is dropped rather
    // than queued behind a rule the API would enforce with a unique index.
    const staged = onChange.mock.calls[0]?.[0] as StagedImage | null;
    expect(staged?.file.name).toBe("first.png");
    expect(screen.queryByText("second.png")).toBeNull();
  });

  it("hands the file back rather than uploading it, because there is no product yet", async () => {
    const onChange = vi.fn();
    wrap(<StagedHarness onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: named(variant.add) }));
    await userEvent.upload(screen.getByLabelText(/Arrastra una imagen/), png());

    // The presign endpoint is scoped to a productId that does not exist yet.
    expect(fetch).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("<VariantImageField /> — live", () => {
  it("attaches the object to the VARIANT, not to the product gallery", async () => {
    const deps = uploads();
    wrap(
      <VariantImageField
        mode="live"
        variantName={SKU}
        variantId={VARIANT_ID}
        asset={null}
        uploads={deps}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: named(variant.add) }));
    await userEvent.upload(screen.getByLabelText(/Arrastra una imagen/), png());
    await userEvent.type(screen.getByLabelText(ui.alt), "Camiseta negra, talla M");
    await userEvent.click(screen.getByRole("button", { name: ui.upload }));

    await waitFor(() => expect(deps.onAttach).toHaveBeenCalledTimes(1));
    // Without this id the picture lands in the product gallery, where it would
    // render on every card of a product it only describes one variant of.
    expect(deps.onAttach.mock.calls[0]?.[1]).toMatchObject({
      variantId: VARIANT_ID,
      url: "https://cdn.test/tee.png",
      alt: "Camiseta negra, talla M",
    });
  });
});
