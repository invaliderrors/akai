/**
 * Names shared by browser and server halves of the CSRF double-submit.
 *
 * In their OWN module, with zero imports, on purpose. They previously lived
 * beside the cookie-attribute builders, but those read `serverEnv()`, so a
 * client component importing one constant dragged the entire server
 * configuration module into the browser bundle. Nothing secret would have been
 * inlined — Next only inlines `NEXT_PUBLIC_*` — but it is dead weight in every
 * bundle and an invitation for someone to later add a genuinely secret read to
 * a module the client already imports.
 */

/** Readable by client JS by design: the script must echo it into the header. */
export const CSRF_COOKIE_NAME = "akai_csrf";

/** Lowercase because `Headers` normalises, and the server compares lowercase. */
export const CSRF_HEADER_NAME = "x-csrf-token";
