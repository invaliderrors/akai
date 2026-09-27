-- Sendcloud shipping — the COMPLETE data model for every phase of
-- docs/superpowers/specs/2026-09-24-sendcloud-shipping.md §4 (pickup points at
-- checkout, labels, bulk print, tracking, zones/rates admin), in ONE migration
-- so no later phase has to touch the schema.
--
-- Generated with `prisma migrate diff` from the previous schema.
--
-- EVERYTHING IS ADDITIVE AND NULLABLE OR DEFAULTED. Existing shipping rates
-- become deliveryType HOME with no Sendcloud mapping (still sellable, labels by
-- hand); existing orders keep null snapshots and stay manually fulfillable;
-- existing shipments become provider MANUAL. No backfill.
--
-- `updatedAt` on shipping_zone / shipping_rate carries a DEFAULT so the column
-- can be added to populated tables; Prisma's `@updatedAt` maintains it from
-- then on.
--
-- ENUM VALUES: `ALTER TYPE … ADD VALUE` is fine inside Prisma's migration
-- transaction on PostgreSQL ≥ 12 as long as the new values are not USED in the
-- same transaction — nothing below uses them.

-- CreateEnum
CREATE TYPE "ShippingDeliveryType" AS ENUM ('HOME', 'SERVICE_POINT');

-- CreateEnum
CREATE TYPE "ShipmentProvider" AS ENUM ('MANUAL', 'SENDCLOUD');

-- AlterEnum


ALTER TYPE "ShipmentStatus" ADD VALUE 'LABEL_CREATED';
ALTER TYPE "ShipmentStatus" ADD VALUE 'AWAITING_PICKUP';
ALTER TYPE "ShipmentStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "ShipmentStatus" ADD VALUE 'FAILED';
ALTER TYPE "ShipmentStatus" ADD VALUE 'EXCEPTION';

-- AlterTable
ALTER TABLE "shipping_zone" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "shipping_rate" ADD COLUMN     "carrierCode" VARCHAR(64),
ADD COLUMN     "deliveryType" "ShippingDeliveryType" NOT NULL DEFAULT 'HOME',
ADD COLUMN     "sendcloudOptionCode" VARCHAR(128),
ADD COLUMN     "transitDaysMax" INTEGER,
ADD COLUMN     "transitDaysMin" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "parcelWeightGrams" INTEGER,
ADD COLUMN     "sendcloudOptionCode" VARCHAR(128),
ADD COLUMN     "servicePointAddress" VARCHAR(255),
ADD COLUMN     "servicePointCarrierId" VARCHAR(64),
ADD COLUMN     "servicePointId" VARCHAR(32),
ADD COLUMN     "servicePointName" VARCHAR(120),
ADD COLUMN     "servicePointPostNumber" VARCHAR(32),
ADD COLUMN     "shipHouseNumber" VARCHAR(16),
ADD COLUMN     "shippingRateId" UUID;

-- AlterTable
ALTER TABLE "shipment" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "labelObjectKey" VARCHAR(512),
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "provider" "ShipmentProvider" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sendcloudParcelId" BIGINT,
ADD COLUMN     "sendcloudShipmentId" VARCHAR(64),
ADD COLUMN     "sendcloudStatusCode" VARCHAR(64);

-- CreateIndex
CREATE INDEX "shipping_zone_countryCodes_idx" ON "shipping_zone" USING GIN ("countryCodes");

-- CreateIndex
CREATE INDEX "order_shippingRateId_idx" ON "order"("shippingRateId");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_sendcloudShipmentId_key" ON "shipment"("sendcloudShipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_sendcloudParcelId_key" ON "shipment"("sendcloudParcelId");

-- CreateIndex
CREATE INDEX "shipment_provider_status_lastSyncedAt_idx" ON "shipment"("provider", "status", "lastSyncedAt");

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_shippingRateId_fkey" FOREIGN KEY ("shippingRateId") REFERENCES "shipping_rate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

