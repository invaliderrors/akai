/**
 * Seed-time media publishing: put the fixture images into the OBJECT STORE and
 * report the URL they are readable at.
 *
 * WHY THIS EXISTS AT ALL. The seed used to write media rows pointing at
 * `http://localhost:3100/carousel/…` — the storefront's own dev server serving
 * its own `public/` directory. Two things were wrong with that, and only the
 * second one was visible:
 *
 *  1. It made the API's catalogue depend on the FRONTEND being up, and up on one
 *     specific port. Run the storefront on any other port (Playwright's dev
 *     server binds 3002) and every `next/image` optimiser fetch is refused —
 *     `[TypeError: fetch failed] { cause: ECONNREFUSED }`, images simply absent,
 *     and no failing test anywhere because `next.config.ts` deliberately does
 *     not pin loopback ports, so `remotePatterns` matches and the request is
 *     merely made and refused.
 *  2. It contradicted every other statement in the system about where media
 *     lives: `MediaService.publicUrl` builds `${S3_ENDPOINT}/${S3_BUCKET}/${key}`,
 *     `next.config.ts` defaults `NEXT_PUBLIC_MEDIA_URL` to MinIO on 9002, and
 *     `.env.example` documents the same. The seed was the only dissenting voice.
 *
 * The fix is not to point the seed at the bucket and hope: an object-store URL
 * for bytes nobody uploaded is a 404, which is strictly worse than the text
 * fallback it replaces. The seed UPLOADS the fixtures first, with the same
 * presigner the admin upload route uses, and only then records their public URL.
 *
 * Everything here is a pure function or takes its `fetch` as a parameter, so the
 * key derivation, the URL construction and the failure handling are unit-tested
 * without a network or a running MinIO.
 */

import { extname } from "node:path";
import { z } from "zod";

import {
  CONTENT_TYPE_EXTENSIONS,
  uploadContentTypeSchema,
  type UploadContentType,
} from "../modules/media/media.dto";
import { encodeObjectKey, presignPutUrl } from "../modules/media/s3-presigner";

/**
 * Namespace owned by the seed. EVERYTHING the seed has ever written lives here,
 * including the pre-object-store keys (`seed/carousel/…`) still sitting in
 * existing developer databases.
 *
 * It is deliberately broader than `SEED_MEDIA_PREFIX`, because it is the
 * predicate the prune uses: a row under this root is disposable fixture data,
 * and a row outside it was uploaded by a human through
 * `POST /v1/admin/media/upload-url` and must never be deleted.
 */
export const SEED_MEDIA_ROOT = "seed/";

/** Key prefix for the keys this version of the seed writes. */
export const SEED_MEDIA_PREFIX = `${SEED_MEDIA_ROOT}products/`;

/**
 * How long the seed's own upload URLs are valid.
 *
 * Sixty seconds: the URL is minted and consumed in the same statement, never
 * leaves this process, and a short expiry means a signature captured from a
 * debug log is dead before anyone reads it.
 */
const UPLOAD_URL_TTL_SECONDS = 60;

/**
 * Extension → content type, DERIVED from the admin route's mapping rather than
 * restated.
 *
 * A second hand-written table is how you end up serving a PNG as `image/jpeg`
 * in dev only. Inverting the one that already exists means the closed set of
 * hostable types (no SVG — it executes JavaScript on our origin) governs the
 * seed too, for free.
 */
const EXTENSION_CONTENT_TYPES: ReadonlyMap<string, UploadContentType> = new Map(
  uploadContentTypeSchema.options.map((contentType): [string, UploadContentType] => [
    CONTENT_TYPE_EXTENSIONS[contentType],
    contentType,
  ]),
);

/**
 * The content type for a fixture file name.
 *
 * THROWS on an unknown extension rather than defaulting to
 * `application/octet-stream`: a browser will not render an octet-stream as an
 * image, so the default would upload successfully and produce a broken image —
 * the exact class of failure this module exists to remove. A seed asset with an
 * extension we cannot host is an authoring mistake, and it should stop the run.
 */
export function seedContentType(fileName: string): UploadContentType {
  const extension = extname(fileName).replace(/^\./, "").toLowerCase();
  const contentType = EXTENSION_CONTENT_TYPES.get(extension);

  if (contentType === undefined) {
    throw new Error(
      `Seed asset "${fileName}" has unsupported extension ".${extension}". ` +
        `Supported: ${[...EXTENSION_CONTENT_TYPES.keys()].join(", ")}.`,
    );
  }

  return contentType;
}

/**
 * Where a fixture lands in the bucket.
 *
 * DETERMINISTIC, unlike `MediaService.buildObjectKey`, which appends random
 * bytes so a customer-facing key is unguessable. The seed needs the opposite
 * property: re-running it must overwrite the same object and match the same
 * `media_asset` row, otherwise every run appends a duplicate image. Nothing
 * secret lives under this prefix — it is three product photos in the repository.
 */
export function seedObjectKey(productSlug: string, fileName: string): string {
  return `${SEED_MEDIA_PREFIX}${productSlug}/${fileName}`;
}

/**
 * Whether a stored key belongs to the seed, and may therefore be pruned.
 *
 * Matches the ROOT, not the current prefix, so a re-run cleans up the media
 * rows an OLDER seed wrote. That is not housekeeping: the previous seed pointed
 * media at `http://localhost:3100/carousel/…`, and leaving those rows behind
 * would show every developer two images per product, one of which never loads.
 */
export function isSeedObjectKey(objectKey: string): boolean {
  return objectKey.startsWith(SEED_MEDIA_ROOT);
}

/**
 * The object store the seed writes to and the origin it advertises.
 *
 * `publicBaseUrl` is OPTIONAL and separate from `endpoint` on purpose: the
 * address a writer reaches the bucket at is not always the address a browser
 * reaches it at. Inside docker compose the API talks to `http://minio:9000`,
 * which no browser can resolve, and in production the customer-facing origin is
 * a CDN in front of the bucket. Unset — the normal case, a seed run from the
 * host — the public origin is derived from the endpoint, exactly as
 * `MediaService.publicUrl` derives it.
 */
export interface SeedMediaTarget {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly publicBaseUrl?: string;
}

/**
 * Environment the seed needs to publish media.
 *
 * `.strict()`, and fed a PROJECTION of `process.env` rather than the whole of
 * it — a strict schema over the raw environment would reject every unrelated
 * variable the shell happens to export. Same four variables the API itself
 * validates at boot, so a seed that can publish and an API that can sign are
 * the same configuration.
 */
export const seedMediaEnvSchema = z
  .object({
    S3_ENDPOINT: httpUrl(),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    SEED_MEDIA_PUBLIC_BASE_URL: httpUrl().optional(),
  })
  .strict();

/**
 * An absolute http(s) URL.
 *
 * `.url()` ALONE IS NOT ENOUGH here, and the gap is not academic: `localhost:9002`
 * parses as a valid URL whose protocol is `localhost:`, so zod accepts it — and
 * then `new URL(endpoint).origin` evaluates to the string "null", the presigner
 * signs a request against host "", and the failure surfaces as an unreadable
 * signature mismatch rather than as the typo it is.
 */
function httpUrl(): z.ZodEffects<z.ZodString, string, string> {
  return z.string().refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "must be an absolute http:// or https:// URL" },
  );
}

/**
 * Read the object-store configuration out of an environment.
 *
 * Takes the source explicitly so a test never has to mutate `process.env`.
 * Absent keys are OMITTED rather than passed as `undefined`, because
 * `exactOptionalPropertyTypes` makes those two different things and
 * `z.string().url().optional()` accepts the former, not an explicit undefined
 * under a strict object.
 */
export function parseSeedMediaEnv(source: NodeJS.ProcessEnv): SeedMediaTarget {
  const publicBase = source["SEED_MEDIA_PUBLIC_BASE_URL"];

  const parsed = seedMediaEnvSchema.parse({
    S3_ENDPOINT: source["S3_ENDPOINT"],
    S3_BUCKET: source["S3_BUCKET"],
    S3_ACCESS_KEY_ID: source["S3_ACCESS_KEY_ID"],
    S3_SECRET_ACCESS_KEY: source["S3_SECRET_ACCESS_KEY"],
    ...(publicBase === undefined || publicBase === "" ? {} : { SEED_MEDIA_PUBLIC_BASE_URL: publicBase }),
  });

  return {
    endpoint: parsed.S3_ENDPOINT,
    bucket: parsed.S3_BUCKET,
    accessKeyId: parsed.S3_ACCESS_KEY_ID,
    secretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
    ...(parsed.SEED_MEDIA_PUBLIC_BASE_URL === undefined
      ? {}
      : { publicBaseUrl: parsed.SEED_MEDIA_PUBLIC_BASE_URL }),
  };
}

/**
 * Where an uploaded object is readable.
 *
 * Mirrors `MediaService.publicUrl` — same `${origin}/${bucket}/${key}` shape —
 * so a seeded image and an admin-uploaded one are indistinguishable to the
 * storefront and both are matched by the SAME `next/image` remote pattern. The
 * key is percent-encoded because it is a path, not a string: an unencoded space
 * produces a URL that `z.string().url()` accepts and the optimiser rejects.
 */
export function seedPublicUrl(target: SeedMediaTarget, objectKey: string): string {
  return `${seedMediaBaseUrl(target)}/${encodeObjectKey(objectKey)}`;
}

/**
 * The origin every seeded media URL hangs off, with no trailing slash.
 *
 * Exported so the seed can PRINT it: "where did my images go" is the first
 * question a broken image raises, and the answer being one line of seed output
 * is the difference between a two-minute check and an afternoon.
 */
export function seedMediaBaseUrl(target: SeedMediaTarget): string {
  return (target.publicBaseUrl ?? `${target.endpoint}/${target.bucket}`).replace(/\/+$/, "");
}

/** The subset of `fetch` this module uses. Injected so tests need no network. */
export type SeedFetch = (
  url: string,
  init: {
    readonly method: "PUT";
    readonly body: Uint8Array;
    readonly headers: Readonly<Record<string, string>>;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

export interface UploadSeedObjectInput {
  readonly target: SeedMediaTarget;
  readonly objectKey: string;
  readonly body: Uint8Array;
  readonly contentType: UploadContentType;
  /** Signing time. A parameter so the signature is reproducible under test. */
  readonly now: Date;
  readonly fetchImpl: SeedFetch;
}

/**
 * PUT one object into the bucket.
 *
 * Uses the presigner rather than signing headers because it is already here,
 * already tested, and produces a URL that needs no `Authorization` header — so
 * the request is a plain PUT with a body.
 *
 * A NON-2xx RESPONSE THROWS, carrying the status and the store's own error body.
 * Swallowing it would leave a `media_asset` row pointing at an object that does
 * not exist, which is precisely the "URL that 404s" failure this module was
 * written to avoid; and S3 error bodies say useful things like `NoSuchBucket`.
 */
export async function uploadSeedObject(input: UploadSeedObjectInput): Promise<void> {
  const uploadUrl = presignPutUrl({
    endpoint: input.target.endpoint,
    bucket: input.target.bucket,
    objectKey: input.objectKey,
    region: "us-east-1",
    accessKeyId: input.target.accessKeyId,
    secretAccessKey: input.target.secretAccessKey,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    now: input.now,
  });

  const response = await input.fetchImpl(uploadUrl, {
    method: "PUT",
    body: input.body,
    // Not covered by the signature (SignedHeaders is `host`), but it is what the
    // store records as the object's content type and therefore what it serves
    // back. Omitting it makes MinIO answer with application/octet-stream and the
    // browser refuse to render the image.
    headers: { "content-type": input.contentType },
  });

  if (!response.ok) {
    const detail = await safeBody(response);
    throw new Error(
      `Upload of "${input.objectKey}" failed: HTTP ${String(response.status)}${detail}`,
    );
  }
}

/**
 * The response body, or nothing.
 *
 * A store that refuses the PUT may also refuse to produce a readable body, and
 * an error thrown while REPORTING an error destroys the original diagnosis. The
 * status code is the part that always survives.
 */
async function safeBody(response: {
  text(): Promise<string>;
}): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text === "" ? "" : ` — ${text.slice(0, 500)}`;
  } catch {
    return "";
  }
}
