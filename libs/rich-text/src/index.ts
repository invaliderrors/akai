/**
 * @akai/rich-text — THE answer to "what HTML is allowed?", asked once.
 *
 * Product descriptions are `z.string().max(20_000)` in the contract, and the
 * day an admin gains a rich-text editor that string stops being copy and starts
 * being MARKUP WE EXECUTE IN A CUSTOMER'S BROWSER. This module is the only
 * place that decides what survives that trip.
 *
 * WHY IT IS A SHARED LIB AND NOT PART OF libs/contracts. Sanitising needs a
 * parser, so it needs a dependency; `libs/contracts` is `type:contract` and
 * `onlyDependOnLibsWithTags: []` — it may depend on nothing but zod, precisely
 * so it stays importable from a browser bundle. Putting the policy there would
 * mean either weakening that constraint or hand-rolling a parser. It is not in
 * `libs/db` either: that is `scope:server`, and a `scope:web` project importing
 * it is a lint error, which would leave the storefront unable to defend itself
 * at render. `scope:shared` is the one tag both `scope:web` and `scope:server`
 * may depend on, so it is the only tag under which ONE policy can be shared.
 *
 * BOTH SIDES CALL IT, AND THAT IS NOT REDUNDANT.
 *   - The API sanitises ON WRITE, and that copy is authoritative: what is in
 *     the column is already safe, so every consumer that ever reads it — a
 *     future email template, a PDF, an app — inherits the guarantee without
 *     having to know this module exists.
 *   - The storefront sanitises AGAIN at render. Rows predating this change were
 *     written with no policy at all, a direct database edit bypasses the API
 *     entirely, and the policy itself may tighten after content is stored.
 * Neither one alone is sufficient; this is the same defence-in-depth reasoning
 * that made `httpUrlSchema` exist twice.
 *
 * WHY sanitize-html AND NOT isomorphic-dompurify. DOMPurify needs a DOM, so the
 * isomorphic wrapper pulls jsdom in as a RUNTIME dependency — a second copy of
 * jsdom next to the one vitest already carries as a devDependency, shipped to
 * production to sanitise a paragraph of marketing copy. sanitize-html parses
 * with htmlparser2 and needs no DOM at all. Do not hand-roll a replacement: a
 * regex-based stripper is the canonical way to ship an XSS hole that reviews
 * clean.
 *
 * WHERE IT RUNS. Nothing here touches `window`, so it is valid in a client
 * component — but the parser is not free, and every caller today is a server
 * component or a Nest service. Sanitise where the data is fetched and pass the
 * result down as a prop rather than shipping the parser to a phone.
 */

import sanitizeHtml from "sanitize-html";

/**
 * The tags a marketing description may use.
 *
 * NARROW ON PURPOSE — this is a product decision, not a technical default.
 * Structure and inline emphasis are what long-form copy actually needs, so
 * those are here; anything that EXECUTES or LOADS is not, and there is no
 * configuration that turns it back on.
 *
 * Notable deliberate omissions:
 *   - `script`, `style`, `iframe`, `object`, `embed`, `form`, `input`,
 *     `noscript`: the entire executing/loading/credential-collecting surface.
 *   - `img`: a product's images belong to `product.media`, which is typed,
 *     ordered and carries per-locale alt text. An `<img>` in body copy is an
 *     un-alt-texted, un-optimised, third-party-hosted asset request initiated
 *     by whoever wrote the description — an outbound beacon with a picture
 *     attached.
 *   - `h1`: the page renders the product name as the one `h1`. A second one in
 *     body copy breaks the document outline for screen readers and for search.
 *   - `span`, `div`: with no `class` or `style` allowed they carry nothing, and
 *     an empty wrapper is exactly the foothold a future "just allow class"
 *     change grows from.
 *
 * TABLES ARE IN, and that is a judgement call worth stating: this is a
 * supplements store, and an amino-acid profile or a per-serving breakdown is a
 * table. Faking one with paragraphs would cost the semantics that make it
 * readable aloud.
 */
export const RICH_TEXT_ALLOWED_TAGS: readonly string[] = [
  // Block structure
  "p",
  "br",
  "hr",
  "h2",
  "h3",
  "h4",
  "blockquote",
  // Lists
  "ul",
  "ol",
  "li",
  // Tables
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  // Inline formatting
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "sub",
  "sup",
  "small",
  "a",
];

/**
 * The protocols a link may use. Everything absent from this list is not merely
 * unrendered — the `href` is DROPPED, leaving inert anchor text.
 *
 * `javascript:` is the obvious one. `data:` is the one that gets forgotten:
 * `data:text/html,<script>…</script>` is a same-origin document in some
 * navigation contexts, which is stored XSS with an extra step. Both are absent
 * here rather than blocklisted, because an allowlist cannot be defeated by a
 * scheme nobody thought to enumerate (`vbscript:`, `blob:`, `filesystem:`).
 *
 * sanitize-html's own default also permits `ftp` and `tel`; neither has a
 * reason to appear in a product description, so both are dropped.
 */
export const RICH_TEXT_ALLOWED_SCHEMES: readonly string[] = ["http", "https", "mailto"];

/**
 * Attributes, per tag. Anything not listed is stripped, which is what disposes
 * of the entire `on*` event-handler family (`onerror`, `onclick`, `onload`, …)
 * without enumerating it — an allowlist cannot miss a handler that ships in a
 * future HTML revision.
 *
 * `style` IS ABSENT DELIBERATELY. It is not merely a styling concern: a style
 * attribute can position an element over the page's own controls and can load
 * remote resources through `url()`. The description renders inside a typographic
 * scope owned by the storefront's own CSS; admin copy supplies structure, the
 * design system supplies appearance. `class` and `id` are absent for the same
 * reason, plus a second one — an admin-chosen `id` can collide with a real one
 * and silently re-target a label or a fragment link.
 *
 * `rel` IS LISTED BUT IS NOT ADMIN INPUT. sanitize-html filters attributes
 * AFTER `transformTags` runs, so a `rel` the transform below adds would itself
 * be stripped if the name were not allowed here. The transform overwrites or
 * removes it unconditionally, so the value that survives is always ours.
 */
export const RICH_TEXT_ALLOWED_ATTRIBUTES: Readonly<
  Record<string, readonly sanitizeHtml.AllowedAttribute[]>
> = {
  a: [
    "href",
    "title",
    // Constrained by VALUE, not just by name: `_parent` and `_top` can drive
    // navigation of a framing context, and an arbitrary string opens a named
    // window that later links can silently re-target.
    //
    // THIS IS THE SECOND LINE OF DEFENCE, NOT THE FIRST — `forceSafeLinkRel`
    // below has already removed any other value. It has to, because this filter
    // drops the VALUE and leaves the bare attribute: given `target="_top"` it
    // emits `<a target>`, which is `target=""`. Harmless in a browser, but it
    // proves the filter runs AFTER the transform, so the transform cannot rely
    // on it having cleaned the value first.
    { name: "target", values: ["_blank"] },
    "rel",
  ],
  // Table semantics only. These are what make a data table navigable in a
  // screen reader; they carry no URL and no script.
  th: ["colspan", "rowspan", "scope"],
  td: ["colspan", "rowspan"],
  // EXACTLY ONE closed preset, not `class` in general. Constrained by VALUE,
  // the same mechanism `a`'s `target` already uses above: `divider--accent` is
  // the only string this survives with, so an admin cannot smuggle an
  // arbitrary class name onto the page looking for a selector to exploit. The
  // color itself is never admin input — it is resolved by the storefront's own
  // CSS variable, wherever `.rich-text hr.divider--accent` (and the dashboard
  // preview's matching rule) is defined. `style` stays absent for every tag,
  // `hr` included: this preset is the sanctioned way to get a colored divider
  // without reopening that hole.
  hr: [{ name: "class", values: ["divider--accent"] }],
};

/**
 * Normalise a link's `target`, and force `rel="noopener noreferrer"` when it
 * opens a new window.
 *
 * Without `noopener`, the opened page receives a live `window.opener` handle
 * and can navigate the tab it came from to a page of its choosing — reverse
 * tabnabbing, in which the customer switches back to what looks like our site
 * and is asked to sign in again. Modern browsers imply `noopener` for
 * `target="_blank"`, but "modern browsers do it" is not a policy, and the
 * `noreferrer` half (which also suppresses the referrer header) is not implied.
 *
 * `_blank` IS THE ONLY TARGET THAT SURVIVES. `_parent` and `_top` navigate a
 * framing context; a bare name (`target="shop"`) opens a window that any later
 * link can silently re-target; and `_self` is what absent already means, so
 * keeping it would only be markup noise. Everything else is deleted here rather
 * than left to `allowedAttributes`, because that filter runs after this
 * transform and strips only the value — it would leave `<a target>` behind, and
 * this function would already have added a `rel` for a target that is about to
 * be emptied.
 *
 * Any incoming `rel` is discarded first, so an admin cannot supply `rel=""` or
 * `rel="opener"` and talk the browser back out of the protection.
 */
function forceSafeLinkRel(tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  const next: sanitizeHtml.Attributes = {};

  for (const [name, value] of Object.entries(attribs)) {
    const lowered = name.toLowerCase();
    // `rel` is ours to set, and `target` is re-added below only if it is the one
    // value we accept.
    if (lowered !== "rel" && lowered !== "target") {
      next[name] = value;
    }
  }

  if (attribs["target"] === "_blank") {
    next["target"] = "_blank";
    next["rel"] = "noopener noreferrer";
  }

  return { tagName, attribs: next };
}

/**
 * The assembled policy. Kept private: a caller that can pass its own options is
 * a caller that can answer "what HTML is allowed?" differently, which is the
 * one thing this module exists to prevent.
 */
const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  // Spread because sanitize-html's option types are mutable arrays while the
  // exported constants are readonly — the exports are for tests and for an
  // admin editor's toolbar, and neither should be able to edit the policy.
  allowedTags: [...RICH_TEXT_ALLOWED_TAGS],
  allowedAttributes: Object.fromEntries(
    Object.entries(RICH_TEXT_ALLOWED_ATTRIBUTES).map(([tag, attributes]) => [
      tag,
      [...attributes],
    ]),
  ),
  allowedSchemes: [...RICH_TEXT_ALLOWED_SCHEMES],

  // Pinned to `href`, the only URL-bearing attribute the policy allows. The
  // library's default applies scheme checks to twenty attribute names, which
  // reads as broader protection and is actually just dead configuration here —
  // and dead configuration is what people trim when they do not know why it is
  // there.
  allowedSchemesAppliedToAttributes: ["href"],

  // `//evil.example/x` inherits the PAGE's scheme and so passes any check that
  // only looks at the declared protocol — there isn't one. A link in a product
  // description has no reason to be scheme-relative; make it say https.
  allowProtocolRelative: false,

  // "discard" drops a disallowed TAG but keeps the text inside it, so an
  // admin's `<div>` wrapper loses the div and not the paragraph they wrote.
  disallowedTagsMode: "discard",

  // The exception to that, and the reason `<script>alert(1)</script>` does not
  // become the visible text `alert(1)`: for these tags the CONTENT is dropped
  // along with the tag. The library's default list is restated with `noscript`
  // added — its content is markup that becomes live the moment it is copied
  // into a context with scripting disabled.
  nonTextTags: ["script", "style", "textarea", "option", "xmp", "noscript"],

  // False (the library default, restated because it matters): a description is
  // a FRAGMENT with no `<html>` element, and enforcing an html boundary on a
  // fragment discards the whole body of copy.
  enforceHtmlBoundary: false,

  // Deeply nested markup costs parser time superlinearly and renders as nothing
  // a human wrote. Twenty levels is far past any real blockquote-in-list-in-
  // table; beyond it the excess is discarded rather than parsed.
  nestingLimit: 20,

  transformTags: { a: forceSafeLinkRel },
};

/**
 * Sanitise untrusted rich text to the policy above.
 *
 * Total: every string in, a safe string out. There is no throwing path and no
 * "was it modified?" signal by design — a caller offered one would be tempted
 * to branch on it and store the original.
 *
 * IDEMPOTENT: sanitising already-sanitised markup returns it unchanged, which
 * is what makes calling this on write AND again on render cost nothing but the
 * parse.
 */
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, RICH_TEXT_OPTIONS);
}
