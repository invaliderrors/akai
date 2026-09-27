import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal path-style S3 stand-in on 127.0.0.1: `PUT /{bucket}/{key}` stores
 * the bytes, `GET` returns them (404 when absent). The query string — the
 * SigV4 presign — is accepted and recorded, not verified: the signature math
 * is proven by `s3-presigner`'s own unit tests, and what the label suite needs
 * from storage is that the API really PUTs bytes over HTTP and can read them
 * back for the merge.
 */
export interface FakeObjectStore {
  /** Pass as S3_ENDPOINT. */
  readonly endpoint: string;
  /** `bucket/key` → bytes. */
  readonly objects: Map<string, Buffer>;
  readonly contentTypes: Map<string, string>;
  close(): Promise<void>;
}

export async function startFakeObjectStore(): Promise<FakeObjectStore> {
  const objects = new Map<string, Buffer>();
  const contentTypes = new Map<string, string>();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "PUT") {
        objects.set(key, Buffer.concat(chunks));
        const type = request.headers["content-type"];
        if (typeof type === "string") contentTypes.set(key, type);
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.method === "GET") {
        const body = objects.get(key);
        if (body === undefined) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": contentTypes.get(key) ?? "application/octet-stream" });
        response.end(body);
        return;
      }
      response.writeHead(405);
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake object store did not bind a TCP port");
  }

  return {
    endpoint: `http://127.0.0.1:${String(address.port)}`,
    objects,
    contentTypes,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
