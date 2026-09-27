import { Body, Controller, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { idSchema, type Batch } from "@akai/contracts";

import { Roles } from "../auth/guards/roles.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BatchesService } from "./batches.service";
import {
  attachCoaSchema,
  createBatchSchema,
  createCoaUploadUrlSchema,
  type AttachCoa,
  type CoaUploadUrlResponse,
  type CreateBatch,
  type CreateCoaUploadUrl,
} from "./batches.dto";

/**
 * Batch (lot) records and certificate-of-analysis uploads. ADMIN SURFACE ONLY
 * — same reasoning `AdminMediaController` records for its own upload route: a
 * public "give me a signed upload URL" endpoint is an open write capability
 * into object storage, and the guard is declared AT CLASS LEVEL so a method
 * added later inherits the restriction rather than needing to remember it.
 */
@ApiTags("admin")
@Controller("admin")
@Roles("STAFF", "ADMIN")
export class AdminBatchesController {
  constructor(private readonly batches: BatchesService) {}

  @Post("variants/:variantId/batches")
  @ApiOperation({ summary: "Record a new lot for a variant" })
  async createBatch(
    @Param("variantId", new ZodValidationPipe(idSchema)) variantId: string,
    @Body(new ZodValidationPipe(createBatchSchema)) body: CreateBatch,
  ): Promise<Batch> {
    return this.batches.createBatch(variantId, body);
  }

  /**
   * Mint a signed URL for one COA PDF.
   *
   * 200, not 201: nothing is created yet, a capability is issued — same
   * status choice `AdminMediaController.createUploadUrl` makes, for the same
   * reason.
   */
  @Post("batches/:batchId/coa/upload-url")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Issue a short-lived signed URL for a direct-to-storage COA upload",
  })
  async createCoaUploadUrl(
    @Param("batchId", new ZodValidationPipe(idSchema)) batchId: string,
    @Body(new ZodValidationPipe(createCoaUploadUrlSchema)) body: CreateCoaUploadUrl,
  ): Promise<CoaUploadUrlResponse> {
    return this.batches.createCoaUploadUrl(batchId, body);
  }

  @Post("batches/:batchId/coa")
  @ApiOperation({ summary: "Record that a COA upload succeeded" })
  async attachCoa(
    @Param("batchId", new ZodValidationPipe(idSchema)) batchId: string,
    @Body(new ZodValidationPipe(attachCoaSchema)) body: AttachCoa,
  ): Promise<Batch> {
    return this.batches.attachCoa(batchId, body);
  }
}
