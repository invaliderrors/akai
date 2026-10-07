import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, query-string ("presigned URL") flavour, for ONE verb:
 * PUT an object.
 *
 * WHY HAND-ROLLED RATHER THAN `@aws-sdk/s3-request-presigner`: the SDK is not a
 * dependency of this workspace, and adding it would pull roughly a dozen
 * packages into the API image to produce a signed string. Presigning is a pure
 * function of (credentials, clock, bucket, key, expiry) — no network, no
 * connection pool, no retry policy — so the part of the SDK that carries real
 * value is not the part being used here. If the day comes that this module needs
 * multipart uploads, lifecycle rules or bucket administration, take the SDK; a
 * hand-rolled signer for THOSE would be a bad trade.
 *
 * PATH-STYLE ADDRESSING (`{endpoint}/{bucket}/{key}`), not virtual-host style.
 * MinIO — the local and staging target — serves path-style by default, and a
 * bucket name in a hostname does not survive `http://localhost:9002`. Real S3
 * accepts path-style too.
 *
 * UNSIGNED-PAYLOAD. The body is the file the browser is about to upload, and the
 * signer has never seen it; signing its hash would require the API to receive
 * the bytes, which is exactly what direct-to-S3 upload exists to avoid. The
 * signature still covers the method, the object key, the expiry and the host, so
 * a presigned URL cannot be re-pointed at a different key or a different bucket.
 *
 * Every function here is PURE and takes its clock as a parameter, so the
 * signature is reproducible in a test rather than being a moving target.
 */

export interface PresignInput {
  readonly endpoint: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly expiresInSeconds: number;
  /** Signing time. Injected so the output is deterministic under test. */
  readonly now: Date;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/**
 * RFC 3986 encoding, which is NOT what `encodeURIComponent` produces.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped; SigV4 requires them escaped, and
 * a mismatch produces a signature that verifies on most keys and fails on the
 * ones containing those characters — the worst kind of intermittent.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode an object key, preserving `/` as a path separator. */
export function encodeObjectKey(objectKey: string): string {
  return objectKey.split("/").map(encodeRfc3986).join("/");
}

/** `20260720T100000Z` and `20260720`, the two forms SigV4 needs. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * The scope a signature is valid within: date, region, service.
 *
 * Narrow on purpose. A signature minted for one day and one region cannot be
 * replayed against another, which bounds the damage of a leaked signed URL to
 * its own expiry window and its own bucket.
 */
export function credentialScope(dateStamp: string, region: string): string {
  return `${dateStamp}/${region}/${SERVICE}/aws4_request`;
}

/**
 * The canonical request, exactly as the SigV4 specification defines it.
 *
 * Exported so a reader can compare it line by line against the AWS
 * documentation, and so the test asserts the STRUCTURE rather than merely that
 * some 64-character hex string came out.
 *
 * `method` defaults to `"PUT"` — the verb every upload signs — so a call site
 * that only uploads never has to name it.
 */
export function canonicalRequest(
  canonicalUri: string,
  canonicalQuery: string,
  host: string,
  method: "PUT" | "GET" = "PUT",
): string {
  return [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n");
}

/**
 * Derive the signing key.
 *
 * Four chained HMACs, each narrowing the key's validity: secret → date → region
 * → service → request type. That chain is why a compromised signing key is
 * scoped to one day and one region rather than being the account's root secret.
 */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, "aws4_request");
}

/**
 * The SigV4 query-string presigning math, shared by every verb this module
 * signs. `presignPutUrl` and `presignGetUrl` are thin, verb-pinned wrappers
 * over this — the alternative, two independent implementations of the same
 * signature algorithm, is exactly how one of them silently drifts.
 */
function presign(input: PresignInput, method: "PUT" | "GET"): string {
  const endpoint = new URL(input.endpoint);
  const { amzDate, dateStamp } = amzDates(input.now);
  const scope = credentialScope(dateStamp, input.region);

  // Path-style: the bucket is the first path segment. Any path already present
  // on the endpoint is preserved, so an endpoint behind a reverse-proxy prefix
  // still signs correctly.
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  const canonicalUri = `${basePath}/${encodeRfc3986(input.bucket)}/${encodeObjectKey(input.objectKey)}`;

  // SigV4 requires the query string sorted by encoded key. Building it from a
  // sorted array of pairs rather than from an object literal makes that ordering
  // explicit instead of dependent on JavaScript property order.
  const parameters: readonly (readonly [string, string])[] = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];

  const canonicalQuery = [...parameters]
    .map(([key, value]): readonly [string, string] => [
      encodeRfc3986(key),
      encodeRfc3986(value),
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest(canonicalUri, canonicalQuery, endpoint.host, method)),
  ].join("\n");

  const signature = createHmac(
    "sha256",
    signingKey(input.secretAccessKey, dateStamp, input.region),
  )
    .update(stringToSign, "utf8")
    .digest("hex");

  return `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * A presigned URL that accepts exactly one PUT of one object.
 *
 * Returns the URL only — no headers, no credentials — so the value handed to a
 * browser is self-contained and time-boxed, and our long-lived S3 secret never
 * leaves the server.
 */
export function presignPutUrl(input: PresignInput): string {
  return presign(input, "PUT");
}

/**
 * A presigned URL that reads exactly one object.
 *
 * The way an object in a bucket WITHOUT an anonymous-download policy becomes
 * readable to a browser: the signature IS the authorisation, scoped to one
 * object and one expiry, so a leaked link is worthless once `expiresInSeconds`
 * passes. No caller today (the private label bucket it was written for left
 * with Sendcloud); kept because it is the same proven SigV4 math as the PUT.
 */
export function presignGetUrl(input: PresignInput): string {
  return presign(input, "GET");
}
