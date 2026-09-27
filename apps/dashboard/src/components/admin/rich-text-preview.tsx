"use client";

import { useId, useMemo } from "react";

import { sanitizeRichText } from "@akai/rich-text";

/**
 * What a product description will actually look like once it is stored.
 *
 * WHY THIS EXISTS AT ALL. The description field accepts HTML now, and an
 * operator typing `<ul><li>` into a plain `<textarea>` has no way to know
 * whether they got it right — or, worse, whether the tag they used survives the
 * policy. A preview is the only honest answer to "what will the shop show?".
 *
 * WHY IT SANITISES RATHER THAN RENDERING WHAT WAS TYPED. A preview that is more
 * permissive than the storefront is a lie in the one direction that matters: it
 * would show an operator their `<img>` or their `<div class="...">` working,
 * and the shop would then drop it silently. `sanitizeRichText` is the SAME
 * function the API applies on write and the storefront applies again at render,
 * so what is drawn here is what is stored and what is served. It is idempotent,
 * so calling it a third time costs one parse and changes nothing.
 *
 * AND IT IS NOT THE ONLY SANITISER. This one exists so the operator can SEE the
 * policy; the API's write-side call is what ENFORCES it. `buildPayload` runs the
 * same function over the value it submits, so the string this component drew and
 * the string that goes on the wire are byte-identical — a preview that sanitised
 * while the form posted the raw value would be a sanitiser in name only.
 *
 * WHY `dangerouslySetInnerHTML` IS CORRECT HERE, given the repo forbids the
 * unguarded form. The value is not the string the operator typed: it is the
 * output of the allowlist policy, which parses the markup with htmlparser2 and
 * re-serialises only the tags and attributes it permits. Rendering it as text
 * instead would show `&lt;p&gt;` where a paragraph belongs, which is exactly the
 * state this component exists to end. Never move this call off `safe`.
 */
export interface RichTextPreviewProps {
  /** The markup as the operator typed it. Sanitised here, never rendered raw. */
  readonly html: string;
  /** Already translated. Names the region. */
  readonly label: string;
  /** Already translated. Shown while there is nothing to draw. */
  readonly emptyLabel: string;
}

export function RichTextPreview({ html, label, emptyLabel }: RichTextPreviewProps) {
  const labelId = useId();

  // MEMOISED on the raw string. This sits inside the largest form in the app,
  // which re-renders on every keystroke in any of its forty controls; parsing
  // 20 kB of markup on each of those is work nobody asked for. The dependency
  // is the input, so a keystroke in the description still re-parses — which is
  // the whole point of a live preview.
  const safe = useMemo(() => sanitizeRichText(html), [html]);

  const empty = safe.trim() === "";

  return (
    // NAMED BY A PARAGRAPH, NOT A HEADING. A heading here would have to claim a
    // level in a document whose sections are `<legend>`s rather than headings,
    // and an `<h3>` under no `<h2>` is a worse answer than no heading at all.
    // `aria-labelledby` may point at any element, so the caption names the
    // region without inventing a hierarchy — and the region role is what makes
    // the preview findable rather than being loose text after a textarea.
    <section aria-labelledby={labelId} className="grid gap-[5px]">
      <p
        id={labelId}
        className="m-0 text-[11px] leading-[1.35] font-medium text-[var(--label-secondary)]"
      >
        {label}
      </p>
      {empty ? (
        <p className="m-0 text-[11px] leading-[1.35] text-[var(--label-tertiary)]">
          {emptyLabel}
        </p>
      ) : (
        <div
          // `rich-preview` carries the element typography, and it has to live in
          // globals.css rather than in arbitrary variants here: the app declares
          // an UNLAYERED `h1, h2, h3 { margin: 0 }`, and an unlayered rule beats
          // any layered utility regardless of specificity — so `[&_h2]:mt-4`
          // would apply cleanly, compile cleanly, and do nothing.
          className="rich-preview max-h-[320px] overflow-y-auto rounded-[var(--r-control)] bg-[var(--bg-grouped)] px-[var(--control-px)] py-[8px] text-[var(--font-body)] text-[var(--label)]"
          dangerouslySetInnerHTML={{ __html: safe }}
        />
      )}
    </section>
  );
}
