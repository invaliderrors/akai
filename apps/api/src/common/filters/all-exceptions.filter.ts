import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import {
  ERROR_STATUS,
  errorCodeSchema,
  stockShortageSchema,
  type ErrorCode,
  type ErrorEnvelope,
  type FieldError,
  type StockShortage,
} from "@akai/contracts";
import { RecordNotFoundError } from "@akai/db";
import { type Logger, getRequestId } from "@akai/observability";

/**
 * Mirrors the `.max(64)` on `errorEnvelopeSchema.error.reason`. Kept as a
 * number rather than derived from the schema because zod does not expose a
 * checks table this can be read from without a cast.
 */
const MAX_REASON_LENGTH = 64;

/**
 * The global exception filter. Every non-2xx response in the platform is
 * produced here, in the single `ErrorEnvelope` shape from @akai/contracts.
 *
 * Why a catch-all rather than per-controller handling: the responses that leak
 * are never the ones someone wrote deliberately. They are the Prisma unique-
 * constraint error that reaches the client with a column name and table
 * structure attached, or the TypeError whose stack trace names internal file
 * paths. Everything funnels through one place so the shape is guaranteed and
 * so nothing internal escapes by default.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: Logger,
    private readonly isProduction: boolean,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { code, status, message, fields, reason, shortage } = this.classify(exception);

    // 5xx is our bug and gets the full exception object (so the stack is
    // captured); 4xx is the caller's problem and logs at warn without noise.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, method: request.method, path: request.url, code },
        "Unhandled exception",
      );
    } else {
      this.logger.warn(
        { method: request.method, path: request.url, code, status },
        message,
      );
    }

    const envelope: ErrorEnvelope = {
      error: {
        code,
        message,
        ...(fields ? { fields } : {}),
        ...(reason === undefined ? {} : { reason }),
        ...(shortage === undefined ? {} : { shortage }),
        requestId: getRequestId(),
        timestamp: new Date().toISOString(),
      },
    };

    response.status(status).json(envelope);
  }

  private classify(exception: unknown): {
    code: ErrorCode;
    status: number;
    message: string;
    fields?: FieldError[];
    /** Domain sub-code, when the thrower attached one. See reasonFromPayload. */
    reason?: string;
    /** Which variant a stock refusal ran short on. See shortageFromPayload. */
    shortage?: StockShortage;
  } {
    // --- zod ---------------------------------------------------------------
    // Field paths and validation messages are safe to return: they describe the
    // caller's own request, not our internals.
    if (exception instanceof ZodError) {
      return {
        code: "VALIDATION_FAILED",
        status: ERROR_STATUS.VALIDATION_FAILED,
        message: "Request validation failed",
        fields: exception.issues.map((issue) => ({
          path: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      };
    }

    // --- ownership-scoped lookups ------------------------------------------
    // 404, never 403: a 403 would confirm the record exists and let an attacker
    // enumerate ids belonging to other customers.
    if (exception instanceof RecordNotFoundError) {
      return {
        code: "NOT_FOUND",
        status: ERROR_STATUS.NOT_FOUND,
        message: `${exception.entity} not found`,
      };
    }

    // --- Nest HttpException -------------------------------------------------
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload: unknown = exception.getResponse();
      const reason = this.reasonFromPayload(payload);
      const shortage = this.shortageFromPayload(payload);
      return {
        // The exception's OWN code wins over the status-derived one.
        //
        // Deriving the code purely from HTTP status collapses every distinct
        // 409 into `CONFLICT`: OUT_OF_STOCK, PRICE_CHANGED,
        // ILLEGAL_STATE_TRANSITION and a genuine uniqueness conflict all
        // arrive as the same string. A cart then cannot tell "someone took the
        // last unit" from "that SKU already exists" — and those need different
        // UI, not a different message. The domain modules already attach the
        // precise code to the exception payload; this reads it.
        //
        // The status-derived code remains the fallback, so a plain
        // `new ForbiddenException()` still produces FORBIDDEN.
        code: this.codeFromPayload(payload) ?? this.codeForStatus(status),
        status,
        message: this.messageFromHttpPayload(payload, exception.message),
        ...this.fieldsFromHttpPayload(payload),
        ...(reason === null ? {} : { reason }),
        ...(shortage === null ? {} : { shortage }),
      };
    }

    // --- anything else ------------------------------------------------------
    // In production the message is a fixed string. An unexpected exception's
    // message routinely contains a connection string, a file path or a SQL
    // fragment, and none of that belongs in an HTTP response.
    return {
      code: "INTERNAL_ERROR",
      status: ERROR_STATUS.INTERNAL_ERROR,
      message: this.isProduction
        ? "An unexpected error occurred"
        : exception instanceof Error
          ? exception.message
          : String(exception),
    };
  }

  /**
   * Read a machine-readable code the domain attached to its exception.
   *
   * Parsed against `errorCodeSchema` rather than trusted, for two reasons: the
   * payload is `unknown` (Nest types `getResponse()` as `string | object`), and
   * an arbitrary string would put a code into the API's public error envelope
   * that no client has ever been told about. An unrecognised value falls back
   * to the status-derived code instead of leaking through.
   */
  private codeFromPayload(payload: unknown): ErrorCode | null {
    if (typeof payload !== "object" || payload === null || !("code" in payload)) {
      return null;
    }
    const parsed = errorCodeSchema.safeParse(payload.code);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Read the domain's machine-readable SUB-code, when it attached one.
   *
   * `code` alone collapses distinct failures that share a status; `reason`
   * collapses distinct failures that share a CODE. Every discount refusal is a
   * VALIDATION_FAILED, so without this the browser cannot tell "spend EUR 10
   * more" (fixable in the cart) from "that code expired" (never fixable) and
   * has to show one useless sentence for both.
   *
   * Narrowed exactly the way `codeFromPayload` narrows — `in` plus `typeof`,
   * no cast — because Nest guarantees nothing about this payload beyond
   * `string | object`. A non-string `reason` is DROPPED rather than coerced:
   * the client parses this against a closed domain enum, and a stringified
   * object would fail that parse looking like contract drift rather than like
   * the bad thrower it is.
   *
   * The length cap mirrors `errorEnvelopeSchema`'s. This filter's contract is
   * that every response it emits parses as an envelope; an over-long reason
   * would fail the client's `.strict()` parse and take `code`, `requestId` and
   * `fields` down with it — turning a precise error into "this did not come
   * from our API at all". Dropping the reason degrades one field instead.
   */
  private reasonFromPayload(payload: unknown): string | null {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("reason" in payload) ||
      typeof payload.reason !== "string"
    ) {
      return null;
    }
    return payload.reason.length <= MAX_REASON_LENGTH ? payload.reason : null;
  }

  /**
   * Read a structured stock shortage (`CartService.assertQuantityAvailable`),
   * PARSED against `stockShortageSchema` for the same reason `reason` is
   * narrowed: every envelope this filter emits must parse on the client, and a
   * malformed shortage would take the code and requestId down with it.
   * Dropped, not repaired, when it does not parse.
   */
  private shortageFromPayload(payload: unknown): StockShortage | null {
    if (typeof payload !== "object" || payload === null || !("shortage" in payload)) {
      return null;
    }
    const parsed = stockShortageSchema.safeParse(payload.shortage);
    return parsed.success ? parsed.data : null;
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return "VALIDATION_FAILED";
      case HttpStatus.UNAUTHORIZED:
        return "UNAUTHENTICATED";
      case HttpStatus.FORBIDDEN:
        return "FORBIDDEN";
      case HttpStatus.NOT_FOUND:
        return "NOT_FOUND";
      case HttpStatus.CONFLICT:
        return "CONFLICT";
      case HttpStatus.PAYMENT_REQUIRED:
        return "PAYMENT_FAILED";
      case HttpStatus.TOO_MANY_REQUESTS:
        return "RATE_LIMITED";
      default:
        return status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? "INTERNAL_ERROR"
          : "VALIDATION_FAILED";
    }
  }

  /**
   * Nest's HttpException payload is `string | object` with no further
   * guarantees, so it is narrowed from `unknown` rather than cast. This is
   * exactly the "external data is unknown + narrowing" rule applied to a
   * framework boundary.
   */
  private messageFromHttpPayload(payload: unknown, fallback: string): string {
    if (typeof payload === "string") {
      return payload;
    }
    if (typeof payload === "object" && payload !== null && "message" in payload) {
      const { message } = payload as { message: unknown };
      if (typeof message === "string") {
        return message;
      }
      // ValidationPipe emits an ARRAY of messages; the detail goes to `fields`.
      if (Array.isArray(message)) {
        return "Request validation failed";
      }
    }
    return fallback;
  }

  private fieldsFromHttpPayload(payload: unknown): { fields?: FieldError[] } {
    if (typeof payload !== "object" || payload === null || !("message" in payload)) {
      return {};
    }
    const { message } = payload as { message: unknown };
    if (!Array.isArray(message)) {
      return {};
    }
    const fields = message
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => ({ path: "(body)", message: entry }));

    return fields.length > 0 ? { fields } : {};
  }
}
