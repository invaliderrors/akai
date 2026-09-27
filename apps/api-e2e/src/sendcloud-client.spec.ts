import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FakeSendcloudServer, startFakeSendcloud } from "@akai/testing";

import { SendcloudClient } from "../../api/src/modules/fulfilment/sendcloud/sendcloud.client";

/**
 * The production `SendcloudClient` over REAL HTTP against the local fake —
 * the harness later phases (pickup points, labels, tracking) build their
 * end-to-end suites on. No database, so it needs no Docker.
 *
 * What only real HTTP proves (the unit suite stubs `fetch`): the Basic auth
 * header survives Node's fetch, the repeated `carrier_code` params are encoded
 * the way a server reads them, a 409 body is still readable after a non-2xx,
 * retries really re-send the request, and binary label bytes round-trip.
 */

const FIXTURES = path.resolve(__dirname, "../../api/src/modules/fulfilment/__fixtures__");

function fixtureJson(name: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  return value;
}

describe("SendcloudClient ⇄ fake Sendcloud (real HTTP)", () => {
  let fake: FakeSendcloudServer;
  let client: SendcloudClient;

  beforeAll(async () => {
    fake = await startFakeSendcloud();
  });

  afterAll(async () => {
    await fake.close();
  });

  beforeEach(() => {
    fake.reset();
    client = new SendcloudClient(
      { publicKey: "pub", secretKey: "sec", baseUrl: fake.baseUrl, maxRetries: 2 },
      { sleep: () => Promise.resolve() },
    );
  });

  it("searches pickup points with Basic auth and repeated carrier codes", async () => {
    fake.on("GET", "/service-points", {
      status: 200,
      body: fixtureJson("service-points.es-inpost-50002.json"),
    });

    const result = await client.searchServicePoints({
      countryCode: "ES",
      carrierCodes: ["inpost_es"],
      postalCode: "50002",
      radiusMeters: 10_000,
    });

    expect(result.points.map((point) => point.name)).toContain("PAPELERIA PILI");
    const [request] = fake.requestsTo("GET", "/service-points");
    expect(request?.headers["authorization"]).toBe(`Basic ${Buffer.from("pub:sec").toString("base64")}`);
    expect(request?.query.getAll("carrier_code")).toEqual(["inpost_es"]);
    expect(request?.query.get("radius")).toBe("10000");
  });

  it("re-sends an announce through a 503 and reads a 409's existing shipment", async () => {
    const letter = fixtureJson("shipment-announce.letter.json");
    fake.queue("POST", "/shipments/announce", { status: 503 }, { status: 409, body: letter });

    const { shipment, reused } = await client.announceShipment({
      externalReferenceId: "spike-2026-09-24-1",
      orderNumber: "AK-2026-000001",
      senderAddressId: 920582,
      recipient: {
        name: "Ana García",
        companyName: null,
        addressLine1: "Calle Mayor",
        houseNumber: "1",
        addressLine2: null,
        postalCode: "50002",
        city: "Zaragoza",
        countryCode: "ES",
        email: "ana@example.com",
        phoneNumber: "+34600000000",
      },
      servicePointId: null,
      shippingOptionCode: "sendcloud:letter",
      weightGrams: 120,
    });

    expect(reused).toBe(true);
    expect(shipment.parcels[0]?.id).toBe(718530367);
    const announces = fake.requestsTo("POST", "/shipments/announce");
    expect(announces).toHaveLength(2);
    expect(announces[1]?.body).toMatchObject({ external_reference_id: "spike-2026-09-24-1" });
  });

  it("downloads label bytes intact", async () => {
    const pdf = new Uint8Array(Buffer.from("%PDF-1.4\nâãÏÓ\n%%EOF", "latin1"));
    fake.on("GET", "/parcels/:id/documents/label", {
      status: 200,
      body: pdf,
      headers: { "content-type": "application/pdf" },
    });

    const bytes = await client.downloadLabel(718530367);

    expect(Buffer.from(bytes).equals(Buffer.from(pdf))).toBe(true);
    expect(fake.requestsTo("GET", "/parcels/:id/documents/label")[0]?.params).toEqual({ id: "718530367" });
  });

  it("surfaces an unscripted route as a typed 404", async () => {
    await expect(client.getShipment("missing")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});
