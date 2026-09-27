import { Inject, Injectable } from "@nestjs/common";
import { AdminAuditService, type AuditSnapshot } from "./admin-audit.service";
import {
  CATALOG_ADMIN_PORT,
  type AdminActor,
  type CatalogAdminPort,
  type ExportedProductRow,
  type UpsertProductInput,
} from "./admin.types";
import type { BulkImportRequest, BulkImportRow } from "./admin.dto";

/**
 * Bulk product import / export.
 *
 * This service does NOT implement product CRUD. It orchestrates: validate the
 * file, delegate each row to CatalogAdminPort, audit the outcome, and report
 * per-row results. Reimplementing catalogue writes here would mean price
 * derivation, slug history and provider-sync outbox rows all have a second
 * implementation that drifts from the first — and the bulk path is precisely
 * where you least want a divergent one.
 */

export interface ImportRowOutcome {
  readonly slug: string;
  readonly outcome: "created" | "updated" | "failed" | "unchanged";
  /** Present only on `failed`. Safe to show an admin; never contains internals. */
  readonly error: string | null;
}

export interface BulkImportReport {
  readonly dryRun: boolean;
  readonly total: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly rows: readonly ImportRowOutcome[];
}

@Injectable()
export class AdminProductsService {
  constructor(
    @Inject(CATALOG_ADMIN_PORT)
    private readonly catalog: CatalogAdminPort,
    private readonly audit: AdminAuditService,
  ) {}

  async exportProducts(actor: AdminActor): Promise<readonly ExportedProductRow[]> {
    const products = await this.catalog.exportProducts();

    // A bulk export is an EXFILTRATION-shaped event — the entire catalogue,
    // including unreleased drafts and cost-revealing compare-at pricing, in one
    // file. Reads are not normally audited; this one is, because "who took a
    // full copy of the catalogue, and when" is a question worth being able to
    // answer after the fact.
    await this.audit.record({
      actor,
      action: "product.bulk_export",
      entityType: "product",
      entityId: "*",
      before: null,
      after: { exportedCount: products.length },
    });

    return products;
  }

  /**
   * Import products.
   *
   * ROW-INDEPENDENT by design: one bad row does not abort the other 899. An
   * all-or-nothing transaction sounds safer but in practice means a single
   * malformed SKU in a supplier spreadsheet blocks the entire catalogue update
   * with no partial progress and no indication of which row was at fault. Each
   * row is atomic on its own; the report says exactly what happened to each.
   *
   * `dryRun` validates and reports without writing — the only way to safely
   * preview a 900-row change against production data.
   */
  async importProducts(
    actor: AdminActor,
    request: BulkImportRequest,
  ): Promise<BulkImportReport> {
    const rows: ImportRowOutcome[] = [];

    for (const row of request.products) {
      rows.push(await this.importRow(actor, row, request.dryRun));
    }

    const count = (outcome: ImportRowOutcome["outcome"]): number =>
      rows.filter((row) => row.outcome === outcome).length;

    const report: BulkImportReport = {
      dryRun: request.dryRun,
      total: rows.length,
      created: count("created"),
      updated: count("updated"),
      unchanged: count("unchanged"),
      failed: count("failed"),
      rows,
    };

    await this.audit.record({
      actor,
      action: request.dryRun ? "product.bulk_import_dry_run" : "product.bulk_import",
      entityType: "product",
      entityId: "*",
      before: null,
      after: {
        total: report.total,
        created: report.created,
        updated: report.updated,
        unchanged: report.unchanged,
        failed: report.failed,
      },
    });

    return report;
  }

  private async importRow(
    actor: AdminActor,
    row: BulkImportRow,
    dryRun: boolean,
  ): Promise<ImportRowOutcome> {
    if (dryRun) {
      // The row already passed zod validation to reach this point, so a dry run
      // has nothing left to check without writing. Reporting it as `unchanged`
      // rather than a speculative "would create" avoids claiming an outcome we
      // did not actually determine.
      return { slug: row.slug, outcome: "unchanged", error: null };
    }

    try {
      const input: UpsertProductInput = {
        slug: row.slug,
        status: row.status,
        taxClass: row.taxClass,
        translations: row.translations,
        variants: row.variants.map((variant) => ({
          sku: variant.sku,
          priceGross: variant.priceGross,
          compareAtGross: variant.compareAtGross,
          currency: variant.currency,
          weightGrams: variant.weightGrams,
          initialStock: variant.initialStock,
          lowStockThreshold: variant.lowStockThreshold,
          allowBackorder: variant.allowBackorder,
        })),
        restrictedCountries: row.restrictedCountries,
      };

      const result = await this.catalog.upsertProduct(input);

      await this.audit.record({
        actor,
        action: result.created ? "product.create" : "product.update",
        entityType: "product",
        entityId: result.id,
        before: result.previous === null ? null : this.toSnapshot(result.previous),
        after: this.toSnapshot(input),
      });

      return {
        slug: row.slug,
        outcome: result.created ? "created" : "updated",
        error: null,
      };
    } catch (error) {
      return {
        slug: row.slug,
        outcome: "failed",
        // Only an Error's message is surfaced, and only because the caller is an
        // authenticated admin. Anything non-Error is reported generically rather
        // than stringified — that is how a database driver's internals end up in
        // an HTTP response.
        error: error instanceof Error ? error.message : "Import failed",
      };
    }
  }

  /**
   * Project a product into an audit snapshot.
   *
   * Prices and SKUs are the fields worth diffing — they are the ones that cost
   * money when wrong. Long-form descriptions are summarised by length rather
   * than stored verbatim so a 20,000-character body does not land in the audit
   * table on every edit.
   */
  private toSnapshot(product: ExportedProductRow | UpsertProductInput): AuditSnapshot {
    return {
      slug: product.slug,
      status: product.status,
      taxClass: product.taxClass,
      restrictedCountries: [...product.restrictedCountries],
      translations: product.translations.map((translation) => ({
        locale: translation.locale,
        name: translation.name,
        descriptionLength: translation.description.length,
      })),
      variants: product.variants.map((variant) => ({
        sku: variant.sku,
        priceGross: variant.priceGross,
        compareAtGross: variant.compareAtGross,
        currency: variant.currency,
        weightGrams: variant.weightGrams,
        lowStockThreshold: variant.lowStockThreshold,
        allowBackorder: variant.allowBackorder,
      })),
    };
  }
}
