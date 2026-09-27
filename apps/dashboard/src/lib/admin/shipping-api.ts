import { z } from "zod";
import {
  adminShippingRateSchema,
  adminShippingZoneDetailSchema,
  adminShippingZoneListSchema,
  createShippingRateSchema,
  createShippingZoneSchema,
  sendcloudOptionsResponseSchema,
  updateShippingRateSchema,
  updateShippingZoneSchema,
  type AdminShippingRate,
  type AdminShippingZoneDetail,
  type AdminShippingZoneList,
  type SendcloudOptionsResponse,
} from "@akai/contracts";

import { parseOrThrow, type AdminHttp } from "./http";

/**
 * `/v1/admin/shipping/*` — staff-editable zones and rates (Sendcloud spec §7a).
 *
 * Its own file rather than more of `api.ts`: that file is shared by every
 * admin surface, and this resource needs nothing from it but the `AdminHttp`
 * port. Every response is parsed against the SAME `@akai/contracts` schema the
 * API answers with, and every request body against the schema the API parses
 * with — nothing here declares a shape of its own.
 *
 * The request types are the schemas' INPUT side (`z.input`): what a caller
 * hands over before defaults are applied. The API applies the same defaults.
 */

export type CreateShippingZoneInput = z.input<typeof createShippingZoneSchema>;
export type UpdateShippingZoneInput = z.input<typeof updateShippingZoneSchema>;
export type CreateShippingRateInput = z.input<typeof createShippingRateSchema>;
export type UpdateShippingRateInput = z.input<typeof updateShippingRateSchema>;

export async function listShippingZones(http: AdminHttp): Promise<AdminShippingZoneList> {
  const response = await http.request({ method: "GET", path: "/admin/shipping/zones" });
  return parseOrThrow(adminShippingZoneListSchema, response);
}

export async function createShippingZone(
  http: AdminHttp,
  input: CreateShippingZoneInput,
): Promise<AdminShippingZoneDetail> {
  const response = await http.request({
    method: "POST",
    path: "/admin/shipping/zones",
    body: createShippingZoneSchema.parse(input),
  });
  return parseOrThrow(adminShippingZoneDetailSchema, response);
}

export async function updateShippingZone(
  http: AdminHttp,
  zoneId: string,
  input: UpdateShippingZoneInput,
): Promise<AdminShippingZoneDetail> {
  const response = await http.request({
    method: "PATCH",
    path: `/admin/shipping/zones/${encodeURIComponent(zoneId)}`,
    body: updateShippingZoneSchema.parse(input),
  });
  return parseOrThrow(adminShippingZoneDetailSchema, response);
}

/** 204, no body — the status is still checked, so a 403 cannot read as success. */
export async function deleteShippingZone(http: AdminHttp, zoneId: string): Promise<void> {
  const response = await http.request({
    method: "DELETE",
    path: `/admin/shipping/zones/${encodeURIComponent(zoneId)}`,
  });
  parseOrThrow(z.unknown(), response);
}

export async function createShippingRate(
  http: AdminHttp,
  zoneId: string,
  input: CreateShippingRateInput,
): Promise<AdminShippingRate> {
  const response = await http.request({
    method: "POST",
    path: `/admin/shipping/zones/${encodeURIComponent(zoneId)}/rates`,
    body: createShippingRateSchema.parse(input),
  });
  return parseOrThrow(adminShippingRateSchema, response);
}

export async function updateShippingRate(
  http: AdminHttp,
  zoneId: string,
  rateId: string,
  input: UpdateShippingRateInput,
): Promise<AdminShippingRate> {
  const response = await http.request({
    method: "PATCH",
    path: `/admin/shipping/zones/${encodeURIComponent(zoneId)}/rates/${encodeURIComponent(rateId)}`,
    body: updateShippingRateSchema.parse(input),
  });
  return parseOrThrow(adminShippingRateSchema, response);
}

export async function deleteShippingRate(
  http: AdminHttp,
  zoneId: string,
  rateId: string,
): Promise<void> {
  const response = await http.request({
    method: "DELETE",
    path: `/admin/shipping/zones/${encodeURIComponent(zoneId)}/rates/${encodeURIComponent(rateId)}`,
  });
  parseOrThrow(z.unknown(), response);
}

export async function listSendcloudOptions(
  http: AdminHttp,
  country: string,
): Promise<SendcloudOptionsResponse> {
  const response = await http.request({
    method: "GET",
    path: "/admin/shipping/sendcloud-options",
    query: { country },
  });
  return parseOrThrow(sendcloudOptionsResponseSchema, response);
}
