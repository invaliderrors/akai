import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { RichTextPreview } from "./rich-text-preview";

const LABEL = "Vista previa";
const EMPTY = "Escribe la descripción";

/**
 * The preview is the operator's only view of the sanitiser's policy, so what is
 * asserted here is that it shows the POLICY and not the input: the markup that
 * survives is drawn as markup, and the markup that does not survive is gone —
 * gone, not escaped into visible text, which is the failure mode that makes a
 * "sanitised" preview look like it worked.
 */
describe("<RichTextPreview />", () => {
  it("renders allowed markup as markup rather than as escaped text", () => {
    render(
      <RichTextPreview
        html="<p>Perfil de <strong>aminoácidos</strong></p><ul><li>L-leucina</li></ul>"
        label={LABEL}
        emptyLabel={EMPTY}
      />,
    );

    const region = screen.getByRole("region", { name: LABEL });
    // A real <strong> and a real list item, not a paragraph reading "<strong>".
    expect(region.querySelector("strong")).not.toBeNull();
    expect(screen.getByRole("listitem")).toHaveTextContent("L-leucina");
    expect(screen.queryByText(/<strong>/)).toBeNull();
  });

  it("drops a script tag AND its contents", () => {
    render(
      <RichTextPreview
        html={'<p>Copy</p><script>alert("xss")</script>'}
        label={LABEL}
        emptyLabel={EMPTY}
      />,
    );

    const region = screen.getByRole("region", { name: LABEL });
    expect(region.querySelector("script")).toBeNull();
    // The CONTENTS go too. A stripped tag whose body becomes the visible text
    // `alert("xss")` would look sanitised and read as a bug report from a
    // customer — and would be live again the moment the copy is pasted anywhere
    // that re-parses it.
    expect(region).not.toHaveTextContent("alert");
    expect(region).toHaveTextContent("Copy");
  });

  it("strips an event handler and a javascript: link but keeps the copy", () => {
    render(
      <RichTextPreview
        html={'<p onmouseover="steal()">Hover</p><a href="javascript:alert(1)">Click</a>'}
        label={LABEL}
        emptyLabel={EMPTY}
      />,
    );

    const region = screen.getByRole("region", { name: LABEL });
    expect(region.querySelector("[onmouseover]")).toBeNull();
    expect(region.querySelector("a[href]")).toBeNull();
    expect(region).toHaveTextContent("Hover");
  });

  it("keeps the closed accent-divider preset, so the preview matches the real page", () => {
    // Item 2 Track B: the preview shares the exact sanitiser the storefront
    // runs, so the one class this policy allows on `hr` must survive here too
    // — otherwise this dialog would show a plain gray line for the one markup
    // the insert-separator button actually produces.
    render(
      <RichTextPreview
        html='<p>Copy</p><hr class="divider--accent"><p>More</p>'
        label={LABEL}
        emptyLabel={EMPTY}
      />,
    );

    const region = screen.getByRole("region", { name: LABEL });
    expect(region.querySelector("hr.divider--accent")).not.toBeNull();
  });

  it("says there is nothing to show rather than drawing an empty box", () => {
    render(<RichTextPreview html="   " label={LABEL} emptyLabel={EMPTY} />);

    expect(screen.getByText(EMPTY)).toBeInTheDocument();
  });

  it("says there is nothing to show when everything typed was stripped", () => {
    // The operator typed something, and none of it survived. An empty panel
    // would read as "the preview is broken"; the empty sentence reads as "none
    // of that is allowed", which is the true statement.
    render(
      <RichTextPreview html="<script>alert(1)</script>" label={LABEL} emptyLabel={EMPTY} />,
    );

    expect(screen.getByText(EMPTY)).toBeInTheDocument();
  });

  it("escapes bare text, so a plain-text description still reads as typed", () => {
    // Every description written before this field accepted HTML is plain text,
    // and it is now parsed as markup. "10 < 20" must not vanish into a tag that
    // was never opened.
    render(<RichTextPreview html="10 < 20 mg" label={LABEL} emptyLabel={EMPTY} />);

    expect(screen.getByRole("region", { name: LABEL })).toHaveTextContent("10 < 20 mg");
  });
});
