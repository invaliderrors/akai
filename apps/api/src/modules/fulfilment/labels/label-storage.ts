import type { Clock } from "../../auth/ports/clock.port";
import { presignGetUrl, presignPutUrl } from "../../media/s3-presigner";

/**
 * Where bought label PDFs live (Sendcloud spec §3.5, §3.9, decision D9): the
 * `labels/` prefix of the PRIVATE bucket (`S3_BUCKET_PRIVATE` — no anonymous-read
 * policy), one object per parcel.
 *
 * THE API WRITES AN OBJECT ITSELF FOR THE FIRST TIME here. Everything else in
 * the platform hands the browser a presigned PUT; a label arrives from
 * Sendcloud on the server, so the server PUTs it — through the SAME SigV4
 * presigner (`presignPutUrl`), used as a short-lived URL the server itself
 * fetches. No SDK, no second signing implementation to drift.
 *
 * Reads are the same trick in reverse: `signedUrl` is what the admin download
 * 302s to; `get` is what the bulk print merge reads (a presigned GET the
 * server fetches), so no PDF ever needs a public URL.
 */

export const LABEL_STORAGE = Symbol("LABEL_STORAGE");

export interface LabelStorage {
  /** Idempotent: the same key overwritten with the same bytes is a no-op in effect. */
  put(objectKey: string, pdf: Uint8Array): Promise<void>;
  get(objectKey: string): Promise<Uint8Array>;
  /** A short-lived GET URL for a browser. */
  signedUrl(objectKey: string): string;
}

/** `labels/{orderId}/{parcelId}.pdf` — deterministic, so a retried job overwrites rather than duplicates. */
export function labelObjectKey(orderId: string, parcelId: number): string {
  return `labels/${orderId}/${String(parcelId)}.pdf`;
}

export interface S3LabelStorageOptions {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The download link's lifetime. Default 300 s: long enough to open, useless once leaked. */
  readonly downloadTtlSeconds?: number;
}

/** The server-to-bucket leg: seconds, not minutes — it is used immediately. */
const SERVER_URL_TTL_SECONDS = 60;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 300;

export class LabelStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabelStorageError";
  }
}

export class S3LabelStorage implements LabelStorage {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: S3LabelStorageOptions,
    private readonly clock: Clock,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private presign(objectKey: string, expiresInSeconds: number) {
    return {
      endpoint: this.options.endpoint,
      bucket: this.options.bucket,
      objectKey,
      region: this.options.region,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      expiresInSeconds,
      now: this.clock.now(),
    };
  }

  async put(objectKey: string, pdf: Uint8Array): Promise<void> {
    const url = presignPutUrl(this.presign(objectKey, SERVER_URL_TTL_SECONDS));
    const response = await this.fetchImpl(url, {
      method: "PUT",
      // `content-type` is NOT a signed header (the presigner signs `host`
      // only), so it may be set here and S3 stores it — which is what makes a
      // browser render the downloaded object as a PDF.
      headers: { "content-type": "application/pdf" },
      body: pdf,
    });
    if (!response.ok) {
      throw new LabelStorageError(
        `Storing label ${objectKey} failed with status ${String(response.status)}`,
      );
    }
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const url = presignGetUrl(this.presign(objectKey, SERVER_URL_TTL_SECONDS));
    const response = await this.fetchImpl(url, { method: "GET" });
    if (!response.ok) {
      throw new LabelStorageError(
        `Reading label ${objectKey} failed with status ${String(response.status)}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  signedUrl(objectKey: string): string {
    return presignGetUrl(
      this.presign(objectKey, this.options.downloadTtlSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS),
    );
  }
}
