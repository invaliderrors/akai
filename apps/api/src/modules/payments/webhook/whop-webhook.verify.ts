import { WebhookVerificationError, unwrapWebhook } from "@whop/sdk/helpers";

/**
 * The outcome of verifying one inbound delivery.
 *
 * A DISCRIMINATED UNION RATHER THAN A THROW, because the controller has to
 * answer differently for the two cases and a caught-and-rethrown exception is a
 * worse way to say so. `reason` is for the log only; the HTTP response stays
 * generic so an attacker probing signatures learns nothing.
 */
export type WhopVerifyResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * Verify a Whop webhook and return its parsed body.
 *
 * WHY THE VENDOR'S VERIFIER IS USED HERE WHEN TAGADAPAY'S WAS REFUSED — the
 * decision reversed on evidence, so the reasoning is worth stating.
 *
 * TagadaPay shipped the right primitive (`verifyCrmWebhookSignature`) and did
 * not export it: absent from the root and utils type declarations, no `./utils`
 * subpath in its `exports` map, so a deep import failed at runtime. Its only
 * public path was `webhooks.constructEvent`, which verified and then
 * `JSON.parse`d straight into a caller-named generic with no validation at all.
 * Both halves were unusable, so both were reimplemented in-repo.
 *
 * Whop splits cleanly. `unwrapWebhook` IS exported from `@whop/sdk/helpers`, and
 * its verification half is the honest Standard Webhooks implementation:
 * HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}` with a
 * five-minute tolerance, via the `standardwebhooks` package. It also handles a
 * detail we would get wrong by hand and would not notice: Whop signs with the
 * LITERAL BYTES of the `ws_`-prefixed secret, while `standardwebhooks`
 * base64-DECODES whatever key it is handed, so the helper base64-encodes the
 * secret first to cancel that out. Passing the raw secret does not fail as a
 * verification error — `_` is outside the base64 alphabet, so the library's
 * constructor throws `Base64Coder: incorrect characters for decoding` instead.
 *
 * THE TIMESTAMP WINDOW IS THE HALF TAGADAPAY COULD NOT PROVIDE. Its CRM HMAC
 * covered the raw body alone with no timestamp bound into the signed material,
 * so a captured delivery was replayable indefinitely at the transport layer and
 * the integration contract had to record the gap as a hole `provider_event`
 * stood behind alone. Whop binds the timestamp into the signature, so replaying
 * a captured delivery outside five minutes fails verification outright.
 *
 * WHAT IS STILL OURS: the typing. `unwrapWebhook<TEvent>` is an unchecked
 * assertion on the parsed body — its own doc comment says "nothing here checks
 * the payload against it" — so it is called with NO type argument and left at
 * its `Record<string, unknown>` default. Naming a type there would buy a static
 * shape that was never earned at runtime, which is the same violation
 * `constructEvent` was rejected for. Validation happens in
 * `whop-webhook.schemas.ts`, against zod, on the record this returns.
 *
 * Takes the RAW bytes deliberately: the signature covers the exact byte
 * sequence sent, so a body that has been through `JSON.parse`/`JSON.stringify`
 * has different key order and whitespace and will never verify.
 */
export function verifyWhopWebhook(
  rawBody: Buffer,
  headers: Record<string, string>,
  secret: string,
): WhopVerifyResult {
  try {
    const body = unwrapWebhook(rawBody.toString("utf8"), { headers, key: secret });

    // `unwrapWebhook` is typed as returning the default record, but that type is
    // an assertion over `JSON.parse` — a signed body of `"null"` or `"[]"` is
    // authentic and is not a record. Narrowed here so the schemas downstream can
    // rely on being handed an object.
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, reason: "verified body is not a JSON object" };
    }

    return { ok: true, body };
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      // Covers a missing or malformed header, a timestamp outside tolerance and
      // a signature mismatch alike. NOT distinguished: telling a caller which of
      // those failed is telling an attacker how close they got.
      return { ok: false, reason: error.message };
    }

    // A missing key throws a bare `Error`, and a `ws_` secret handed to the
    // library undecoded throws from the base64 decoder. Both are configuration
    // faults rather than hostile input, and both must still refuse the delivery.
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
