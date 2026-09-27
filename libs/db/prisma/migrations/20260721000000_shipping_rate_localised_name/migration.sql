-- Shipping method names become PER-LOCALE.
--
-- `shipping_rate.name` was the only user-facing name in the model that was not a
-- locale-keyed record: `category.name`, `product_variant.name` and
-- `media_asset.alt` are all `jsonb`. The consequence was not cosmetic — the name
-- is rendered in the shipping-method picker on the last page before payment, and
-- it is copied onto `order.shippingMethodName`, so the untranslated string was
-- inherited by the confirmation email and the invoice as well.
--
-- THE EXISTING TEXT IS PRESERVED UNDER BOTH LOCALES rather than discarded. The
-- seeded values were English ("Standard (2-3 days)"), so copying them into `es`
-- reproduces exactly today's behaviour for a Spanish shopper — no worse — while
-- giving the seed and the admin a place to write the Spanish name. Dropping the
-- column and re-seeding instead would orphan any operator-authored rate.
ALTER TABLE "shipping_rate"
  ALTER COLUMN "name" TYPE JSONB
  USING jsonb_build_object('es', "name", 'en', "name");

-- Fail closed on the shape. `narrowLocalizedText` in the API already degrades an
-- unparseable record to "no name" (and the selector then refuses to offer the
-- rate), but that is a read-side guard: this constraint is what stops a manual
-- UPDATE writing a bare string or an array in the first place. A rate nobody can
-- name is a rate nobody can buy.
ALTER TABLE "shipping_rate"
  ADD CONSTRAINT "shipping_rate_name_is_object"
  CHECK (jsonb_typeof("name") = 'object');
