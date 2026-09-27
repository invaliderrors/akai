-- Whop replaces TagadaPay as the payment provider.
--
-- The shape of this migration is driven by one fact: Whop accepts our computed
-- amount on the checkout call, and TagadaPay could not. Everything TagadaPay
-- needed in order to price an order from its own catalog is therefore dead
-- weight, not merely renamed.

-- The enum value is RENAMED, not dropped and recreated. `ALTER TYPE … RENAME
-- VALUE` rewrites the label in place and preserves every existing row, so this
-- is correct whether or not a payment has ever been taken and needs no
-- per-environment branch.
ALTER TYPE "PaymentProvider" RENAME VALUE 'TAGADA' TO 'WHOP';

-- Correlation rank 2. It now holds a `ch_…` checkout configuration id rather
-- than a scraped checkout token, so the name changes with it. RENAME COLUMN
-- keeps the unique index and its data.
ALTER TABLE "order" RENAME COLUMN "providerCheckoutToken" TO "providerCheckoutId";
-- RENAME COLUMN carries the unique index across, but not its NAME, which still
-- reads `..._providerCheckoutToken_key`. Prisma derives index names from column
-- names, so leaving it would make the next `migrate diff` want to recreate it.
ALTER INDEX "order_providerCheckoutToken_key" RENAME TO "order_providerCheckoutId_key";

-- Correlation rank 3, dropped. It existed because a TagadaPay payload might
-- carry none of our own keys, so a backfilled provider-side order id was the
-- last resort. Whop copies checkout metadata onto the payment, so rank 1
-- (`metadata.order_id`) is our own UUID round-tripped and is always present.
ALTER TABLE "order" DROP COLUMN "providerOrderId";

-- THE CATALOG MIRROR, DROPPED IN FULL. A TagadaPay checkout item was
-- `{ variantId, quantity }` with no amount field of any kind, which made the
-- mirrored variant the only channel through which a price could reach the
-- hosted payment page — hence "load-bearing" on these columns and a checkout
-- that refused to run against an unmirrored variant. Whop takes the number
-- directly, so nothing is mirrored, nothing can drift, and a sync outage is no
-- longer a class of failure this system has.
ALTER TABLE "product" DROP COLUMN "providerProductId";
ALTER TABLE "product_variant" DROP COLUMN "providerVariantId";
ALTER TABLE "price_history" DROP COLUMN "providerVariantId";

-- The dedupe-key provenance flag, dropped with the fallback it audited.
-- TagadaPay might supply no event id, so a content fingerprint had to stand in
-- and this column reported how often that weaker path was live. Whop sends a
-- `webhook-id` on every delivery, so there is no fallback and nothing to audit.
DROP INDEX IF EXISTS "provider_event_derived_idx";
ALTER TABLE "provider_event" DROP COLUMN "derived";
