import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny local fake of Sendcloud's v3 HTTP API, for api-e2e suites (spec
 * 2026-09-24-sendcloud-shipping §10: "a fake Sendcloud HTTP server on a local
 * port").
 *
 * It speaks REAL HTTP on 127.0.0.1, so the production `SendcloudClient` is
 * exercised end to end — Basic auth header, query encoding, retries, JSON:API
 * error bodies — just pointed at `fake.baseUrl` instead of
 * `https://panel.sendcloud.sc/api/v3`. Nothing about it is Sendcloud-smart: a
 * suite scripts the responses it needs per route, and asserts on
 * `fake.requests` afterwards.
 *
 * AS THE LIB'S RULE DEMANDS, IT CAN FAIL: any status can be scripted (a 503
 * from the geocoder, a 429 burst, a 409 re-announce), queued one-shot replies
 * model "fail twice, then succeed", and an unscripted route answers a JSON:API
 * 404 — loudly — rather than a plausible success.
 *
 * Usage:
 *   const fake = await startFakeSendcloud();
 *   fake.on("GET", "/service-points", { status: 200, body: fixtureJson });
 *   fake.queue("POST", "/shipments/announce", { status: 503 }, { status: 200, body: shipment });
 *   fake.on("POST", "/service-points/:id/check-availability", (req) => ({
 *     status: 200, body: { data: { is_available: req.params["id"] !== "999" } },
 *   }));
 *   // …configure the API with SENDCLOUD_* and baseUrl = fake.baseUrl…
 *   expect(fake.requestsTo("POST", "/shipments/announce")).toHaveLength(2);
 *   await fake.close();
 */

export type FakeSendcloudMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FakeSendcloudRequest {
  readonly method: string;
  /** Path RELATIVE to the v3 base, e.g. `/service-points/123`. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  /** `:name` segments of the matched route pattern. Empty when unmatched. */
  readonly params: Readonly<Record<string, string>>;
  /** Parsed JSON body, or `undefined` when there was none / it was not JSON. */
  readonly body: unknown;
  readonly rawBody: string;
}

export interface FakeSendcloudReply {
  readonly status: number;
  /** Serialised as JSON unless it is a string or bytes (sent verbatim). */
  readonly body?: unknown;
  /** Defaults to `content-type: application/json` for a non-bytes body. */
  readonly headers?: Readonly<Record<string, string>>;
}

export type FakeSendcloudHandler =
  | FakeSendcloudReply
  | ((request: FakeSendcloudRequest) => FakeSendcloudReply | Promise<FakeSendcloudReply>);

export interface FakeSendcloudServer {
  /** Pass as the Sendcloud base URL: `http://127.0.0.1:<port>/api/v3`. */
  readonly baseUrl: string;
  /** Every request received, in order, matched or not. */
  readonly requests: readonly FakeSendcloudRequest[];
  /** The standing reply for a route (replaces any previous one). `:name` segments match anything. */
  on(method: FakeSendcloudMethod, pattern: string, handler: FakeSendcloudHandler): void;
  /** One-shot replies, consumed in order BEFORE the standing `on()` reply. */
  queue(method: FakeSendcloudMethod, pattern: string, ...replies: FakeSendcloudHandler[]): void;
  /** Requests whose method and path match a pattern. */
  requestsTo(method: FakeSendcloudMethod, pattern: string): readonly FakeSendcloudRequest[];
  /** Forget every route, queued reply and recorded request. */
  reset(): void;
  close(): Promise<void>;
}

const API_PREFIX = "/api/v3";

interface Route {
  readonly method: string;
  readonly pattern: string;
  standing: FakeSendcloudHandler | null;
  readonly queued: FakeSendcloudHandler[];
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const expected = pattern.split("/").filter((segment) => segment !== "");
  const actual = path.split("/").filter((segment) => segment !== "");
  if (expected.length !== actual.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index];
    if (value === undefined) {
      return null;
    }
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = decodeURIComponent(value);
    } else if (segment !== value) {
      return null;
    }
  }
  return params;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseJson(raw: string): unknown {
  if (raw === "") {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return value;
  } catch {
    return undefined;
  }
}

function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers[name.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      headers[name.toLowerCase()] = value.join(", ");
    }
  }
  return headers;
}

function send(response: ServerResponse, reply: FakeSendcloudReply): void {
  const { body } = reply;
  const isBytes = body instanceof Uint8Array;
  const payload =
    body === undefined ? "" : isBytes || typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    ...(isBytes || body === undefined ? {} : { "content-type": "application/json" }),
    ...reply.headers,
  };
  response.writeHead(reply.status, headers);
  response.end(payload);
}

function notFound(method: string, path: string): FakeSendcloudReply {
  return {
    status: 404,
    body: {
      errors: [
        {
          status: "404",
          code: "not_found",
          detail: `Fake Sendcloud has no reply scripted for ${method} ${path}`,
        },
      ],
    },
  };
}

export async function startFakeSendcloud(): Promise<FakeSendcloudServer> {
  const routes: Route[] = [];
  const requests: FakeSendcloudRequest[] = [];

  function routeFor(method: string, pattern: string): Route {
    const existing = routes.find((route) => route.method === method && route.pattern === pattern);
    if (existing !== undefined) {
      return existing;
    }
    const created: Route = { method, pattern, standing: null, queued: [] };
    routes.push(created);
    return created;
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      const path = url.pathname.startsWith(API_PREFIX)
        ? url.pathname.slice(API_PREFIX.length) || "/"
        : url.pathname;
      const rawBody = await readBody(request);

      let matched: { route: Route; params: Record<string, string> } | null = null;
      for (const route of routes) {
        if (route.method !== method) continue;
        const params = matchPattern(route.pattern, path);
        if (params !== null) {
          matched = { route, params };
          break;
        }
      }

      const recorded: FakeSendcloudRequest = {
        method,
        path,
        query: url.searchParams,
        headers: headersOf(request),
        params: matched?.params ?? {},
        body: parseJson(rawBody),
        rawBody,
      };
      requests.push(recorded);

      const handler = matched === null ? null : (matched.route.queued.shift() ?? matched.route.standing);
      const reply =
        handler === null
          ? notFound(method, path)
          : typeof handler === "function"
            ? await handler(recorded)
            : handler;
      send(response, reply);
    })().catch((error: unknown) => {
      send(response, {
        status: 500,
        body: {
          errors: [
            {
              status: "500",
              code: "fake_handler_error",
              detail: error instanceof Error ? error.message : "Fake handler threw",
            },
          ],
        },
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake Sendcloud did not bind a TCP port.");
  }
  const { port }: AddressInfo = address;

  return {
    baseUrl: `http://127.0.0.1:${port}${API_PREFIX}`,
    requests,
    on(method, pattern, handler) {
      routeFor(method, pattern).standing = handler;
    },
    queue(method, pattern, ...replies) {
      routeFor(method, pattern).queued.push(...replies);
    },
    requestsTo(method, pattern) {
      return requests.filter(
        (request) => request.method === method && matchPattern(pattern, request.path) !== null,
      );
    },
    reset() {
      routes.length = 0;
      requests.length = 0;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
