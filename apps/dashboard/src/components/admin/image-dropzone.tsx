"use client";

import { useId, useState, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { ACCEPTED_IMAGE_TYPES } from "@/lib/admin/upload-product-image";
import { Icon } from "@/components/ui/icon";

/**
 * The file control for product images.
 *
 * A native `<input type="file">` renders as a browser-chrome button whose label
 * an operator cannot read ("No file chosen"), whose hit area is a few dozen
 * pixels, and which says nothing about what it accepts. This wraps it in a
 * target that states the formats and the size cap, and accepts a drop.
 *
 * THE INPUT IS STILL THERE, and that matters. It is `sr-only`, NOT
 * `display: none` — a hidden-by-display input is removed from the tab order, so
 * the control becomes mouse-only. Wrapping it in the `<label>` is what makes the
 * whole area click through to it natively, with no JavaScript and no `ref`.
 * `focus-within` then paints the same ring the input would have had.
 *
 * That ring is now `--focus-ring` as a box-shadow rather than a bespoke outline,
 * which is the ONE reason its spelling changed: the input inside is 1px and
 * clipped, so its own `:focus-visible` outline is invisible by construction and
 * this shadow is the only focus indicator a keyboard operator ever sees.
 */

export interface ImageDropzoneProps {
  readonly onFiles: (files: FileList | null) => void;
  readonly disabled?: boolean;
  readonly multiple?: boolean;
  /** Bumped by the caller to clear the input so the same file can be re-picked. */
  readonly resetKey?: number;
  /** Replaces the prompt while an upload is in flight. */
  readonly busyLabel?: string | undefined;
}

export function ImageDropzone({
  onFiles,
  disabled = false,
  multiple = false,
  resetKey = 0,
  busyLabel,
}: ImageDropzoneProps) {
  const t = useTranslations("admin.productMedia");
  const describedBy = useId();
  const [dragging, setDragging] = useState(false);

  function handleDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    onFiles(event.dataTransfer.files);
  }

  const busy = busyLabel !== undefined && busyLabel !== "";

  return (
    <label
      onDragOver={(event) => {
        // Without preventDefault the browser navigates to the dropped file,
        // which loses the operator's whole form.
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      aria-describedby={describedBy}
      className={[
        "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--r-card)] border-[1.5px] border-dashed px-6 py-8 text-center transition",
        "focus-within:shadow-[0_0_0_4px_var(--focus-ring)]",
        disabled
          ? "cursor-not-allowed border-[var(--separator-weak)] bg-[var(--bg-grouped)] opacity-60"
          : dragging
            ? // Accent is the interaction token, and a live drop target is the
              // one moment this control is being interacted with.
              "border-[var(--accent)] bg-[var(--accent-tint)]"
            : "border-[var(--separator)] bg-[var(--bg-grouped)] hover:border-[var(--accent)] hover:bg-[var(--fill-tertiary)]",
      ].join(" ")}
    >
      {/* The shared registry rather than a hand-drawn arrow: the kit ships no
          upload glyph because the artboards draw this control with `plus` in
          accent, and a second inline SVG is how a set drifts. Decorative — the
          prompt below it carries the meaning. */}
      <Icon name="plus" size={18} className="text-[var(--accent)]" />

      <span className="text-[13px] font-medium text-[var(--label)]">
        {busy ? busyLabel : t("dropzoneTitle")}
      </span>
      <span id={describedBy} className="text-[11px] text-[var(--label-secondary)]">
        {t("dropzoneHint")}
      </span>

      {/* sr-only, never `hidden`: it must stay focusable and it is what the
          surrounding label activates. */}
      <input
        key={resetKey}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => onFiles(event.target.files)}
        className="sr-only"
      />
    </label>
  );
}
