import { describe, expect, it } from "vitest";
import {
  RICH_TEXT_ALLOWED_SCHEMES,
  RICH_TEXT_ALLOWED_TAGS,
  sanitizeRichText,
} from "./index";

/**
 * These are not "does the library work" tests — they are the POLICY, asserted.
 *
 * Every case below is a payload an admin-authenticated write could carry today.
 * The threat model is the one `httpUrlSchema` already names: a compromised
 * staff account, whose only prerequisite for stored XSS is a write the system
 * considers legitimate. Each `it` therefore states the attack, not the API.
 */

describe("what is stripped", () => {
  it("removes a script tag AND its contents", () => {
    const output = sanitizeRichText('<p>Safe</p><script>alert("xss")</script>');

    expect(output).not.toContain("script");
    // The sharper half of the assertion. "discard" alone would drop the tag and
    // keep the text, turning a script body into visible page copy — and any
    // downstream surface that re-parsed it would have live source again.
    expect(output).not.toContain("alert");
    expect(output).toBe("<p>Safe</p>");
  });

  it("removes an onerror handler, and every other on* attribute with it", () => {
    const output = sanitizeRichText(
      '<p onerror="alert(1)" onclick="steal()" onmouseover="x()">Text</p>',
    );

    expect(output).toBe("<p>Text</p>");
    expect(output).not.toContain("onerror");
    expect(output).not.toContain("onclick");
    expect(output).not.toContain("onmouseover");
  });

  it("removes a javascript: href, leaving inert anchor text", () => {
    const output = sanitizeRichText('<a href="javascript:alert(1)">Click me</a>');

    expect(output).not.toContain("javascript");
    expect(output).not.toContain("href");
    // The anchor survives without its href: the customer still reads the words
    // the admin wrote, and clicking them does nothing.
    expect(output).toBe("<a>Click me</a>");
  });

  it("removes a data:text/html href", () => {
    const output = sanitizeRichText(
      '<a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">Offer</a>',
    );

    expect(output).not.toContain("data:");
    expect(output).not.toContain("href");
    expect(output).toBe("<a>Offer</a>");
  });

  it("removes a style attribute", () => {
    const output = sanitizeRichText(
      '<p style="position:fixed;top:0;left:0;width:100vw;height:100vh">Overlay</p>',
    );

    expect(output).toBe("<p>Overlay</p>");
    expect(output).not.toContain("style");
    // Not a cosmetic concern: that declaration covers the viewport, so the
    // paragraph sits on top of the real buy button and receives its clicks.
  });

  it("removes class and id, so admin copy cannot re-target the page's own CSS or labels", () => {
    const output = sanitizeRichText('<p class="checkout-cta" id="email">Text</p>');

    expect(output).toBe("<p>Text</p>");
  });

  it("allows exactly the closed accent-divider preset on hr, and nothing else", () => {
    // The one deliberate exception to the class-stripping rule above: a single
    // VALUE-constrained token on `hr` only, the same mechanism `a`'s `target`
    // already uses. The color itself is never admin input.
    expect(sanitizeRichText('<hr class="divider--accent">')).toBe(
      '<hr class="divider--accent" />',
    );
  });

  it("still strips any OTHER class value on hr — the preset is closed, not a class allowlist", () => {
    expect(sanitizeRichText('<hr class="divider--evil">')).toBe("<hr />");
  });

  it("still strips the accent class on every other tag — it is scoped to hr alone", () => {
    const output = sanitizeRichText('<p class="divider--accent">Text</p>');

    expect(output).toBe("<p>Text</p>");
  });

  it("removes an iframe, and the style and noscript tags, contents included", () => {
    const output = sanitizeRichText(
      '<iframe src="https://evil.example"></iframe>' +
        "<style>body{display:none}</style>" +
        "<noscript><img src=x onerror=alert(1)></noscript>" +
        "<p>Copy</p>",
    );

    expect(output).toBe("<p>Copy</p>");
  });

  it("removes an img, because product imagery is typed data and not body copy", () => {
    const output = sanitizeRichText('<p>A<img src="https://tracker.example/p.gif">B</p>');

    expect(output).toBe("<p>AB</p>");
  });

  it("removes a protocol-relative href, which would otherwise inherit the page scheme", () => {
    const output = sanitizeRichText('<a href="//evil.example/x">Link</a>');

    expect(output).toBe("<a>Link</a>");
  });

  it("keeps the text of a disallowed wrapper rather than deleting the admin's copy", () => {
    // `div` is not allowed, but "discard" means the author loses the wrapper,
    // not the sentence — the failure mode of "escape" or a blunt strip.
    expect(sanitizeRichText("<div>Kept</div>")).toBe("Kept");
    expect(sanitizeRichText("<h1>Title</h1>")).toBe("Title");
  });
});

describe("what survives", () => {
  it("keeps the structural and inline formatting a description actually needs", () => {
    const input =
      "<h2>Dosage</h2><p>Take <strong>5 g</strong> daily, ideally <em>post-workout</em>.</p>" +
      "<ul><li>Micronised</li><li>Unflavoured</li></ul>" +
      "<blockquote>Third-party tested.</blockquote><hr />";

    expect(sanitizeRichText(input)).toBe(
      "<h2>Dosage</h2><p>Take <strong>5 g</strong> daily, ideally <em>post-workout</em>.</p>" +
        "<ul><li>Micronised</li><li>Unflavoured</li></ul>" +
        "<blockquote>Third-party tested.</blockquote><hr />",
    );
  });

  it("keeps a data table with its accessibility semantics", () => {
    const input =
      "<table><caption>Per serving</caption><thead><tr>" +
      '<th scope="col">Amino acid</th><th scope="col">mg</th>' +
      '</tr></thead><tbody><tr><td colspan="1">Leucine</td><td>2500</td></tr></tbody></table>';

    const output = sanitizeRichText(input);

    expect(output).toContain('<th scope="col">Amino acid</th>');
    expect(output).toContain('<td colspan="1">Leucine</td>');
    expect(output).toContain("<caption>Per serving</caption>");
  });

  it("keeps an https link and its title", () => {
    const output = sanitizeRichText(
      '<a href="https://akai.shop/coa" title="Certificate">CoA</a>',
    );

    expect(output).toBe('<a href="https://akai.shop/coa" title="Certificate">CoA</a>');
  });

  it("keeps a mailto link", () => {
    expect(sanitizeRichText('<a href="mailto:hola@akai.shop">Email</a>')).toBe(
      '<a href="mailto:hola@akai.shop">Email</a>',
    );
  });
});

describe("links that open a new window", () => {
  it("forces rel=noopener noreferrer onto target=_blank", () => {
    const output = sanitizeRichText(
      '<a href="https://example.com" target="_blank">Study</a>',
    );

    expect(output).toContain('rel="noopener noreferrer"');
    expect(output).toContain('target="_blank"');
  });

  it("overwrites an author-supplied rel that would opt out of the protection", () => {
    const output = sanitizeRichText(
      '<a href="https://example.com" target="_blank" rel="opener">Study</a>',
    );

    expect(output).toContain('rel="noopener noreferrer"');
    expect(output).not.toContain('rel="opener"');
  });

  it("adds no rel when the link stays in the same tab", () => {
    const output = sanitizeRichText('<a href="https://example.com">Study</a>');

    expect(output).not.toContain("rel=");
  });

  it("drops a target that could drive a framing context, leaving no bare attribute", () => {
    const output = sanitizeRichText(
      '<a href="https://example.com" target="_top">Study</a>',
    );

    // Not merely "no _top": no `target` at all. Letting `allowedAttributes`
    // filter the value on its own emits `<a target>` and, worse, adds a rel for
    // a window that will never be opened.
    expect(output).not.toContain("target");
    expect(output).not.toContain("rel");
    expect(output).toBe('<a href="https://example.com">Study</a>');
  });

  it("drops a named target, which a later link could otherwise re-aim", () => {
    expect(sanitizeRichText('<a href="https://example.com" target="shop">S</a>')).toBe(
      '<a href="https://example.com">S</a>',
    );
  });

  it("drops target=_self, which is what absent already means", () => {
    expect(sanitizeRichText('<a href="https://example.com" target="_self">S</a>')).toBe(
      '<a href="https://example.com">S</a>',
    );
  });
});

describe("properties the two call sites depend on", () => {
  it("is idempotent, which is what makes sanitising on write AND on render safe", () => {
    const once = sanitizeRichText('<p>A <a href="javascript:x()">b</a> c</p>');

    expect(sanitizeRichText(once)).toBe(once);
  });

  it("returns empty for empty input rather than throwing", () => {
    expect(sanitizeRichText("")).toBe("");
  });

  it("escapes bare text, so a plain-text description stays plain text", () => {
    // Every description stored before this feature existed is plain text. It
    // must render as the author typed it, with angle brackets escaped rather
    // than interpreted.
    expect(sanitizeRichText("5 g > 3 g & worth it")).toBe("5 g &gt; 3 g &amp; worth it");
  });

  it("exposes the policy as readonly data for an editor toolbar to read", () => {
    expect(RICH_TEXT_ALLOWED_TAGS).toContain("strong");
    expect(RICH_TEXT_ALLOWED_TAGS).not.toContain("script");
    expect(RICH_TEXT_ALLOWED_TAGS).not.toContain("img");
    expect(RICH_TEXT_ALLOWED_SCHEMES).toEqual(["http", "https", "mailto"]);
  });
});
