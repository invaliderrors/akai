import { Module } from "@nestjs/common";

/**
 * AuditModule — PLACEHOLDER.
 *
 * OWNS: Append-only audit entries written in the same transaction as the change.
 *
 * Empty but importable, so AppModule's composition is complete and reviewable
 * from day one and later agents add controllers/providers here rather than
 * inventing a parallel structure. Filled in one module per commit (spec R6).
 */
@Module({})
export class AuditModule {}
