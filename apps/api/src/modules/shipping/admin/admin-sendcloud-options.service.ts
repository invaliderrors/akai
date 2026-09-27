import { Inject, Injectable } from "@nestjs/common";
import type { SendcloudOptionsResponse } from "@akai/contracts";

import { FulfilmentError } from "../../fulfilment/fulfilment.errors";
import { SendcloudError } from "../../fulfilment/sendcloud/sendcloud.errors";
import { SENDCLOUD_CLIENT, type SendcloudPort } from "../../fulfilment/sendcloud/sendcloud.port";
import { toSendcloudOptionDtos } from "./sendcloud-options.mapper";

/**
 * `GET /v1/admin/shipping/sendcloud-options?country=` — which Sendcloud
 * shipping options exist from our sender to a destination, for the rate
 * editor's option picker (spec §7a, §11a G1).
 *
 * FROM ES, AT 500 g: the sender address (§11a, id 920582) is in Spain, and the
 * spike's own G1 matrix was taken at 500 g. The weight only moves the quoted
 * merchant cost, which is informational here — the picker is about WHICH
 * options exist, and staff never charge that cost (§3.1).
 *
 * FAILURES ARE CODED, NEVER A 500: not configured → the foundation's
 * FULFILMENT_NOT_CONFIGURED (409) as-is; Sendcloud down or timing out →
 * VENDOR_UNAVAILABLE; Sendcloud refusing the request → VENDOR_REJECTED. The
 * editor falls back to free text in every case.
 */
export const SENDER_COUNTRY_CODE = "ES";
export const OPTIONS_PROBE_WEIGHT_GRAMS = 500;

@Injectable()
export class AdminSendcloudOptionsService {
  constructor(@Inject(SENDCLOUD_CLIENT) private readonly sendcloud: SendcloudPort) {}

  async list(country: string): Promise<SendcloudOptionsResponse> {
    if (!this.sendcloud.isConfigured) {
      throw FulfilmentError.from("FULFILMENT_NOT_CONFIGURED");
    }
    try {
      const options = await this.sendcloud.listShippingOptions({
        fromCountryCode: SENDER_COUNTRY_CODE,
        toCountryCode: country,
        weightGrams: OPTIONS_PROBE_WEIGHT_GRAMS,
      });
      return { country, options: toSendcloudOptionDtos(options) };
    } catch (error: unknown) {
      if (error instanceof SendcloudError) {
        throw FulfilmentError.from(error.retryable ? "VENDOR_UNAVAILABLE" : "VENDOR_REJECTED");
      }
      throw error;
    }
  }
}
