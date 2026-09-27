import { HttpException } from "@nestjs/common";
import {
  ERROR_STATUS,
  type DiscountFailureReason,
  type ErrorCode,
} from "@akai/contracts";

/**
 * A discount failure that carries its machine-readable ErrorCode and a stable
 * `reason` a client can branch on to show the right message ("code expired" vs
 * "spend €10 more to use this code").
 *
 * Every reason maps to 400 VALIDATION_FAILED (`ERROR_STATUS.VALIDATION_FAILED`):
 * an unusable code is a bad input, not a missing resource — and answering
 * NOT_FOUND would let someone probe which codes exist. The message never echoes
 * internal caps or another customer's redemption history.
 *
 * The `reason` reaches the client because the global exception filter reads it
 * off this payload and emits it as the error envelope's `reason` member; the
 * shared status is exactly why that member exists, since the code alone cannot
 * separate these six failures from one another.
 *
 * `DiscountFailureReason` is IMPORTED from @akai/contracts rather than
 * restated here. The union is half of a wire contract — the client parses the
 * envelope's `reason` against `discountFailureReasonSchema` — and two
 * declarations of it drift the day someone adds a seventh reason on one side.
 */
export class DiscountError extends HttpException {
  public readonly code: ErrorCode;
  public readonly reason: DiscountFailureReason;

  private constructor(reason: DiscountFailureReason, message: string) {
    const code: ErrorCode = "VALIDATION_FAILED";
    super({ code, reason, message }, ERROR_STATUS[code]);
    this.code = code;
    this.reason = reason;
    this.name = "DiscountError";
  }

  /** Unknown or deleted code — deliberately indistinguishable from a typo. */
  static invalidCode(): DiscountError {
    return new DiscountError("INVALID_CODE", "That discount code is not valid.");
  }

  static notActive(): DiscountError {
    return new DiscountError("NOT_ACTIVE", "That discount code is not active yet.");
  }

  static expired(): DiscountError {
    return new DiscountError("EXPIRED", "That discount code has expired.");
  }

  static currencyMismatch(): DiscountError {
    return new DiscountError(
      "CURRENCY_MISMATCH",
      "That discount code cannot be applied in this currency.",
    );
  }

  static belowMinimum(): DiscountError {
    return new DiscountError(
      "BELOW_MINIMUM",
      "Your basket does not meet the minimum for that discount code.",
    );
  }

  static usageLimitReached(): DiscountError {
    return new DiscountError(
      "USAGE_LIMIT_REACHED",
      "That discount code has reached its usage limit.",
    );
  }
}
