import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import {
  REQUEST_ID_HEADER,
  normaliseRequestId,
  runWithRequestContext,
} from "@akai/observability";

/**
 * Establishes the request-scoped correlation context.
 *
 * Registered FIRST, before every other middleware, guard and interceptor, so
 * that everything downstream — including the exception filter building an error
 * envelope — can read a request id. If this ran later, the earliest failures
 * (the ones most worth tracing) would be the ones without an id.
 *
 * The id is also echoed as a response header so a customer reporting a problem
 * can quote it straight from their browser's network tab.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = normaliseRequestId(request.headers[REQUEST_ID_HEADER]);

    response.setHeader(REQUEST_ID_HEADER, requestId);

    // `next` must be invoked INSIDE run() — the whole point is that the rest of
    // the request's async subtree inherits this store.
    runWithRequestContext({ requestId }, () => {
      next();
    });
  }
}
