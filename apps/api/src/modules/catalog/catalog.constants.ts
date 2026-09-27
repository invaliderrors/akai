/**
 * Header announcing that the API stored something OTHER than what was submitted.
 *
 * WHY THE API HAS TO SAY SO AT ALL. Product descriptions are sanitised on the
 * way into the column (see `ProductsService.sanitizeTranslations`), which is a
 * silent rewrite of an operator's input. An admin who pastes a `<script>` and
 * watches it vanish with a cheerful 200 has learned nothing — not that the
 * paste was rejected, not that the store is protected, and not that the copy
 * they think they published is missing a chunk. Sanitisation that is invisible
 * teaches the operator that their editor is unreliable rather than that their
 * markup was unsafe.
 *
 * WHY A HEADER AND NOT THE BODY. The write responds with the `Product` resource
 * — the canonical stored representation, which the dashboard parses against the
 * `.strict()` contract schema. Adding a warning field to that schema puts a
 * write-only key on an entity that is null on every read, and wrapping the body
 * in `{ product, warnings }` breaks every existing admin client. The cart faces
 * the identical problem with its token and answers it the identical way (see
 * `CART_TOKEN_HEADER`): out-of-band metadata about a write travels beside the
 * resource, not inside it.
 *
 * WHY NOT A 400. Rejecting the write would be louder still, and wrong: the
 * sanitiser exists precisely so hostile or merely messy input can be ACCEPTED
 * and neutralised. Copy pasted out of a document editor arrives full of
 * `<span style>` and proprietary junk; refusing to save it makes the operator
 * hand-clean HTML, which is the job we just automated.
 *
 * THE VALUE IS A CLOSED SET, NOT PROSE. Comma-separated `Locale` codes — the
 * locales whose `description` the sanitiser rewrote — so a client branches on
 * them and renders its own translated notice, per the platform rule that a
 * server-supplied message is never shown to a user. Locales rather than a bare
 * boolean because an admin edits per-locale copy: "something changed" without
 * naming the language sends them hunting through both.
 *
 * ABSENT means nothing was altered. Presence IS the signal, so there is no
 * "false" state to misread.
 *
 * A BROWSER CANNOT READ THIS UNLESS IT IS IN CORS `exposedHeaders`. The
 * dashboard talks to the API cross-origin, so the header is present on the wire
 * and invisible to JavaScript without that entry. See main.ts — the same
 * omission once broke the guest cart completely.
 */
export const CONTENT_SANITIZED_HEADER = "x-content-sanitized";
