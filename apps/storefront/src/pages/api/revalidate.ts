import { createHmac } from "node:crypto";

import { REVALIDATE_SIGNATURE_HEADER } from "@akai/contracts";
import { timingSafeEqual } from "@akai/session";
import type { APIRoute } from "astro";

import { serverEnv } from "@/lib/env";

/**
 * The API's outbox calls this after every catalog write (topic
 * `storefront.revalidate`), signing the raw body with REVALIDATE_SIGNING_SECRET.
 *
 * Every page here is rendered per request, so there is no page cache to purge
 * yet: a verified call is simply acknowledged. It still verifies, because an
 * unauthenticated endpoint that later grows a cache purge is a free DoS lever.
 * When a CDN or HTML cache is added, purge `tags` here.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.text();
  const signature = request.headers.get(REVALIDATE_SIGNATURE_HEADER) ?? "";
  const expected = createHmac("sha256", serverEnv().REVALIDATE_SIGNING_SECRET).update(body).digest("hex");

  if (!timingSafeEqual(signature, expected)) {
    return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 });
  }

  return new Response(JSON.stringify({ revalidated: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
