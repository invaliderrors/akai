import { describe, expect, it } from "vitest";
import type { ServerEnv } from "@akai/config";
import { isBlogCoverObjectKey } from "@akai/contracts";

import type { Clock } from "../auth/ports/clock.port";
import { createUploadUrlSchema, uploadUrlResponseSchema } from "./media.dto";
import { MediaService } from "./media.service";
import {
  amzDates,
  canonicalRequest,
  credentialScope,
  encodeObjectKey,
  encodeRfc3986,
  presignGetUrl,
  presignPutUrl,
  signingKey,
} from "./s3-presigner";

const NOW = new Date("2026-07-20T10:00:00.000Z");
const clock: Clock = { now: () => NOW };

const config = {
  S3_ENDPOINT: "http://localhost:9002",
  S3_BUCKET: "akai-media",
  S3_ACCESS_KEY_ID: "akaidev",
  S3_SECRET_ACCESS_KEY: "akaidev-secret",
} as unknown as ServerEnv;

const PRODUCT_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const REQUEST = createUploadUrlSchema.parse({
  productId: PRODUCT_ID,
  contentType: "image/webp",
  sizeBytes: 240_000,
});

const PRESIGN_BASE = {
  endpoint: "http://localhost:9002",
  bucket: "akai-media",
  objectKey: "products/abc/hero.webp",
  region: "us-east-1",
  accessKeyId: "akaidev",
  secretAccessKey: "akaidev-secret",
  expiresInSeconds: 600,
  now: NOW,
};

describe("s3-presigner — SigV4 primitives", () => {
  it("encodes the characters encodeURIComponent leaves alone", () => {
    // The exact gap that makes a hand-rolled signer fail on some keys and not
    // others: !'()* are legal in encodeURIComponent output and illegal in SigV4.
    expect(encodeRfc3986("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
  });

  it("keeps / as a path separator in an object key", () => {
    expect(encodeObjectKey("products/id/file name.webp")).toBe(
      "products/id/file%20name.webp",
    );
  });

  it("derives both date forms SigV4 requires", () => {
    expect(amzDates(NOW)).toEqual({
      amzDate: "20260720T100000Z",
      dateStamp: "20260720",
    });
  });

  it("scopes a signature to one day, one region and one service", () => {
    expect(credentialScope("20260720", "eu-west-1")).toBe(
      "20260720/eu-west-1/s3/aws4_request",
    );
  });

  /**
   * Asserted line by line against the SigV4 specification rather than as an
   * opaque hash, so a reader can check it without running anything.
   */
  it("builds the canonical request in the specified shape", () => {
    const request = canonicalRequest(
      "/akai-media/products/a/b.webp",
      "X-Amz-Algorithm=AWS4-HMAC-SHA256",
      "localhost:9002",
    );

    expect(request.split("\n")).toEqual([
      "PUT",
      "/akai-media/products/a/b.webp",
      "X-Amz-Algorithm=AWS4-HMAC-SHA256",
      "host:localhost:9002",
      "",
      "host",
      "UNSIGNED-PAYLOAD",
    ]);
  });

  it("signs GET instead of PUT when asked — the only other verb this module signs", () => {
    const request = canonicalRequest(
      "/akai-private/documents/a/1.pdf",
      "X-Amz-Algorithm=AWS4-HMAC-SHA256",
      "localhost:9002",
      "GET",
    );

    expect(request.split("\n")[0]).toBe("GET");
  });

  it("derives a signing key that is scoped, not the raw secret", () => {
    const key = signingKey("secret", "20260720", "us-east-1");

    expect(key).toHaveLength(32);
    expect(key.toString("hex")).not.toContain(
      Buffer.from("secret", "utf8").toString("hex"),
    );
    expect(signingKey("secret", "20260721", "us-east-1").toString("hex")).not.toBe(
      key.toString("hex"),
    );
  });
});

describe("presignPutUrl", () => {
  it("addresses the bucket path-style, which is what MinIO serves", () => {
    const url = new URL(presignPutUrl(PRESIGN_BASE));

    expect(url.origin).toBe("http://localhost:9002");
    expect(url.pathname).toBe("/akai-media/products/abc/hero.webp");
  });

  it("carries every parameter the receiver needs to verify", () => {
    const url = new URL(presignPutUrl(PRESIGN_BASE));

    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "akaidev/20260720/us-east-1/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260720T100000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sorts the signed query parameters, as the specification requires", () => {
    const query = presignPutUrl(PRESIGN_BASE).split("?")[1] ?? "";
    // X-Amz-Signature is appended after signing and is not part of the sorted set.
    const signed = query.split("&X-Amz-Signature=")[0] ?? "";
    const keys = signed.split("&").map((pair) => pair.split("=")[0] ?? "");

    expect(keys).toEqual([...keys].sort());
  });

  it("is deterministic for the same inputs, so a retry is the same capability", () => {
    expect(presignPutUrl(PRESIGN_BASE)).toBe(presignPutUrl(PRESIGN_BASE));
  });

  it.each([
    ["a different secret", { secretAccessKey: "other-secret" }],
    ["a different object key", { objectKey: "products/abc/other.webp" }],
    ["a different bucket", { bucket: "other-bucket" }],
    ["a different expiry", { expiresInSeconds: 900 }],
    ["a different signing time", { now: new Date("2026-07-21T10:00:00.000Z") }],
  ])("produces a different signature for %s", (_label, overrides) => {
    const base = new URL(presignPutUrl(PRESIGN_BASE));
    const other = new URL(presignPutUrl({ ...PRESIGN_BASE, ...overrides }));

    expect(other.searchParams.get("X-Amz-Signature")).not.toBe(
      base.searchParams.get("X-Amz-Signature"),
    );
  });

  it("never leaks the secret access key into the URL", () => {
    expect(presignPutUrl(PRESIGN_BASE)).not.toContain("akaidev-secret");
  });
});

describe("presignGetUrl", () => {
  const PRIVATE_BASE = {
    ...PRESIGN_BASE,
    bucket: "akai-private",
    objectKey: "documents/some-order-id/1.pdf",
  };

  it("carries the same signed parameters as a PUT, for the other verb this module signs", () => {
    const url = new URL(presignGetUrl(PRIVATE_BASE));

    expect(url.pathname).toBe("/akai-private/documents/some-order-id/1.pdf");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs a DIFFERENT value than presignPutUrl would for the identical input", () => {
    // The method is part of the canonical request, so the same object, bucket
    // and expiry still produce two distinct signatures — a GET signature must
    // never authorise a PUT of the same object, or the reverse.
    const getSignature = new URL(presignGetUrl(PRIVATE_BASE)).searchParams.get("X-Amz-Signature");
    const putSignature = new URL(presignPutUrl(PRIVATE_BASE)).searchParams.get("X-Amz-Signature");

    expect(getSignature).not.toBe(putSignature);
  });

  it("never leaks the secret access key into the URL", () => {
    expect(presignGetUrl(PRIVATE_BASE)).not.toContain("akaidev-secret");
  });
});

describe("MediaService.createUploadUrl", () => {
  const service = new MediaService(config, clock);

  it("returns a payload matching its own contract", () => {
    const result = service.createUploadUrl(REQUEST);

    expect(uploadUrlResponseSchema.parse(result)).toEqual(result);
  });

  it("derives the key from the product id — the client cannot choose it", () => {
    const result = service.createUploadUrl(REQUEST);

    expect(result.objectKey.startsWith(`products/${PRODUCT_ID}/`)).toBe(true);
    expect(result.objectKey.endsWith(".webp")).toBe(true);
  });

  it("mints a distinct key per call, so one upload cannot clobber another", () => {
    const first = service.createUploadUrl(REQUEST);
    const second = service.createUploadUrl(REQUEST);

    expect(first.objectKey).not.toBe(second.objectKey);
  });

  it("matches the extension to the declared content type", () => {
    const png = service.createUploadUrl(
      createUploadUrlSchema.parse({ ...REQUEST, contentType: "image/png" }),
    );

    expect(png.objectKey.endsWith(".png")).toBe(true);
  });

  it("points the public URL at the same bucket the URL was signed against", () => {
    const result = service.createUploadUrl(REQUEST);

    expect(result.publicUrl).toBe(
      `http://localhost:9002/akai-media/${result.objectKey}`,
    );
    expect(new URL(result.uploadUrl).pathname).toBe(
      `/akai-media/${result.objectKey}`,
    );
  });

  it("time-boxes the capability", () => {
    expect(service.createUploadUrl(REQUEST).expiresInSeconds).toBe(600);
  });
});

describe("createUploadUrlSchema", () => {
  it("refuses SVG — an image format that executes script on our origin", () => {
    expect(
      createUploadUrlSchema.safeParse({ ...REQUEST, contentType: "image/svg+xml" })
        .success,
    ).toBe(false);
  });

  it("refuses a document content type outright", () => {
    expect(
      createUploadUrlSchema.safeParse({ ...REQUEST, contentType: "text/html" }).success,
    ).toBe(false);
  });

  it("rejects a client-supplied object key — the path-traversal primitive", () => {
    expect(
      createUploadUrlSchema.safeParse({
        ...REQUEST,
        objectKey: "../../backups/db.sql",
      }).success,
    ).toBe(false);
  });

  it("rejects an oversized declared upload before a URL is minted", () => {
    expect(
      createUploadUrlSchema.safeParse({ ...REQUEST, sizeBytes: 64 * 1024 * 1024 })
        .success,
    ).toBe(false);
  });
});

describe("MediaService.createBlogCoverUploadUrl", () => {
  const service = new MediaService(config, clock);
  const POST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

  it("keys the object under blog/{postId}/, never under products/", () => {
    const result = service.createBlogCoverUploadUrl(POST_ID, "image/png");

    expect(result.objectKey.startsWith(`blog/${POST_ID}/`)).toBe(true);
    expect(result.objectKey.endsWith(".png")).toBe(true);
    expect(uploadUrlResponseSchema.parse(result)).toEqual(result);
  });

  it("mints a key the blog contract recognises as this post's", () => {
    const result = service.createBlogCoverUploadUrl(POST_ID, "image/webp");

    expect(isBlogCoverObjectKey(POST_ID, result.objectKey)).toBe(true);
  });

  it("resolves a stored key to the same public URL the upload reported", () => {
    const result = service.createBlogCoverUploadUrl(POST_ID, "image/jpeg");

    expect(service.publicUrlFor(result.objectKey)).toBe(result.publicUrl);
  });
});
