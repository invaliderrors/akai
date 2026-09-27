import { HttpException } from "@nestjs/common";
import { ERROR_STATUS, type ErrorCode } from "@akai/contracts";

/**
 * A blog failure that already knows its machine-readable `ErrorCode`.
 *
 * Same `{ code, message }` payload shape as `CatalogError`, which is what the
 * global `AllExceptionsFilter` reads — so a duplicate slug reaches the
 * dashboard as `CONFLICT`, a branchable code, rather than as a raw Prisma P2002
 * naming our table and column.
 */
export class BlogError extends HttpException {
  public readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super({ code, message }, ERROR_STATUS[code]);
    this.code = code;
    this.name = "BlogError";
  }

  static notFound(): BlogError {
    return new BlogError("NOT_FOUND", "Blog post not found");
  }

  static slugTaken(): BlogError {
    return new BlogError("CONFLICT", "A blog post with this slug already exists");
  }

  static validation(message: string): BlogError {
    return new BlogError("VALIDATION_FAILED", message);
  }
}
