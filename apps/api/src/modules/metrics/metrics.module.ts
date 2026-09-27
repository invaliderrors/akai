import { Module } from "@nestjs/common";

/**
 * MetricsModule — PLACEHOLDER.
 *
 * OWNS: Revenue, AOV and conversion from a scheduled read model, never live aggregates.
 *
 * Empty but importable, so AppModule's composition is complete and reviewable
 * from day one and later agents add controllers/providers here rather than
 * inventing a parallel structure. Filled in one module per commit (spec R6).
 */
@Module({})
export class MetricsModule {}
