import { z } from "zod";
import type { ServerApiClient } from "@/lib/api/client";
import type { ApiResult } from "@/lib/api/errors";

/**
 * Mirrors the API's `PartnerStats` — a PARTNER's own restricted view. No
 * `revenueMinor`: this is the whole point of the type being narrower than
 * `AdminAffiliate`, not merely a field left unrendered. See
 * `AffiliateAdminService.statsForPartnerByCustomerId`'s own doc comment.
 */
export const partnerStatsSchema = z
  .object({
    discountCodes: z.array(z.string()),
    redemptionCount: z.number().int().min(0),
  })
  .strict();

export type PartnerStats = z.infer<typeof partnerStatsSchema>;

/**
 * The one read the partner area needs. `GET /partner/me` derives the
 * affiliate row from the caller's OWN session — there is no id to pass and
 * none this function accepts, which is the whole IDOR defence on this side
 * too: there is nothing here a partner could tamper with to read someone
 * else's numbers.
 */
export async function getPartnerStats(client: ServerApiClient): Promise<ApiResult<PartnerStats>> {
  return client.get("/partner/me", partnerStatsSchema);
}
