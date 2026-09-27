import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { emailTemplateKeySchema } from "@akai/contracts";
import { LOGGER } from "../observability/logger.module";
import { PrismaService } from "../prisma/prisma.service";
import { InMemoryEmailTransport } from "./adapters/in-memory.transport";
import { LoggingTransport } from "./adapters/logging.transport";
import { ResendTransport } from "./adapters/resend.transport";
import { EmailPortAdapter } from "./email-port.adapter";
import {
  DEFAULT_EMAIL_RETRY_POLICY,
  EMAIL_RETRY_POLICY,
  EMAIL_SLEEPER,
  EMAIL_TRANSPORT,
  EmailDeliveryError,
  type EmailTransportConfig,
  type TransportLogger,
} from "./email.port";
import { createEmailTransport } from "./email.module";
import { EmailService } from "./email.service";
import { EMAIL_TEMPLATE_PAYLOADS } from "./email.templates";

/**
 * A real `TransportLogger`, no cast required — which is the payoff of narrowing
 * the dependency to `Pick<Logger, "info">` rather than taking all of pino.
 */
function buildLogger(): TransportLogger & { info: ReturnType<typeof vi.fn> } {
  return { info: vi.fn() };
}

function buildConfig(overrides: Partial<EmailTransportConfig>): EmailTransportConfig {
  return {
    EMAIL_TRANSPORT: "smtp",
    EMAIL_FROM: "pedidos@akai.shop",
    ...overrides,
  };
}

describe("createEmailTransport", () => {
  it("selects Resend when configured for it", () => {
    const transport = createEmailTransport(
      buildConfig({ EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_test_key" }),
      buildLogger(),
    );

    expect(transport).toBeInstanceOf(ResendTransport);
    expect(transport.name).toBe("resend");
  });

  it("selects the local transport otherwise", () => {
    const transport = createEmailTransport(
      buildConfig({ EMAIL_TRANSPORT: "smtp" }),
      buildLogger(),
    );

    expect(transport).toBeInstanceOf(LoggingTransport);
  });

  it("refuses to build a Resend transport without a key", () => {
    // libs/config's cross-field rule already guarantees this, but that
    // guarantee lives in another file and the compiler cannot see it. Throwing
    // is the alternative to the banned non-null assertion.
    for (const key of [undefined, ""]) {
      expect(() =>
        createEmailTransport(
          buildConfig({ EMAIL_TRANSPORT: "resend", RESEND_API_KEY: key }),
          buildLogger(),
        ),
      ).toThrow(/RESEND_API_KEY/);
    }
  });
});

describe("LoggingTransport", () => {
  it("logs the subject but never the body", async () => {
    const logger = buildLogger();
    const transport = new LoggingTransport(logger);

    const result = await transport.send({
      to: "marta@example.com",
      subject: "Pedido confirmado",
      html: "<p>reset link https://akai.shop/reset?token=SECRET</p>",
      text: "reset link https://akai.shop/reset?token=SECRET",
      tags: { template: "reset-password", locale: "es" },
    });

    expect(result.providerMessageId).toMatch(/^local-/);
    const logged = JSON.stringify(logger.info.mock.calls);
    // Dev logs get pasted into issues; a live reset link in one is a credential.
    expect(logged).not.toContain("SECRET");
    expect(logged).toContain("Pedido confirmado");
  });
});

// ---------------------------------------------------------------------------
// The port adapter, exercised over a REAL EmailService — the bridge is only
// worth testing end to end, since its whole job is delegating faithfully.
// ---------------------------------------------------------------------------

interface AdapterHarness {
  adapter: EmailPortAdapter;
  transport: InMemoryEmailTransport;
}

class MinimalPrisma {
  private sequence = 0;
  readonly emailEvent = {
    create: async (): Promise<{ id: string }> => {
      this.sequence += 1;
      return { id: `event-${this.sequence}` };
    },
    update: async (): Promise<{ id: string }> => ({ id: "event-1" }),
    findUnique: async (): Promise<null> => null,
  };
  readonly emailSuppression = {
    findUnique: async (): Promise<null> => null,
  };
}

async function buildAdapter(): Promise<AdapterHarness> {
  const transport = new InMemoryEmailTransport();

  const moduleRef = await Test.createTestingModule({
    providers: [
      EmailService,
      EmailPortAdapter,
      { provide: PrismaService, useValue: new MinimalPrisma() },
      { provide: EMAIL_TRANSPORT, useValue: transport },
      { provide: LOGGER, useValue: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      { provide: EMAIL_SLEEPER, useValue: async (): Promise<void> => undefined },
      { provide: EMAIL_RETRY_POLICY, useValue: DEFAULT_EMAIL_RETRY_POLICY },
    ],
  }).compile();

  return { adapter: moduleRef.get(EmailPortAdapter), transport };
}

const PORT_INPUT = {
  to: "marta@example.com",
  templateKey: "verify-email",
  locale: "es",
  data: {
    firstName: "Marta",
    verifyUrl: "https://akai.shop/verify?token=abc",
    expiresInHours: 24,
  },
} as const;

describe("EmailPortAdapter", () => {
  it("returns the provider id for a successful send", async () => {
    const { adapter } = await buildAdapter();

    await expect(adapter.send(PORT_INPUT)).resolves.toEqual({
      providerMessageId: "in-memory-1",
    });
  });

  it("throws rather than inventing a message id when delivery failed", async () => {
    const { adapter, transport } = await buildAdapter();
    transport.failPermanently();

    // The port's signature promises a SendEmailResult; fabricating one for a
    // send that did not happen would be a lie the caller cannot detect.
    await expect(adapter.send(PORT_INPUT)).rejects.toBeInstanceOf(EmailDeliveryError);
  });

  it("CLOSES the port's untyped `data` by parsing it against the template", async () => {
    const { adapter, transport } = await buildAdapter();

    // The contracts interface types `data` as Record<string, unknown>. That
    // hole is closed here, not left for the renderer to trip over.
    await expect(
      adapter.send({ ...PORT_INPUT, data: { firstName: "Marta" } }),
    ).rejects.toThrow();
    expect(transport.messages).toHaveLength(0);
  });
});

describe("template registry totality", () => {
  it("declares a payload schema for every template key in the contract", () => {
    // The `satisfies Record<EmailTemplateKey, …>` makes this a compile error
    // too; asserting it at runtime as well means the guarantee survives even if
    // someone weakens the annotation.
    for (const key of emailTemplateKeySchema.options) {
      expect(EMAIL_TEMPLATE_PAYLOADS[key], `no payload schema for ${key}`).toBeDefined();
    }
  });

  it("has no payload schema for a key outside the contract", () => {
    const declared = Object.keys(EMAIL_TEMPLATE_PAYLOADS).sort();
    expect(declared).toEqual([...emailTemplateKeySchema.options].sort());
  });
});
