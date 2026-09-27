import { createHmac } from "node:crypto";
import { REVALIDATE_SIGNATURE_HEADER } from "@akai/contracts";

/**
 * The outbound call to the storefront's `/api/revalidate`.
 *
 * A port, so the outbox handler's routing and error mapping are testable without
 * a network, and so a future transport change (a queue, a CDN purge API) is a
 * provider swap rather than a rewrite of the consumer.
 */
export interface RevalidationClient {
  /** Resolves on success. THROWS on any failure, so the outbox retries. */
  revalidate(tags: readonly string[]): Promise<void>;
}

export const REVALIDATION_CLIENT = Symbol("REVALIDATION_CLIENT");

export interface HttpRevalidationOptions {
  /** Storefront origin. A trailing slash is tolerated. */
  readonly storefrontUrl: string;
  readonly signingSecret: string;
  readonly timeoutMs?: number;
}

/** The storefront is on our own network; a slow one must not pin a worker tick. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * HMAC-signed HTTP revalidation.
 *
 * WHAT REPLACED WHAT: the storefront's route handler already verified an
 * HMAC-SHA256 of the raw body in `x-akai-revalidate-signature` — its MECHANISM
 * was never WordPress-specific, only its CALLER was. WordPress emitted the call
 * from a save hook; nothing on this API ever did, so `RevalidationModule` sat
 * empty while `REVALIDATE_SIGNING_SECRET` was already a REQUIRED key in
 * `libs/config` for a feature that did not exist. This class is that caller.
 *
 * THE SIGNATURE COVERS THE EXACT BYTES TRANSMITTED. The body is serialised ONCE
 * into a string, signed, and then sent as that same string — never re-serialised
 * from the object. Signing an object and sending a second serialisation of it is
 * how a signature ends up covering bytes the receiver never saw, and the failure
 * is intermittent (key order) rather than immediate.
 */
export class HttpRevalidationClient implements RevalidationClient {
  constructor(private readonly options: HttpRevalidationOptions) {}

  async revalidate(tags: readonly string[]): Promise<void> {
    const body = JSON.stringify({ tags });
    const signature = createHmac("sha256", this.options.signingSecret)
      .update(body)
      .digest("hex");

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [REVALIDATE_SIGNATURE_HEADER]: signature,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        // THROWN, not logged and swallowed. A failed revalidation leaves the
        // storefront serving a stale price, and the outbox's backoff is exactly
        // the right response to a storefront that is mid-deploy. Swallowing it
        // would mark the row processed and leave the staleness permanent.
        throw new Error(
          `Storefront revalidation failed with status ${String(response.status)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private endpoint(): string {
    return `${this.options.storefrontUrl.replace(/\/+$/, "")}/api/revalidate`;
  }
}
