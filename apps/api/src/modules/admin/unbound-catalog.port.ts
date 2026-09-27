import { Injectable, NotImplementedException } from "@nestjs/common";
import type {
  CatalogAdminPort,
  ExportedProductRow,
  UpsertProductResult,
} from "./admin.types";

/**
 * Placeholder binding for CATALOG_ADMIN_PORT.
 *
 * FAILS LOUDLY, and that is the entire point. CatalogModule is a placeholder at
 * the time this module was written, so something has to satisfy the injection
 * token. The tempting alternatives are both worse:
 *
 *  - returning an empty array from `exportProducts` would make a broken export
 *    look like an empty catalogue, and an admin would reasonably conclude their
 *    products had been deleted;
 *  - a no-op `upsertProduct` would make a bulk import report "created: 900"
 *    while writing nothing at all.
 *
 * Throwing 501 means an unwired deployment is obvious on the first request
 * instead of being discovered from wrong data later. Delete this class when
 * CatalogModule binds the token (see followUps).
 */
@Injectable()
export class UnboundCatalogAdminPort implements CatalogAdminPort {
  exportProducts(): Promise<readonly ExportedProductRow[]> {
    return Promise.reject(
      new NotImplementedException(
        "CATALOG_ADMIN_PORT is not bound — CatalogModule must provide it before product export is available",
      ),
    );
  }

  upsertProduct(): Promise<UpsertProductResult> {
    return Promise.reject(
      new NotImplementedException(
        "CATALOG_ADMIN_PORT is not bound — CatalogModule must provide it before bulk import is available",
      ),
    );
  }
}
