import { Inject, Injectable } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";
import { z } from "zod";

import { SERVER_CONFIG } from "../../config/config.module";
import { LOGGER } from "../../observability/logger.module";
import {
  PaymentProviderRequestError,
  PaymentProviderUnavailableError,
  PaymentsNotConfiguredError,
} from "../payments.errors";
import { wompiTransactionSchema, type WompiTransaction } from "./wompi-events";
import type { WompiGateway } from "./wompi.gateway";

/** Exactly the configuration this adapter reads. */
export type WompiGatewayConfig = Pick<ServerEnv, "wompi">;

/** `fetch`, narrowed to what this adapter uses — the test seam. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const WOMPI_FETCH = Symbol("WOMPI_FETCH");

/** A Wompi call that has not answered in this long is treated as unavailable. */
const REQUEST_TIMEOUT_MS = 10_000;

/** `{ data: <transaction> }` — the envelope Wompi wraps a resource in. */
const transactionResponseSchema = z.object({ data: wompiTransactionSchema });

/**
 * Normalise a configured base URL to the API ROOT, without a trailing slash or
 * `/v1`.
 *
 * Carried over from the reference implementation, where a base URL configured
 * as `https://production.wompi.co/v1` produced `/v1/v1/…` and 404ed. The base
 * is derived from `WOMPI_ENVIRONMENT` here, so this is belt-and-braces — but it
 * is what makes the path below unambiguous.
 */
export function normaliseWompiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Pull a human-readable reason out of a Wompi error body, or `null`.
 *
 * Wompi answers errors as `{ error: { type, reason | messages } }`; the shapes
 * vary by endpoint, so each is tried in turn. Parsed, not cast.
 */
export function wompiErrorReason(body: unknown): string | null {
  const parsed = z
    .object({
      error: z
        .object({
          reason: z.string().optional(),
          message: z.string().optional(),
          type: z.string().optional(),
          messages: z.unknown().optional(),
        })
        .optional(),
      message: z.string().optional(),
    })
    .safeParse(body);

  if (!parsed.success) {
    return null;
  }

  const error = parsed.data.error;
  if (error?.reason !== undefined) return error.reason;
  if (error?.message !== undefined) return error.message;

  const list = z.array(z.string()).nonempty().safeParse(error?.messages);
  if (list.success) {
    return list.data[0];
  }

  // `{ field: ["is invalid"] }` — name the first field rather than dump it.
  const byField = z.record(z.unknown()).safeParse(error?.messages);
  if (byField.success) {
    const [first] = Object.entries(byField.data);
    if (first !== undefined) {
      const [field, detail] = first;
      const reasons = z.array(z.string()).nonempty().safeParse(detail);
      return reasons.success ? `${field}: ${reasons.data[0]}` : field;
    }
  }

  if (error?.type !== undefined) return error.type;
  return parsed.data.message ?? null;
}

/**
 * The live Wompi adapter: `fetch`, the private key, one endpoint.
 *
 * Failures are split the only way a caller needs: retry later
 * (`PaymentProviderUnavailableError` — transport, timeout, 429, 5xx) or never
 * send this again (`PaymentProviderRequestError`). The response BODY is never
 * logged whole — it is the provider's raw transaction and carries the payer's
 * email; only the extracted reason is.
 */
@Injectable()
export class LiveWompiGateway implements WompiGateway {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: WompiGatewayConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(WOMPI_FETCH) private readonly fetchImpl: FetchLike,
  ) {}

  async getTransaction(transactionId: string): Promise<WompiTransaction | null> {
    const wompi = this.config.wompi;
    if (wompi === null) {
      throw new PaymentsNotConfiguredError();
    }

    const operation = "getTransaction";
    const url = `${normaliseWompiBaseUrl(wompi.apiBaseUrl)}/v1/transactions/${encodeURIComponent(transactionId)}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${wompi.privateKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn({ operation }, "Wompi request failed before a response");
      throw new PaymentProviderUnavailableError(operation, describe(error));
    }

    if (response.status === 404) {
      return null;
    }

    const body = await readJson(response);

    if (!response.ok) {
      const reason = wompiErrorReason(body) ?? `HTTP ${String(response.status)}`;
      const retryable = response.status === 429 || response.status >= 500;

      this.logger.error(
        { operation, statusCode: response.status, retryable, reason },
        "Wompi rejected a request",
      );

      if (retryable) {
        throw new PaymentProviderUnavailableError(operation, reason);
      }
      throw new PaymentProviderRequestError(operation, response.status, null, reason);
    }

    const parsed = transactionResponseSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.error(
        { operation, issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
        "Wompi returned a transaction we could not parse",
      );
      throw new PaymentProviderRequestError(
        operation,
        response.status,
        null,
        "unreadable transaction body",
      );
    }

    return parsed.data.data;
  }
}

/** The body as JSON, or `null` when it is not JSON — never a throw. */
async function readJson(response: Response): Promise<unknown> {
  try {
    const parsed: unknown = await response.json();
    return parsed;
  } catch {
    return null;
  }
}

/** A message for a log line, without assuming the thrown value is an Error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
