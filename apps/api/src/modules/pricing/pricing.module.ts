import { Module } from "@nestjs/common";

/**
 * PricingModule — PLACEHOLDER.
 *
 * OWNS: Net/tax/gross derivation and price history. Delegates all arithmetic to @akai/money.
 *
 * Empty but importable, so AppModule's composition is complete and reviewable
 * from day one and later agents add controllers/providers here rather than
 * inventing a parallel structure. Filled in one module per commit (spec R6).
 */
@Module({})
export class PricingModule {}
