import { HttpException } from "@nestjs/common";
import {
  ERROR_STATUS,
  type ErrorCode,
  type InventoryAdjustFailureReason,
} from "@akai/contracts";

/**
 * A catalog failure that already knows its machine-readable ErrorCode.
 *
 * KNOWN GAP, FLAGGED RATHER THAN PAPERED OVER: the global AllExceptionsFilter
 * derives the envelope `code` from the HTTP STATUS, so every 409 it emits comes
 * out as `CONFLICT`. That collapses three genuinely different conditions —
 * `CONFLICT` (duplicate slug), `OUT_OF_STOCK` (oversell) and `PRICE_CHANGED` —
 * into one code, which is precisely the distinction §7 of the contracts says
 * clients must be able to branch on. A cart cannot tell "someone took the last
 * unit" from "that SKU already exists".
 *
 * The filter is owned by another module, so this does not edit it. Instead the
 * intended code is carried on the exception payload under `code`, and the filter
 * needs a small change to prefer it over the status lookup (see followUps).
 * Until then the STATUS is already correct and the message is precise; only the
 * code is coarse. Nothing in this module changes when the filter is fixed.
 */
export class CatalogError extends HttpException {
  public readonly code: ErrorCode;
  /**
   * The envelope's domain sub-code, when one narrows `code`. The global filter
   * reads it off the payload and emits it as `reason`. Typed as the closed
   * contracts enum, so the server cannot emit a reason no client can parse.
   */
  public readonly reason: InventoryAdjustFailureReason | null;

  constructor(code: ErrorCode, message: string, reason?: InventoryAdjustFailureReason) {
    super(
      reason === undefined ? { code, message } : { code, reason, message },
      ERROR_STATUS[code],
    );
    this.code = code;
    this.reason = reason ?? null;
    this.name = "CatalogError";
  }

  static notFound(entity: string): CatalogError {
    return new CatalogError("NOT_FOUND", `${entity} not found`);
  }

  /**
   * Duplicate slug or SKU. The message names the field but NEVER echoes the
   * conflicting row's owner or id — for a catalog that is harmless, but the
   * habit is what keeps the same helper safe when it is copied to a table that
   * is customer-scoped.
   */
  static conflict(message: string): CatalogError {
    return new CatalogError("CONFLICT", message);
  }

  /**
   * A write lost an optimistic-concurrency race. Surfaced as a distinct message
   * from a duplicate-key conflict because the correct client response differs:
   * refetch and retry, versus change the input.
   */
  static staleWrite(entity: string): CatalogError {
    return new CatalogError(
      "CONFLICT",
      `${entity} was modified by another write; refetch and retry`,
    );
  }

  static outOfStock(message: string): CatalogError {
    return new CatalogError("OUT_OF_STOCK", message);
  }

  /**
   * A manual stock adjustment the current stock cannot take. The reason picks
   * the code: a stale expectation is a CONFLICT (re-read and retry), while a
   * write-down below what is reserved or below zero is OUT_OF_STOCK.
   */
  static adjustRefused(reason: InventoryAdjustFailureReason): CatalogError {
    switch (reason) {
      case "STOCK_CHANGED":
        return new CatalogError(
          "CONFLICT",
          "Stock on hand changed since it was read; refetch and retry",
          reason,
        );
      case "BELOW_RESERVED":
        return new CatalogError(
          "OUT_OF_STOCK",
          "Adjustment would drop stock below the quantity already reserved",
          reason,
        );
      case "NEGATIVE_STOCK":
        return new CatalogError(
          "OUT_OF_STOCK",
          "Variant has no stock record; a first adjustment cannot be negative",
          reason,
        );
    }
  }

  static validation(message: string): CatalogError {
    return new CatalogError("VALIDATION_FAILED", message);
  }
}
