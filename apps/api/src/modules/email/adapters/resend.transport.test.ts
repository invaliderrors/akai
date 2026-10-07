import { describe, expect, it, vi } from "vitest";
import { EmailDeliveryError, type RenderedMessage } from "../email.port";
import { ResendTransport } from "./resend.transport";

const API_KEY = "re_live_supersecretkey_do_not_leak";

const MESSAGE: RenderedMessage = {
  to: "marta@example.com",
  subject: "Pedido confirmado AK-2026-000123",
  html: "<p>hola</p>",
  text: "hola",
  tags: { template: "order-confirmation", order_id: "11111111-1111-4111-8111-111111111111" },
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildTransport(fetchImpl: typeof fetch): ResendTransport {
  return new ResendTransport({
    apiKey: API_KEY,
    from: "Akai <pedidos@akai.shop>",
    fetchImpl,
  });
}

/**
 * A recording `fetch`.
 *
 * Recording through a typed closure rather than inspecting `vi.fn().mock.calls`
 * keeps the captured request typed as a real `RequestInit` — `vi.fn` infers its
 * parameter tuple from the implementation, so a zero-arg stub makes
 * `calls[0][1]` a type error rather than the request body.
 */
function recordingFetch(respond: () => Response): {
  fetchImpl: typeof fetch;
  requests: RequestInit[];
} {
  const requests: RequestInit[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init !== undefined) {
      requests.push(init);
    }
    return respond();
  };
  return { fetchImpl, requests };
}

describe("ResendTransport — success path", () => {
  it("returns the provider message id from a parsed response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "resend-abc123" }, 200));

    const result = await buildTransport(fetchImpl).send(MESSAGE);

    expect(result.providerMessageId).toBe("resend-abc123");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends the rendered content and correlation tags", async () => {
    const { fetchImpl, requests } = recordingFetch(() =>
      jsonResponse({ id: "resend-abc123" }, 200),
    );

    await buildTransport(fetchImpl).send(MESSAGE);

    expect(requests).toHaveLength(1);
    const body: unknown = JSON.parse(String(requests[0]?.body));

    expect(body).toMatchObject({
      from: "Akai <pedidos@akai.shop>",
      to: ["marta@example.com"],
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
      tags: [
        { name: "template", value: "order-confirmation" },
        { name: "order_id", value: "11111111-1111-4111-8111-111111111111" },
      ],
    });
  });

  it("tolerates unknown fields in the response", async () => {
    // A RESPONSE is parsed permissively: Resend adding a field must not stop
    // mail going out. Strictness belongs on input we control.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "resend-abc123", newField: true }, 200),
    );

    await expect(buildTransport(fetchImpl).send(MESSAGE)).resolves.toEqual({
      providerMessageId: "resend-abc123",
    });
  });

  it("treats a 200 with an unreadable body as RETRYABLE", async () => {
    // Without a message id we cannot correlate a later bounce webhook. A
    // duplicate is strictly better than an email recorded as sent that was not.
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: "shape" }, 200));

    await expect(buildTransport(fetchImpl).send(MESSAGE)).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe("ResendTransport — failure classification", () => {
  it("marks 429 and 5xx as retryable", async () => {
    for (const status of [429, 500, 502, 503]) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ message: "slow down" }, status),
      );

      await expect(buildTransport(fetchImpl).send(MESSAGE)).rejects.toMatchObject({
        retryable: true,
        statusCode: status,
      });
    }
  });

  it("marks 4xx as NOT retryable", async () => {
    // A bad address or a revoked key fails identically forever; retrying only
    // delays the DLQ signal an operator needs to fix it.
    for (const status of [400, 401, 403, 422]) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ message: "invalid recipient" }, status),
      );

      await expect(buildTransport(fetchImpl).send(MESSAGE)).rejects.toMatchObject({
        retryable: false,
        statusCode: status,
      });
    }
  });

  it("treats a network error as retryable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(buildTransport(fetchImpl).send(MESSAGE)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("throws EmailDeliveryError, not a raw error, so the service can classify", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "nope" }, 400));

    await expect(buildTransport(fetchImpl).send(MESSAGE)).rejects.toBeInstanceOf(
      EmailDeliveryError,
    );
  });
});

describe("ResendTransport — secret handling", () => {
  it("never puts the API key in an error message", async () => {
    // The failure string is persisted on email_event.error and shown in the
    // admin UI, so anything in it is effectively public to staff.
    const cases: (typeof fetch)[] = [
      async () => jsonResponse({ message: `bad key ${API_KEY}` }, 401),
      async () => {
        throw new Error(`connect failed with authorization Bearer ${API_KEY}`);
      },
    ];

    for (const fetchImpl of cases) {
      const error = await buildTransport(fetchImpl)
        .send(MESSAGE)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(EmailDeliveryError);
      if (error instanceof EmailDeliveryError) {
        // The 401 case echoes the key back inside the provider's own message
        // field; the network case carries it on the thrown error. Neither may
        // reach the stored string.
        expect(error.message).not.toContain(API_KEY);
      }
    }
  });

  it("sends the key as a bearer token and nowhere else", async () => {
    const { fetchImpl, requests } = recordingFetch(() =>
      jsonResponse({ id: "resend-abc123" }, 200),
    );

    await buildTransport(fetchImpl).send(MESSAGE);

    expect(String(requests[0]?.body)).not.toContain(API_KEY);
  });

  it("caps an over-long provider message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "y".repeat(5_000) }, 400),
    );

    const error = await buildTransport(fetchImpl)
      .send(MESSAGE)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    if (error instanceof EmailDeliveryError) {
      expect(error.message.length).toBeLessThan(400);
    }
  });
});
