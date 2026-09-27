import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type FakeSendcloudServer, startFakeSendcloud } from "./fake-sendcloud";

describe("startFakeSendcloud", () => {
  let fake: FakeSendcloudServer;

  beforeEach(async () => {
    fake = await startFakeSendcloud();
  });

  afterEach(async () => {
    await fake.close();
  });

  it("serves a scripted reply under the v3 base and records the request", async () => {
    fake.on("GET", "/service-points", { status: 200, body: { data: { results: [] } } });

    const response = await fetch(`${fake.baseUrl}/service-points?country_code=ES&carrier_code=a&carrier_code=b`, {
      headers: { Authorization: "Basic abc" },
    });

    expect(fake.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v3$/);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { results: [] } });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.path).toBe("/service-points");
    expect(fake.requests[0]?.query.getAll("carrier_code")).toEqual(["a", "b"]);
    expect(fake.requests[0]?.headers["authorization"]).toBe("Basic abc");
  });

  it("matches :param segments and hands them to a function handler", async () => {
    fake.on("POST", "/service-points/:id/check-availability", (request) => ({
      status: 200,
      body: { data: { is_available: request.params["id"] !== "999" } },
    }));

    const ok = await fetch(`${fake.baseUrl}/service-points/1/check-availability`, { method: "POST" });
    const gone = await fetch(`${fake.baseUrl}/service-points/999/check-availability`, { method: "POST" });

    expect(await ok.json()).toEqual({ data: { is_available: true } });
    expect(await gone.json()).toEqual({ data: { is_available: false } });
  });

  it("consumes queued one-shot replies before the standing one", async () => {
    fake.on("POST", "/shipments/announce", { status: 200, body: { data: { id: "s1" } } });
    fake.queue("POST", "/shipments/announce", { status: 503 }, { status: 429 });

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${fake.baseUrl}/shipments/announce`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ external_reference_id: "o1" }),
      });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([503, 429, 200]);
    const announces = fake.requestsTo("POST", "/shipments/announce");
    expect(announces).toHaveLength(3);
    expect(announces[0]?.body).toEqual({ external_reference_id: "o1" });
  });

  it("answers an unscripted route with a JSON:API 404, never a plausible success", async () => {
    const response = await fetch(`${fake.baseUrl}/shipments/nope`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ errors: [{ status: "404", code: "not_found" }] });
  });

  it("serves bytes verbatim with the given content type", async () => {
    const pdf = new Uint8Array(Buffer.from("%PDF-1.4\n", "latin1"));
    fake.on("GET", "/parcels/:id/documents/label", {
      status: 200,
      body: pdf,
      headers: { "content-type": "application/pdf" },
    });

    const response = await fetch(`${fake.baseUrl}/parcels/718530367/documents/label`);

    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await response.arrayBuffer()).toString("latin1")).toBe("%PDF-1.4\n");
  });

  it("forgets everything on reset", async () => {
    fake.on("GET", "/x", { status: 200 });
    await fetch(`${fake.baseUrl}/x`);
    fake.reset();

    expect(fake.requests).toHaveLength(0);
    expect((await fetch(`${fake.baseUrl}/x`)).status).toBe(404);
  });
});
