import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";

import { ImageDropzone } from "./image-dropzone";
import esMessages from "../../../messages/es.json";

/**
 * The control an operator actually has to understand.
 *
 * Two properties are worth pinning. The input must stay REACHABLE — it is
 * `sr-only` inside the label, and swapping that for `hidden` or `display:none`
 * would silently make image upload mouse-only. And the drag handlers must call
 * `preventDefault`, because without it the browser navigates to the dropped file
 * and the operator loses every field they had filled in.
 */

function renderZone(props: Partial<Parameters<typeof ImageDropzone>[0]> = {}) {
  const onFiles = vi.fn();
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ImageDropzone onFiles={onFiles} {...props} />
    </NextIntlClientProvider>,
  );
  return { onFiles };
}

const png = () => new File([new Uint8Array(8)], "a.png", { type: "image/png" });

describe("<ImageDropzone />", () => {
  it("says what it accepts, rather than 'No file chosen'", () => {
    renderZone();
    expect(screen.getByText(/Arrastra una imagen/)).toBeInTheDocument();
    // The formats and the cap, on screen, before anyone picks a file.
    expect(screen.getByText(/PNG, JPEG o WebP/)).toBeInTheDocument();
    expect(screen.getByText(/15 MB/)).toBeInTheDocument();
  });

  it("keeps the input reachable by its label — not display:none", () => {
    renderZone();
    const input = screen.getByLabelText(/Arrastra una imagen/);
    // A `hidden` input is dropped from the tab order; `sr-only` keeps it.
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input).not.toHaveAttribute("hidden");
    expect(input.className).toContain("sr-only");
  });

  it("passes a picked file to the caller", async () => {
    const { onFiles } = renderZone();
    await userEvent.upload(screen.getByLabelText(/Arrastra una imagen/), png());
    expect(onFiles).toHaveBeenCalled();
  });

  it("accepts a DROPPED file", () => {
    const { onFiles } = renderZone();
    const zone = screen.getByText(/Arrastra una imagen/).closest("label");
    expect(zone).not.toBeNull();

    fireEvent.drop(zone as HTMLElement, { dataTransfer: { files: [png()] } });
    expect(onFiles).toHaveBeenCalled();
  });

  it("preventDefaults the dragover, or the browser navigates away from the form", () => {
    renderZone();
    const zone = screen.getByText(/Arrastra una imagen/).closest("label") as HTMLElement;

    const event = new Event("dragover", { bubbles: true, cancelable: true });
    fireEvent(zone, event);
    // Unprevented, the drop would replace the page with the raw image and every
    // unsaved field would be gone.
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores a drop while disabled", () => {
    const { onFiles } = renderZone({ disabled: true });
    const zone = screen.getByText(/Arrastra una imagen/).closest("label") as HTMLElement;

    fireEvent.drop(zone, { dataTransfer: { files: [png()] } });
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("shows the busy label in place of the prompt", () => {
    renderZone({ busyLabel: "Subiendo…" });
    expect(screen.getByText("Subiendo…")).toBeInTheDocument();
    expect(screen.queryByText(/Arrastra una imagen/)).not.toBeInTheDocument();
  });
});
