import { createHmac } from "node:crypto";
import { REVALIDATE_SIGNATURE_HEADER } from "@akai/contracts";
import type { Logger } from "@akai/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutboxMessage } from "../outbox/outbox.types";
import { HttpRevalidationClient, type RevalidationClient } from "./revalidation.client";
import { RevalidationOutboxHandler } from "./revalidation.outbox-handler";
import { REVALIDATION_TOPIC } from "./revalidation.types";

const SECRET = "s".repeat(32);

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const message: OutboxMessage = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  topic: REVALIDATION_TOPIC,
  payload: null,
  attempts: 0,
};

interface CapturedRequest {
  readonly url: string;
  readonly body: string;
  readonly signature: string;
}

function stubFetch(status = 200): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];

  vi.stubGlobal(
    "fetch",
    (url: string, init: { body: string; headers: Record<string, string> }) => {
      captured.push({
        url,
        body: init.body,
        signature: init.headers[REVALIDATE_SIGNATURE_HEADER] ?? "",
      });
      return Promise.resolve({ ok: status >= 200 && status < 300, status });
    },
  );

  return { captured };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpRevalidationClient", () => {
  it("posts to the storefront's revalidate route", async () => {
    const { captured } = stubFetch();
    const client = new HttpRevalidationClient({
      storefrontUrl: "https://shop.akai.test",
      signingSecret: SECRET,
    });

    await client.revalidate(["products"]);

    expect(captured[0]?.url).toBe("https://shop.akai.test/api/revalidate");
  });

  it("tolerates a trailing slash rather than producing a double slash", async () => {
    const { captured } = stubFetch();
    const client = new HttpRevalidationClient({
      storefrontUrl: "https://shop.akai.test/",
      signingSecret: SECRET,
    });

    await client.revalidate(["products"]);

    expect(captured[0]?.url).toBe("https://shop.akai.test/api/revalidate");
  });

  /**
   * THE test for this class.
   *
   * The receiver verifies an HMAC of the RAW bytes it read. If the signature
   * were computed over a different serialisation of the same object, key order
   * would decide whether a purge worked — an intermittent failure that looks
   * like a flaky storefront rather than a signing bug.
   */
  it("signs the exact bytes it transmits", async () => {
    const { captured } = stubFetch();
    const client = new HttpRevalidationClient({
      storefrontUrl: "https://shop.akai.test",
      signingSecret: SECRET,
    });

    await client.revalidate(["products", "categories"]);

    const sent = captured[0];
    const expected = createHmac("sha256", SECRET)
      .update(sent?.body ?? "")
      .digest("hex");

    expect(sent?.body).toBe('{"tags":["products","categories"]}');
    expect(sent?.signature).toBe(expected);
  });

  it("produces a different signature under a different secret", async () => {
    const { captured } = stubFetch();

    await new HttpRevalidationClient({
      storefrontUrl: "https://shop.akai.test",
      signingSecret: SECRET,
    }).revalidate(["products"]);
    await new HttpRevalidationClient({
      storefrontUrl: "https://shop.akai.test",
      signingSecret: "different-secret-value-000000000",
    }).revalidate(["products"]);

    expect(captured[0]?.signature).not.toBe(captured[1]?.signature);
  });

  it("throws on a non-2xx so the outbox retries instead of marking it done", async () => {
    stubFetch(503);
    const client = new HttpRevalidationClient({
      storefrontUrl: "https://shop.akai.test",
      signingSecret: SECRET,
    });

    await expect(client.revalidate(["products"])).rejects.toThrow("503");
  });
});

describe("RevalidationOutboxHandler", () => {
  function handlerWith(client: RevalidationClient): RevalidationOutboxHandler {
    return new RevalidationOutboxHandler(client, logger);
  }

  it("binds to its own topic, not to the catalog topics the mirror owns", () => {
    expect(handlerWith({ revalidate: () => Promise.resolve() }).topic).toBe(
      "storefront.revalidate",
    );
  });

  it("forwards the parsed tags", async () => {
    const seen: string[][] = [];
    const handler = handlerWith({
      revalidate: (tags) => {
        seen.push([...tags]);
        return Promise.resolve();
      },
    });

    await handler.handle({ tags: ["products"], reason: "catalog.product.updated" }, message);

    expect(seen).toEqual([["products"]]);
  });

  it("dead-letters an unrecognised payload rather than silently marking it done", async () => {
    const handler = handlerWith({ revalidate: () => Promise.resolve() });

    await expect(handler.handle({ paths: ["/es"] }, message)).rejects.toThrow(
      /Unrecognised revalidation payload/,
    );
  });

  it("rejects an empty tag list — an unfocused purge is not a revalidation", async () => {
    const handler = handlerWith({ revalidate: () => Promise.resolve() });

    await expect(handler.handle({ tags: [], reason: "x" }, message)).rejects.toThrow(
      /Unrecognised revalidation payload/,
    );
  });

  it("propagates a transport failure so the dispatcher backs off", async () => {
    const handler = handlerWith({
      revalidate: () => Promise.reject(new Error("storefront down")),
    });

    await expect(
      handler.handle({ tags: ["products"], reason: "catalog.product.updated" }, message),
    ).rejects.toThrow("storefront down");
  });
});
