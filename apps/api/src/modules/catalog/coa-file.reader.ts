import type { Clock } from "../auth/ports/clock.port";
import { presignGetUrl } from "../media/s3-presigner";
import { CatalogError } from "./catalog.errors";

/**
 * Reads a product's certificate-of-analysis PDF out of the PRIVATE bucket
 * (`S3_BUCKET_COA`) on the SERVER, for `GET /v1/products/:slug/coa/file`.
 *
 * WHY THE BYTES TRANSIT THE API HERE, when everywhere else a browser is handed
 * a signed URL: the storefront's in-page viewer (PDF.js) `fetch`es the file
 * from the shop's origin, and a presigned bucket URL is a THIRD origin whose
 * CORS policy this codebase does not own. The API already answers the
 * storefront cross-origin, so serving the bytes from it is the one path that
 * needs no bucket configuration. The 302 route stays for "open in a new tab",
 * where CORS does not apply.
 *
 * THE SAME TRICK `S3LabelStorage.get` USES: a presigned GET, minted for
 * seconds and fetched immediately by the server itself — one SigV4
 * implementation, no SDK.
 *
 * BOUNDED. The upload is capped at 10 MB (`createCoaUploadUrlSchema`), so a
 * larger object is not a certificate this platform wrote; it is refused before
 * a byte is sent to the customer, and the read is abandoned as soon as the
 * running total passes the cap — a missing or lying `Content-Length` cannot
 * make the API buffer an unbounded body.
 */

export const COA_FILE_READER = Symbol("COA_FILE_READER");

/** The upload limit (`createCoaUploadUrlSchema`: `sizeBytes ≤ 10 MB`), restated as the read limit. */
export const COA_FILE_MAX_BYTES = 10 * 1024 * 1024;

export interface CoaFileReader {
  /**
   * The object's bytes. Throws `CatalogError` NOT_FOUND when the object is
   * absent from the bucket (a row pointing at a deleted file is, to a
   * customer, a missing certificate), and `CoaFileReadError` for anything
   * else — the store failing, or an object over the cap.
   */
  read(objectKey: string): Promise<Uint8Array>;
}

export class CoaFileReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoaFileReadError";
  }
}

export interface S3CoaFileReaderOptions {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Defaults to `COA_FILE_MAX_BYTES`; injectable so a test need not allocate 10 MB. */
  readonly maxBytes?: number;
}

/** The server-to-bucket leg: seconds, not minutes — it is used immediately. */
const SERVER_URL_TTL_SECONDS = 60;

export class S3CoaFileReader implements CoaFileReader {
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;

  constructor(
    private readonly options: S3CoaFileReaderOptions,
    private readonly clock: Clock,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
    this.maxBytes = options.maxBytes ?? COA_FILE_MAX_BYTES;
  }

  async read(objectKey: string): Promise<Uint8Array> {
    const url = presignGetUrl({
      endpoint: this.options.endpoint,
      bucket: this.options.bucket,
      objectKey,
      region: this.options.region,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      expiresInSeconds: SERVER_URL_TTL_SECONDS,
      now: this.clock.now(),
    });

    const response = await this.fetchImpl(url, { method: "GET" });

    if (response.status === 404) {
      await response.body?.cancel();
      throw CatalogError.notFound("Certificate of analysis");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CoaFileReadError(
        `Reading certificate ${objectKey} failed with status ${String(response.status)}`,
      );
    }

    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      await response.body?.cancel();
      throw new CoaFileReadError(
        `Certificate ${objectKey} is ${String(declared)} bytes, over the ${String(this.maxBytes)}-byte cap`,
      );
    }

    if (response.body === null) {
      throw new CoaFileReadError(`Certificate ${objectKey} came back with no body`);
    }

    // Node's fetch types the body `ReadableStream<any>`; a byte stream is what
    // `fetch` delivers, so the reader is typed at the one place it is created.
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel();
        throw new CoaFileReadError(
          `Certificate ${objectKey} exceeded the ${String(this.maxBytes)}-byte cap while streaming`,
        );
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}
