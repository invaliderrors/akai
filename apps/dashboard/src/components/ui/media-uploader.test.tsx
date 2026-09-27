import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  MediaUploader,
  type MediaUploaderLabels,
  type ProductMediaItem,
  type StagedImage,
} from "./media-uploader";
import { TOAST_DWELL_MS, ToastProvider } from "./toast";
import esMessages from "../../../messages/es.json";

/**
 * ONE uploader, so ONE test file — merged from `product-media-manager.test.tsx`
 * and the staged picker's coverage.
 *
 * The properties worth pinning are the ones no screenshot would catch. The
 * upload is a THREE-STEP dance across two hosts — presign here, PUT to storage,
 * record here — and the ordering is the part that goes silently wrong: attaching
 * before the bytes land produces a product row pointing at a 404. Alt text is
 * required in BOTH locales because `attach` is the only route that can carry it
 * and there is no route that adds it later. And a removal has to be reversible
 * for as long as the toast says it is, which means the write has to WAIT rather
 * than be undone.
 */

const IMAGE = { width: 800, height: 600 };

const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const media = esMessages.admin.productMedia;

/**
 * Every string is a prop, so the fixture is where the copy lives.
 *
 * The leaves that already exist are read from the catalogue rather than retyped,
 * so a reworded error is caught here; the handful this component adds are
 * literals until the message-catalogue item that owns `admin.productMedia`
 * lands.
 */
const labels: MediaUploaderLabels = {
  empty: media.empty,
  stagedHint: media.stagedHint,
  primary: media.primary,
  remove: (name) => `Quitar ${name}`,
  removed: "Imagen quitada.",
  undo: "Deshacer",
  reorder: ({ name, index, total }) => `Reordenar ${name} (${String(index)} de ${String(total)})`,
  select: (name) => `Editar el texto alternativo de ${name}`,
  uploading: media.uploading,
  saving: "Guardando…",
  upload: "Subir",
  altHeading: "Texto alternativo",
  altEs: media.altEs,
  altEn: media.altEn,
  altRequired: "Falta el texto alternativo.",
  errors: { ...media.errors, reorderFailed: "No hemos podido cambiar el orden." },
};

/**
 * jsdom does not decode images, so `naturalWidth` is 0 and `onload` never fires.
 * Stubbing the constructor is what lets the measure step be exercised at all —
 * without it every test would hit the "not an image" branch.
 */
function stubImageDecoding(succeeds = true): void {
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = IMAGE.width;
      naturalHeight = IMAGE.height;
      set src(_value: string) {
        queueMicrotask(() => (succeeds ? this.onload?.() : this.onerror?.()));
      }
    },
  );
}

const png = (bytes = 1024, name = "tee.png") =>
  new File([new Uint8Array(bytes)], name, { type: "image/png" });

function wrap(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ToastProvider closeLabel="Cerrar">{children}</ToastProvider>
    </NextIntlClientProvider>
  );
}

/**
 * Staged mode is CONTROLLED, so a spy alone would freeze the list at its initial
 * value and every reorder or undo assertion would pass against a component that
 * never re-rendered. The harness holds the state the create form holds.
 */
function StagedHarness({
  initial,
  onChange,
}: {
  readonly initial: readonly StagedImage[];
  readonly onChange: (images: readonly StagedImage[]) => void;
}) {
  const [images, setImages] = useState(initial);
  return (
    <MediaUploader
      mode="staged"
      images={images}
      labels={labels}
      onChange={(next) => {
        setImages(next);
        onChange(next);
      }}
    />
  );
}

function stagedImage(name: string, preview: string): StagedImage {
  return { file: png(64, name), previewUrl: preview, altEs: "", altEn: "" };
}

function renderStaged(initial: readonly StagedImage[] = []) {
  const onChange = vi.fn();
  render(wrap(<StagedHarness initial={initial} onChange={onChange} />));
  return { onChange };
}

/**
 * Overrides are typed as mocks rather than as `Partial<MediaUploaderProps>`: a
 * partial of the mode union widens `mode` back to both arms, which is exactly
 * the mistake the union's `?: undefined` guards exist to catch.
 */
interface LiveOverrides {
  readonly items?: readonly ProductMediaItem[];
  readonly onRequestUpload?: Mock;
  readonly onRemove?: Mock;
  readonly onReorder?: Mock;
}

function renderLive(overrides: LiveOverrides = {}) {
  const onRequestUpload =
    overrides.onRequestUpload ??
    vi.fn().mockResolvedValue({
      ok: true,
      data: {
        uploadUrl: "https://storage.test/signed",
        objectKey: "products/p1/a.png",
        publicUrl: "https://cdn.test/a.png",
        expiresInSeconds: 600,
      },
    });
  const onAttach = vi.fn().mockResolvedValue({ ok: true, data: { id: "p1" } });
  const onRemove = overrides.onRemove ?? vi.fn().mockResolvedValue({ ok: true, data: { id: "p1" } });

  render(
    wrap(
      <MediaUploader
        mode="live"
        productId="p1"
        items={overrides.items ?? []}
        labels={labels}
        onRequestUpload={onRequestUpload}
        onAttach={onAttach}
        onRemove={onRemove}
        {...(overrides.onReorder === undefined ? {} : { onReorder: overrides.onReorder })}
      />,
    ),
  );

  return { onRequestUpload, onAttach, onRemove };
}

function item(id: string, sortOrder: number, url = `https://cdn.test/${id}.png`): ProductMediaItem {
  return { id, url, alt: { es: "Frente", en: "Front" }, width: 10, height: 10, sortOrder };
}

/**
 * Found by its LABEL, not by a test id. The input is `sr-only` inside the
 * dropzone label, and if that association ever broke the control would be
 * mouse-only — so this query failing is a real accessibility regression, not a
 * brittle selector.
 */
function dropzone(): HTMLElement {
  return screen.getByLabelText(/Arrastra una imagen/);
}

/** Pick, name in both locales, commit. The whole live path in one call. */
async function uploadOne(file = png()): Promise<void> {
  await userEvent.upload(dropzone(), file);
  await userEvent.type(screen.getByLabelText(media.altEs), "Camiseta de frente");
  await userEvent.type(screen.getByLabelText(media.altEn), "Tee, front");
  await userEvent.click(screen.getByRole("button", { name: labels.upload }));
}

let previews = 0;

beforeEach(() => {
  refresh.mockReset();
  previews = 0;
  // Assigned rather than `vi.stubGlobal("URL", {...URL})`: spreading the class
  // loses its construct signature, and the component parses a stored image's URL
  // to recover the file name an operator recognises.
  URL.createObjectURL = () => `blob:preview-${String(++previews)}`;
  URL.revokeObjectURL = () => undefined;
  stubImageDecoding();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<MediaUploader mode='staged' />", () => {
  it("says what will happen to files chosen before the product exists", () => {
    renderStaged();
    expect(screen.getByText(media.stagedHint)).toBeInTheDocument();
    expect(screen.getByText(media.empty)).toBeInTheDocument();
  });

  it("hands a picked file up as a staged image rather than uploading it", async () => {
    const { onChange } = renderStaged();
    await userEvent.upload(dropzone(), png(64, "frente.png"));

    // No product id exists yet, so no presign can be issued — nothing may reach
    // the network.
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    const added = onChange.mock.calls[0]?.[0] as readonly StagedImage[];
    expect(added).toHaveLength(1);
    expect(added[0]?.file.name).toBe("frente.png");
  });

  it("marks the first tile as the primary image", () => {
    renderStaged([stagedImage("a.png", "blob:a"), stagedImage("b.png", "blob:b")]);
    // One marker, not two: the storefront shows the LOWEST sortOrder.
    expect(screen.getAllByText(media.primary)).toHaveLength(1);
  });

  it("flags a missing English alt as a field error, not a silent gap", async () => {
    renderStaged([stagedImage("a.png", "blob:a")]);

    await userEvent.type(screen.getByLabelText(media.altEs), "Camiseta de frente");

    const english = screen.getByLabelText(media.altEn);
    expect(english).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(labels.altRequired);

    await userEvent.type(english, "Tee, front");
    // Clears the moment the rule passes — no second blur required.
    expect(english).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reorders from the grip handle, by keyboard", async () => {
    renderStaged([stagedImage("a.png", "blob:a"), stagedImage("b.png", "blob:b")]);

    const grip = screen.getByRole("button", { name: labels.reorder({ name: "a.png", index: 1, total: 2 }) });
    await userEvent.click(grip);
    fireEvent.keyDown(grip, { key: "ArrowRight" });

    // A pointer-only reorder is the usual way a drag list becomes unusable, so
    // the handle is a real button and the arrows are the drag.
    const names = screen.getAllByRole("button", { name: /Editar el texto alternativo/ }).map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual([labels.select("b.png"), labels.select("a.png")]);
  });

  it("carries the primary marker with the tile that moved", async () => {
    renderStaged([stagedImage("a.png", "blob:a"), stagedImage("b.png", "blob:b")]);
    const grip = screen.getByRole("button", { name: labels.reorder({ name: "a.png", index: 1, total: 2 }) });
    fireEvent.keyDown(grip, { key: "ArrowRight" });

    const tiles = screen.getAllByRole("listitem");
    expect(tiles[0]).toHaveTextContent("b.png");
    expect(tiles[0]).toHaveTextContent(media.primary);
  });

  it("offers an undo that puts a removed image back where it was", async () => {
    renderStaged([stagedImage("a.png", "blob:a"), stagedImage("b.png", "blob:b")]);

    await userEvent.click(screen.getByRole("button", { name: labels.remove("a.png") }));
    expect(screen.queryByRole("button", { name: labels.select("a.png") })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: labels.undo }));

    const names = screen.getAllByRole("button", { name: /Editar el texto alternativo/ }).map((el) => el.getAttribute("aria-label"));
    // Back at index 0, not appended: the primary image is the first one.
    expect(names).toEqual([labels.select("a.png"), labels.select("b.png")]);
  });

  it("does not carry the live list's test id", () => {
    renderStaged([stagedImage("a.png", "blob:a")]);
    expect(document.querySelector('[data-testid="product-media-list"]')).toBeNull();
  });
});

describe("<MediaUploader mode='live' />", () => {
  it("keeps the list id the product page's test reads", () => {
    renderLive({ items: [item("m1", 0)] });
    expect(screen.getByTestId("product-media-list")).toBeInTheDocument();
  });

  it("names a stored image by its file, not its uuid", () => {
    renderLive({ items: [item("m1", 0, "https://cdn.test/camiseta-front.jpg")] });
    expect(screen.getByRole("button", { name: labels.select("camiseta-front.jpg") })).toBeInTheDocument();
  });

  it("PUTs the file straight to storage, not through this app", async () => {
    renderLive();
    await uploadOne();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    // The signed URL, and no Authorization header — the URL carries its own
    // authority and the admin bearer must never reach the browser.
    expect(url).toBe("https://storage.test/signed");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("attaches only AFTER the bytes are stored", async () => {
    const { onAttach } = renderLive();
    await uploadOne();

    await waitFor(() => expect(onAttach).toHaveBeenCalled());
    const uploadOrder = vi.mocked(globalThis.fetch).mock.invocationCallOrder[0] ?? 0;
    const attachOrder = onAttach.mock.invocationCallOrder[0] ?? 0;
    // Attaching first would record a URL that 404s until the PUT lands.
    expect(uploadOrder).toBeLessThan(attachOrder);
  });

  it("sends the measured dimensions, which the API requires", async () => {
    const { onAttach } = renderLive();
    await uploadOne();

    await waitFor(() => expect(onAttach).toHaveBeenCalled());
    expect(onAttach.mock.calls[0]?.[1]).toMatchObject(IMAGE);
  });

  it("sends BOTH locales of alt text with the only call that can carry them", async () => {
    const { onAttach } = renderLive();
    await uploadOne();

    await waitFor(() => expect(onAttach).toHaveBeenCalled());
    expect(onAttach.mock.calls[0]?.[1]).toMatchObject({
      alt: { es: "Camiseta de frente", en: "Tee, front" },
    });
  });

  it("will not upload until both locales are named", async () => {
    renderLive();
    await userEvent.upload(dropzone(), png());

    const commit = screen.getByRole("button", { name: labels.upload });
    expect(commit).toBeDisabled();

    await userEvent.type(screen.getByLabelText(media.altEs), "Camiseta de frente");
    // Still short one locale — there is no route that adds alt text later.
    expect(commit).toBeDisabled();

    await userEvent.type(screen.getByLabelText(media.altEn), "Tee, front");
    expect(commit).toBeEnabled();
  });

  it("appends rather than displacing the primary image", async () => {
    const { onAttach } = renderLive({ items: [item("m1", 0), item("m2", 1)] });
    await uploadOne();

    await waitFor(() => expect(onAttach).toHaveBeenCalled());
    // The storefront shows the LOWEST sortOrder, so a new upload must not
    // silently become the product's main image.
    expect(onAttach.mock.calls[0]?.[1]).toMatchObject({ sortOrder: 2 });
  });

  it("does NOT upload a file the browser cannot decode", async () => {
    stubImageDecoding(false);
    const { onRequestUpload } = renderLive();
    await uploadOne(new File(["not an image"], "evil.png", { type: "image/png" }));

    // Refused before a URL is even requested: a MIME type is a claim, not proof.
    await screen.findByRole("alert");
    expect(onRequestUpload).not.toHaveBeenCalled();
  });

  it("does NOT upload a file over the size limit", async () => {
    const { onRequestUpload } = renderLive();
    await uploadOne(png(16 * 1024 * 1024));

    expect(await screen.findByRole("alert")).toHaveTextContent("15 MB");
    expect(onRequestUpload).not.toHaveBeenCalled();
  });

  it("does not attach when the storage PUT fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    const { onAttach } = renderLive();
    await uploadOne();

    await screen.findByRole("alert");
    // Recording a URL for bytes that never arrived is the one outcome worth
    // preventing here.
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("shows a translated failure, never a server message", async () => {
    const { onAttach } = renderLive({
      onRequestUpload: vi.fn().mockResolvedValue({
        ok: false,
        code: "FORBIDDEN",
        reason: null,
        message: "S3 credentials rejected",
      }),
    });
    await uploadOne();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(media.errors.signFailed);
    expect(alert).not.toHaveTextContent("S3 credentials");
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("refreshes from the server so the new image appears", async () => {
    renderLive();
    await uploadOne();

    // The page is server-rendered; without this the upload would not show.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("draws no grip when there is nothing to persist a new order to", () => {
    renderLive({ items: [item("m1", 0), item("m2", 1)] });
    // The API exposes presign, attach and delete — and no reorder. A handle
    // that moves a tile the next render puts back is a lie about saved state.
    expect(screen.queryAllByRole("button", { name: /Reordenar/ })).toHaveLength(0);
  });

  it("draws grips, and persists the new order, when it can", async () => {
    const onReorder = vi.fn().mockResolvedValue({ ok: true, data: { id: "p1" } });
    renderLive({ items: [item("m1", 0), item("m2", 1)], onReorder });

    const grip = screen.getByRole("button", { name: /Reordenar m1\.png \(1 de 2\)/ });
    fireEvent.keyDown(grip, { key: "ArrowRight" });

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith("p1", ["m2", "m1"]));
    // Optimistic: the tiles move before the refresh lands, or the handle feels
    // broken for a round trip.
    const tiles = screen.getAllByRole("listitem");
    expect(tiles[0]).toHaveTextContent("m2.png");
  });
});

describe("<MediaUploader mode='live' /> removal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("defers the delete for the length of the undo window", async () => {
    const { onRemove } = renderLive({ items: [item("m1", 0)] });

    fireEvent.click(screen.getByRole("button", { name: labels.remove("m1.png") }));

    // Gone from the grid immediately, and NOT yet gone from the server: the API
    // can delete a media row and cannot resurrect one, so the undo has to be a
    // request that never went rather than a reversal.
    expect(screen.queryByRole("button", { name: labels.select("m1.png") })).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();

    await advance(TOAST_DWELL_MS + 100);
    expect(onRemove).toHaveBeenCalledWith("p1", "m1");
  });

  it("cancels the delete outright when the undo is pressed", async () => {
    const { onRemove } = renderLive({ items: [item("m1", 0)] });

    fireEvent.click(screen.getByRole("button", { name: labels.remove("m1.png") }));
    fireEvent.click(screen.getByRole("button", { name: labels.undo }));

    expect(screen.getByRole("button", { name: labels.select("m1.png") })).toBeInTheDocument();

    await advance(TOAST_DWELL_MS * 2);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("puts the image back when the deferred delete fails", async () => {
    const { onRemove } = renderLive({
      items: [item("m1", 0)],
      onRemove: vi.fn().mockResolvedValue({ ok: false, code: "CONFLICT", reason: null, message: "in use" }),
    });

    fireEvent.click(screen.getByRole("button", { name: labels.remove("m1.png") }));
    await advance(TOAST_DWELL_MS + 100);

    expect(onRemove).toHaveBeenCalled();
    // A failed delete that left the tile hidden would read as success.
    expect(screen.getByRole("button", { name: labels.select("m1.png") })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(media.errors.removeFailed);
  });
});
