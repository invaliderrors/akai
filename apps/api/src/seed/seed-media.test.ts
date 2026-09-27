import { describe, expect, it } from "vitest";

import {
  SEED_MEDIA_PREFIX,
  isSeedObjectKey,
  parseSeedMediaEnv,
  seedContentType,
  seedMediaBaseUrl,
  seedObjectKey,
  seedPublicUrl,
  uploadSeedObject,
  type SeedFetch,
  type SeedMediaTarget,
} from "./seed-media";

const TARGET: SeedMediaTarget = {
  endpoint: "http://localhost:9002",
  bucket: "akai-media",
  accessKeyId: "akaidev",
  secretAccessKey: "akaidev-secret",
};

const NOW = new Date("2026-07-20T10:00:00.000Z");

/** Records what was PUT, so the assertions can be about the request itself. */
interface RecordedCall {
  url: string;
  method: string;
  body: Uint8Array;
  headers: Readonly<Record<string, string>>;
}

function recordingFetch(
  response: { ok: boolean; status: number; body?: string; bodyThrows?: boolean },
): { calls: RecordedCall[]; fetchImpl: SeedFetch } {
  const calls: RecordedCall[] = [];

  const fetchImpl: SeedFetch = (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      text: (): Promise<string> =>
        response.bodyThrows === true
          ? Promise.reject(new Error("body already consumed"))
          : Promise.resolve(response.body ?? ""),
    });
  };

  return { calls, fetchImpl };
}

describe("seedContentType", () => {
  it("maps an extension to the content type the admin route would use", () => {
    expect(seedContentType("box-logo-hoodie-1.png")).toBe("image/png");
    expect(seedContentType("hero.jpg")).toBe("image/jpeg");
    expect(seedContentType("hero.WEBP")).toBe("image/webp");
  });

  it("throws on an extension outside the hostable set rather than defaulting", () => {
    // Defaulting to octet-stream would upload happily and render nothing —
    // exactly the silent broken-image failure this module exists to remove.
    expect(() => seedContentType("logo.svg")).toThrow(/unsupported extension/i);
    expect(() => seedContentType("README")).toThrow(/unsupported extension/i);
  });
});

describe("seedObjectKey", () => {
  it("is deterministic, so a second seed run overwrites instead of duplicating", () => {
    const first = seedObjectKey("oversized-tee", "oversized-tee-1.png");
    const second = seedObjectKey("oversized-tee", "oversized-tee-1.png");

    expect(first).toBe(second);
    expect(first).toBe(
      `${SEED_MEDIA_PREFIX}oversized-tee/oversized-tee-1.png`,
    );
  });

  it("marks its own keys and nobody else's as prunable", () => {
    expect(isSeedObjectKey(seedObjectKey("cargo-pants", "a.png"))).toBe(true);
    // Written by the PREVIOUS seed, which pointed media at the storefront's own
    // dev server. A re-run has to be able to delete those rows.
    expect(isSeedObjectKey("seed/carousel/carousel (1).png")).toBe(true);
    // An asset a human uploaded through the admin route must never be pruned.
    expect(isSeedObjectKey("products/abc123/2026-07-20-deadbeef.png")).toBe(false);
  });
});

describe("parseSeedMediaEnv", () => {
  it("reads the same four variables the API validates at boot", () => {
    const target = parseSeedMediaEnv({
      S3_ENDPOINT: "http://localhost:9002",
      S3_BUCKET: "akai-media",
      S3_ACCESS_KEY_ID: "akaidev",
      S3_SECRET_ACCESS_KEY: "akaidev-secret",
      UNRELATED_SHELL_VARIABLE: "ignored",
    });

    expect(target).toEqual(TARGET);
  });

  it("fails loudly when the object store is not configured", () => {
    expect(() =>
      parseSeedMediaEnv({
        S3_ENDPOINT: "http://localhost:9002",
        S3_ACCESS_KEY_ID: "akaidev",
        S3_SECRET_ACCESS_KEY: "akaidev-secret",
      }),
    ).toThrow();
  });

  it("rejects an endpoint that is not a URL", () => {
    expect(() =>
      parseSeedMediaEnv({
        S3_ENDPOINT: "localhost:9002",
        S3_BUCKET: "akai-media",
        S3_ACCESS_KEY_ID: "akaidev",
        S3_SECRET_ACCESS_KEY: "akaidev-secret",
      }),
    ).toThrow();
  });

  it("carries an explicit public origin through, and treats empty as unset", () => {
    const withOverride = parseSeedMediaEnv({
      S3_ENDPOINT: "http://minio:9000",
      S3_BUCKET: "akai-media",
      S3_ACCESS_KEY_ID: "akaidev",
      S3_SECRET_ACCESS_KEY: "akaidev-secret",
      SEED_MEDIA_PUBLIC_BASE_URL: "https://cdn.example.com/akai-media",
    });
    expect(withOverride.publicBaseUrl).toBe("https://cdn.example.com/akai-media");

    // An empty value is what a `FOO=` line in a .env file produces, and
    // `.url()` would reject it — unset is the intended meaning.
    const empty = parseSeedMediaEnv({
      S3_ENDPOINT: "http://localhost:9002",
      S3_BUCKET: "akai-media",
      S3_ACCESS_KEY_ID: "akaidev",
      S3_SECRET_ACCESS_KEY: "akaidev-secret",
      SEED_MEDIA_PUBLIC_BASE_URL: "",
    });
    expect(empty.publicBaseUrl).toBeUndefined();
  });
});

describe("seedPublicUrl", () => {
  it("builds the same origin/bucket/key shape MediaService.publicUrl builds", () => {
    expect(seedPublicUrl(TARGET, "seed/products/x/y.png")).toBe(
      "http://localhost:9002/akai-media/seed/products/x/y.png",
    );
  });

  it("never points at the storefront's own dev server", () => {
    // The regression this whole module exists for: media on 3100/3002 made the
    // API's catalogue depend on the frontend being up, on one specific port.
    expect(seedPublicUrl(TARGET, "seed/products/x/y.png")).not.toContain("3100");
  });

  it("prefers an explicit public origin, for a CDN or an in-network endpoint", () => {
    expect(
      seedPublicUrl(
        { ...TARGET, endpoint: "http://minio:9000", publicBaseUrl: "https://cdn.example.com/m/" },
        "seed/products/x/y.png",
      ),
    ).toBe("https://cdn.example.com/m/seed/products/x/y.png");
  });

  it("exposes the bare origin the seed prints, without a trailing slash", () => {
    expect(seedMediaBaseUrl(TARGET)).toBe("http://localhost:9002/akai-media");
    expect(seedMediaBaseUrl({ ...TARGET, publicBaseUrl: "https://cdn.example.com/m//" })).toBe(
      "https://cdn.example.com/m",
    );
  });

  it("percent-encodes the key, preserving path separators", () => {
    expect(seedPublicUrl(TARGET, "seed/products/x/carousel (1).png")).toBe(
      "http://localhost:9002/akai-media/seed/products/x/carousel%20%281%29.png",
    );
  });
});

describe("uploadSeedObject", () => {
  it("PUTs the bytes to a presigned, path-style URL for that exact key", async () => {
    const { calls, fetchImpl } = recordingFetch({ ok: true, status: 200 });
    const body = new Uint8Array([137, 80, 78, 71]);

    await uploadSeedObject({
      target: TARGET,
      objectKey: "seed/products/x/y.png",
      body,
      contentType: "image/png",
      now: NOW,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("no call recorded");

    expect(call.method).toBe("PUT");
    expect(call.body).toBe(body);
    expect(call.headers["content-type"]).toBe("image/png");
    expect(call.url).toContain("http://localhost:9002/akai-media/seed/products/x/y.png?");
    expect(call.url).toContain("X-Amz-Signature=");
    expect(call.url).toContain("X-Amz-Expires=60");
  });

  it("throws with the status and the store's own error body on a refusal", async () => {
    const { fetchImpl } = recordingFetch({
      ok: false,
      status: 404,
      body: "<Error><Code>NoSuchBucket</Code></Error>",
    });

    await expect(
      uploadSeedObject({
        target: TARGET,
        objectKey: "seed/products/x/y.png",
        body: new Uint8Array([1]),
        contentType: "image/png",
        now: NOW,
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 404.*NoSuchBucket/s);
  });

  it("still reports the status when the error body cannot be read", async () => {
    const { fetchImpl } = recordingFetch({ ok: false, status: 500, bodyThrows: true });

    await expect(
      uploadSeedObject({
        target: TARGET,
        objectKey: "seed/products/x/y.png",
        body: new Uint8Array([1]),
        contentType: "image/png",
        now: NOW,
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
