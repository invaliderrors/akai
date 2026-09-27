import { z } from "zod";

/**
 * Zod schemas for EXACTLY the Sendcloud v3 fields this system reads.
 *
 * NOT `.strict()`, the opposite of our own request schemas and for the reason
 * DeepL's adapter records: strictness on an INBOUND vendor payload turns a
 * harmless additive change on their side into an outage on ours. We whitelist
 * what we consume and let zod drop the rest; a field we read changing shape is
 * still a parse failure, surfaced as `malformed_response`.
 *
 * Shapes verified against the fixtures in `../__fixtures__` (captured from the
 * real account, spec §11a) and, for the endpoints with no fixture
 * (check-availability, cancel, get-by-reference, tracking), against Sendcloud's
 * published OpenAPI specs (`sendcloud.dev/.openapi/v3/<area>/openapi.yaml`).
 *
 * `.nullish()` is used freely for optional vendor fields: Sendcloud sends
 * `null`, `""` and absent interchangeably across endpoints, and each of those
 * means "no value" to us.
 */

// ---------------------------------------------------------------------------
// Errors — JSON:API. `status` is a STRING in Sendcloud's bodies ("404").
// ---------------------------------------------------------------------------

export const sendcloudErrorObjectSchema = z.object({
  status: z.union([z.string(), z.number()]).nullish(),
  code: z.string().nullish(),
  title: z.string().nullish(),
  detail: z.string().nullish(),
  source: z.object({ pointer: z.string().nullish() }).nullish(),
});

export const sendcloudErrorBodySchema = z.object({
  errors: z.array(sendcloudErrorObjectSchema),
});

// ---------------------------------------------------------------------------
// Service points
// ---------------------------------------------------------------------------

const openingShiftSchema = z.object({
  start_time: z.string(),
  end_time: z.string(),
});

const openingDaySchema = z.array(openingShiftSchema).nullish();

const openingTimesSchema = z.object({
  monday: openingDaySchema,
  tuesday: openingDaySchema,
  wednesday: openingDaySchema,
  thursday: openingDaySchema,
  friday: openingDaySchema,
  saturday: openingDaySchema,
  sunday: openingDaySchema,
});

export const sendcloudServicePointSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  carrier: z.object({ code: z.string() }),
  carrier_service_point_id: z.string().nullish(),
  general_shop_type: z.string().nullish(),
  address: z.object({
    street: z.string().nullish(),
    house_number: z.string().nullish(),
    postal_code: z.string().nullish(),
    city: z.string().nullish(),
    country_code: z.string(),
  }),
  opening_times: openingTimesSchema.nullish(),
  is_expired: z.boolean().nullish(),
  distance: z.number().nullish(),
});

export type SendcloudServicePointWire = z.infer<typeof sendcloudServicePointSchema>;

export const servicePointSearchResponseSchema = z.object({
  data: z.object({
    results: z.array(sendcloudServicePointSchema),
    geocoding: z.object({ status: z.string() }).nullish(),
  }),
});

export const servicePointDetailResponseSchema = z.object({
  data: sendcloudServicePointSchema,
});

export const servicePointAvailabilityResponseSchema = z.object({
  data: z.object({ is_available: z.boolean() }),
});

// ---------------------------------------------------------------------------
// Shipping options (the admin rate editor's picker)
// ---------------------------------------------------------------------------

const priceSchema = z.object({
  value: z.string(),
  currency: z.string(),
});

export const sendcloudShippingOptionSchema = z.object({
  code: z.string(),
  name: z.string(),
  carrier: z.object({ code: z.string(), name: z.string() }),
  functionalities: z.object({ last_mile: z.string().nullish() }).nullish(),
  requirements: z
    .object({
      fields: z.array(z.string()).nullish(),
      is_service_point_required: z.boolean().nullish(),
    })
    .nullish(),
  quotes: z
    .array(
      z.object({
        price: z.object({ total: priceSchema.nullish() }).nullish(),
      }),
    )
    .nullish(),
});

export const shippingOptionsResponseSchema = z.object({
  data: z.array(sendcloudShippingOptionSchema).nullish(),
});

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

export const sendcloudParcelSchema = z.object({
  id: z.number().int(),
  status: z
    .object({
      code: z.string().nullish(),
      message: z.string().nullish(),
    })
    .nullish(),
  tracking_number: z.string().nullish(),
  tracking_url: z.string().nullish(),
  /** Base64 PDF, present on a synchronous single-parcel announce. */
  label_file: z.string().nullish(),
});

export const sendcloudShipmentSchema = z.object({
  id: z.string(),
  external_reference_id: z.string().nullish(),
  order_number: z.string().nullish(),
  carrier: z.object({ code: z.string().nullish(), name: z.string().nullish() }).nullish(),
  ship_with: z
    .object({
      properties: z.object({ shipping_option_code: z.string().nullish() }).nullish(),
    })
    .nullish(),
  parcels: z.array(sendcloudParcelSchema).nullish(),
  errors: z.array(sendcloudErrorObjectSchema).nullish(),
});

export type SendcloudShipmentWire = z.infer<typeof sendcloudShipmentSchema>;

export const shipmentResponseSchema = z.object({
  data: sendcloudShipmentSchema,
});

/** `GET /shipments?external_reference_id=` — a (paginated) list. */
export const shipmentListResponseSchema = z.object({
  data: z.array(sendcloudShipmentSchema).nullish(),
});

export const cancelShipmentResponseSchema = z.object({
  data: z.object({
    status: z.string(),
    message: z.string().nullish(),
  }),
});

// ---------------------------------------------------------------------------
// Tracking — `GET /parcels/tracking/{tracking_number}`
// ---------------------------------------------------------------------------

const trackingBodySchema = z.object({
  details: z.object({ expected_delivery_date: z.string().nullish() }).nullish(),
  events: z
    .array(
      z.object({
        event_at: z.string().nullish(),
        status_code: z.string().nullish(),
        message: z.string().nullish(),
      }),
    )
    .nullish(),
});

/**
 * The OpenAPI document shows the tracking object UNWRAPPED, while every other
 * v3 read wraps its payload in `data`. Accept both rather than bet on one: the
 * fields we read are identical either way.
 */
export const trackingResponseSchema = z.union([
  z.object({ data: trackingBodySchema }).transform((body) => body.data),
  trackingBodySchema,
]);
