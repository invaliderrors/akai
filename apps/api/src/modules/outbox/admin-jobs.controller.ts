import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  idSchema,
  listJobsQuerySchema,
  type Job,
  type JobsSummary,
  type ListJobsQuery,
  type Paginated,
} from "@akai/contracts";

import { Roles } from "../auth/guards/roles.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AdminJobsService } from "./admin-jobs.service";

/**
 * Background-job observability.
 *
 * STAFF and ADMIN may READ; only ADMIN may retry, because a retry re-runs a
 * side effect — it re-sends mail and re-pushes catalogue changes to the payment
 * provider. Declared at class level so a handler added later inherits the read
 * restriction rather than shipping an open one.
 *
 * NO ENDPOINT HERE RETURNS A PAYLOAD. Outbox payloads carry live password-reset
 * tokens and raw customer addresses; see the note on the contract.
 */
@ApiTags("admin-jobs")
@Controller("admin/jobs")
@Roles("STAFF", "ADMIN")
export class AdminJobsController {
  constructor(private readonly jobs: AdminJobsService) {}

  @Get()
  @ApiOperation({ summary: "Background jobs, newest first" })
  async list(
    @Query(new ZodValidationPipe(listJobsQuerySchema)) query: ListJobsQuery,
  ): Promise<Paginated<Job>> {
    return this.jobs.list(query);
  }

  @Get("summary")
  @ApiOperation({
    summary: "Per-topic backlog, and which topics have no handler",
    description:
      "A topic with no registered handler dead-letters every message it receives while the producer looks healthy.",
  })
  async summary(): Promise<JobsSummary> {
    return this.jobs.summary();
  }

  @Post(":id/retry")
  @Roles("ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Make a failed or dead job due again" })
  async retry(@Param("id", new ZodValidationPipe(idSchema)) id: string): Promise<Job> {
    return this.jobs.retry(id);
  }
}
