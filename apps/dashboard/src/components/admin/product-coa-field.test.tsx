import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";

import { ProductCoaField, type ProductCoaUploads } from "./product-coa-field";
import esMessages from "../../../messages/es.json";

/**
 * The PRODUCT's certificate of analysis control: one PDF per product, with
 * upload, replace, view (a signed URL the API minted on this admin read) and
 * remove — plus the "show it to customers" choice, which is a FORM value saved
 * with the product (the control reports changes, it never saves them).
 *
 * `uploadCoaPdf` (presign → PUT → attach) has its own suite; this one pins what
 * reaches the three actions and what the operator sees.
 */

const refresh = vi.fn();

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

const PRODUCT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNED = "https://s3.test/akai-coa/coa/products/p/k.pdf?X-Amz-Signature=abc";
const t = esMessages.admin.productCoa;

function uploads(overrides: Partial<ProductCoaUploads> = {}): ProductCoaUploads {
  return {
    productId: PRODUCT_ID,
    onRequestUpload: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        uploadUrl: "https://storage.test/signed",
        objectKey: `coa/products/${PRODUCT_ID}/k.pdf`,
        expiresInSeconds: 600,
      },
    }),
    onAttach: vi.fn().mockResolvedValue({ ok: true, data: { id: PRODUCT_ID } }),
    onRemove: vi.fn().mockResolvedValue({ ok: true, data: { id: PRODUCT_ID } }),
    ...overrides,
  };
}

function pdf(bytes = 64, type = "application/pdf") {
  return new File([new Uint8Array(bytes)], "coa.pdf", { type });
}

interface Props {
  readonly uploads?: ProductCoaUploads | undefined;
  readonly coaUrl?: string | null;
  readonly showCoa?: boolean;
  readonly savedShowCoa?: boolean;
  readonly onShowCoaChange?: (checked: boolean) => void;
}

function field(props: Props = {}) {
  // `in`, not a default: `{ uploads: undefined }` means "a product not saved
  // yet", and a destructuring default would silently replace it.
  const u = "uploads" in props ? props.uploads : uploads();
  const { coaUrl = null, showCoa = false, savedShowCoa = false, onShowCoaChange = vi.fn() } = props;
  return (
    <ProductCoaField
      uploads={u}
      coaUrl={coaUrl}
      showCoa={showCoa}
      savedShowCoa={savedShowCoa}
      onShowCoaChange={onShowCoaChange}
    />
  );
}

/** The single file input behind the drop zone and "Replace". */
function fileInput(): HTMLInputElement {
  const input = screen.getByTestId("product-coa-field").querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
  return input;
}

function wrap(children: React.ReactNode) {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {children}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  refresh.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<ProductCoaField /> — no certificate yet", () => {
  it("says there is none, offers a PDF drop zone, and nothing to view or remove", () => {
    wrap(field());

    expect(screen.getByText(t.statusNoFile)).toBeInTheDocument();
    expect(screen.getByText(t.dropTitle)).toBeInTheDocument();
    expect(fileInput()).toHaveAttribute("accept", "application/pdf");
    expect(screen.queryByRole("link", { name: new RegExp(t.view) })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.removeAria })).not.toBeInTheDocument();
    expect(screen.getByText(t.showHintNoFile)).toBeInTheDocument();
  });

  it("explains that a product must be saved before its certificate can be uploaded", () => {
    wrap(field({ uploads: undefined }));

    expect(screen.getByText(t.afterSave)).toBeInTheDocument();
    expect(fileInput()).toBeDisabled();
  });

  it("uploads a PDF against THIS product: presign, PUT, attach, then refresh", async () => {
    const user = userEvent.setup();
    const u = uploads();
    wrap(field({ uploads: u }));

    await user.upload(fileInput(), pdf(2048));

    await waitFor(() => expect(screen.getByText(t.uploadSuccess)).toBeInTheDocument());
    expect(u.onRequestUpload).toHaveBeenCalledWith(PRODUCT_ID, { sizeBytes: 2048 });
    expect(u.onAttach).toHaveBeenCalledWith(PRODUCT_ID, {
      objectKey: `coa/products/${PRODUCT_ID}/k.pdf`,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("refuses a file over 10 MB before asking for a URL", async () => {
    const user = userEvent.setup();
    const u = uploads();
    wrap(field({ uploads: u }));

    await user.upload(fileInput(), pdf(11 * 1024 * 1024));

    expect(await screen.findByText(t.uploadError.tooLarge)).toBeInTheDocument();
    expect(u.onRequestUpload).not.toHaveBeenCalled();
  });

  it("names a failed attach distinctly", async () => {
    const user = userEvent.setup();
    const u = uploads({
      onAttach: vi.fn().mockResolvedValue({ ok: false, code: "VALIDATION_FAILED", reason: null, message: "x" }),
    });
    wrap(field({ uploads: u }));

    await user.upload(fileInput(), pdf());

    expect(await screen.findByText(t.uploadError.attachFailed)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("<ProductCoaField /> — a certificate on file", () => {
  it("links to the current file through the freshly signed URL, in a new tab", () => {
    wrap(field({ coaUrl: SIGNED }));

    const link = screen.getByRole("link", { name: new RegExp(t.view) });
    expect(link).toHaveAttribute("href", SIGNED);
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("button", { name: t.replace })).toBeInTheDocument();
  });

  it("says whether the shop shows it, from the SAVED visibility", () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        {field({ coaUrl: SIGNED, savedShowCoa: false, showCoa: true })}
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(t.statusHidden)).toBeInTheDocument();
    expect(screen.getByText(t.unsaved)).toBeInTheDocument();
    unmount();

    wrap(field({ coaUrl: SIGNED, savedShowCoa: true, showCoa: true }));
    expect(screen.getByText(t.statusVisible)).toBeInTheDocument();
    expect(screen.queryByText(t.unsaved)).not.toBeInTheDocument();
  });

  it("reports the visibility choice to the form and saves nothing itself", async () => {
    const user = userEvent.setup();
    const onShowCoaChange = vi.fn();
    const u = uploads();
    wrap(field({ uploads: u, coaUrl: SIGNED, onShowCoaChange }));

    await user.click(screen.getByRole("checkbox", { name: t.showLabel }));

    expect(onShowCoaChange).toHaveBeenCalledWith(true);
    expect(u.onAttach).not.toHaveBeenCalled();
    expect(u.onRemove).not.toHaveBeenCalled();
  });

  it("replaces the file through the same upload flow", async () => {
    const user = userEvent.setup();
    const u = uploads();
    wrap(field({ uploads: u, coaUrl: SIGNED }));

    await user.upload(fileInput(), pdf());

    await waitFor(() => expect(u.onAttach).toHaveBeenCalledTimes(1));
  });

  it("removes it only after confirming, then refreshes the page's data", async () => {
    const user = userEvent.setup();
    const u = uploads();
    wrap(field({ uploads: u, coaUrl: SIGNED }));

    await user.click(screen.getByRole("button", { name: t.removeAria }));
    expect(u.onRemove).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: t.removeConfirm }));

    await waitFor(() => expect(u.onRemove).toHaveBeenCalledWith(PRODUCT_ID));
    expect(refresh).toHaveBeenCalled();
  });

  it("says so when the remove fails, and does not refresh", async () => {
    const user = userEvent.setup();
    const u = uploads({
      onRemove: vi.fn().mockResolvedValue({ ok: false, code: "NOT_FOUND", reason: null, message: "x" }),
    });
    wrap(field({ uploads: u, coaUrl: SIGNED }));

    await user.click(screen.getByRole("button", { name: t.removeAria }));
    await user.click(await screen.findByRole("button", { name: t.removeConfirm }));

    expect(await screen.findByText(t.removeFailed)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
