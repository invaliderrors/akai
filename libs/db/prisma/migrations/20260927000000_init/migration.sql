-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CUSTOMER', 'STAFF', 'ADMIN', 'PARTNER');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('SHIPPING', 'BILLING');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('SIMPLE', 'PACK');

-- CreateEnum
CREATE TYPE "TaxClass" AS ENUM ('STANDARD', 'REDUCED', 'ZERO_RATED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'AWAITING_PAYMENT', 'PAID', 'PAYMENT_MISMATCH', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('WOMPI');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('REQUESTED_BY_CUSTOMER', 'DUPLICATE', 'FRAUDULENT', 'WITHDRAWAL_RIGHT', 'DAMAGED', 'OTHER');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'IN_TRANSIT', 'DELIVERED', 'RETURNED', 'LOST');

-- CreateEnum
CREATE TYPE "IdentityDocumentType" AS ENUM ('CC', 'CE', 'NIT', 'PP', 'TI', 'PPT');

-- CreateEnum
CREATE TYPE "InventoryMovement" AS ENUM ('SALE', 'RESTOCK', 'RETURN', 'ADJUSTMENT', 'RESERVATION', 'RESERVATION_RELEASE');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'FREE_SHIPPING');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'IN_TRANSIT', 'RECEIVED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "BlogPostStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "BlogCategory" AS ENUM ('DROPS', 'LOOKBOOK', 'STYLE_GUIDES', 'NEWS');

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "passwordHash" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "firstName" VARCHAR(80),
    "lastName" VARCHAR(80),
    "phone" VARCHAR(32),
    "role" "Role" NOT NULL DEFAULT 'CUSTOMER',
    "totpSecret" TEXT,
    "totpEnabledAt" TIMESTAMP(3),
    "lastTotpCounter" BIGINT,
    "marketingConsentAt" TIMESTAMP(3),
    "marketingConsentVersion" VARCHAR(32),
    "anonymisedAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_code" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(512),
    "twoFactorAssertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_token" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "purpose" VARCHAR(32) NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_otp" (
    "customerId" UUID NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_otp_pkey" PRIMARY KEY ("customerId")
);

-- CreateTable
CREATE TABLE "address" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "type" "AddressType" NOT NULL,
    "firstName" VARCHAR(80) NOT NULL,
    "lastName" VARCHAR(80) NOT NULL,
    "company" VARCHAR(120),
    "line1" VARCHAR(200) NOT NULL,
    "line2" VARCHAR(200),
    "city" VARCHAR(120) NOT NULL,
    "region" VARCHAR(120) NOT NULL,
    "postalCode" VARCHAR(20),
    "countryCode" CHAR(2) NOT NULL,
    "phone" VARCHAR(32),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "taxClass" "TaxClass" NOT NULL DEFAULT 'STANDARD',
    "name" VARCHAR(200) NOT NULL,
    "shortDescription" VARCHAR(500) NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "restrictedCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hygieneExempt" BOOLEAN NOT NULL DEFAULT false,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "offerOnNewProducts" BOOLEAN NOT NULL DEFAULT false,
    "newProductDefaultVariantId" UUID,
    "stackDiscountEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "kind" "ProductKind" NOT NULL DEFAULT 'SIMPLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_slug_history" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variant" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120),
    "options" JSONB NOT NULL DEFAULT '{}',
    "currency" CHAR(3) NOT NULL,
    "priceNet" INTEGER NOT NULL,
    "priceTax" INTEGER NOT NULL,
    "priceGross" INTEGER NOT NULL,
    "compareAtGross" INTEGER,
    "taxRateBps" INTEGER NOT NULL,
    "saleStartsAt" TIMESTAMP(3),
    "saleEndsAt" TIMESTAMP(3),
    "weightGrams" INTEGER,
    "lengthMm" INTEGER,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "priceNet" INTEGER NOT NULL,
    "priceTax" INTEGER NOT NULL,
    "priceGross" INTEGER NOT NULL,
    "taxRateBps" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "changedBy" UUID,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_item" (
    "variantId" UUID NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 5,
    "allowBackorder" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "inventory_ledger" (
    "id" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "movement" "InventoryMovement" NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "resultingOnHand" INTEGER NOT NULL,
    "orderId" UUID,
    "actorId" UUID,
    "reason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservation" (
    "id" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "cartId" UUID,
    "orderId" UUID,
    "quantity" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_asset" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "objectKey" VARCHAR(512) NOT NULL,
    "url" VARCHAR(1024) NOT NULL,
    "alt" VARCHAR(300) NOT NULL DEFAULT '',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variant_price_tier" (
    "id" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "unitPriceGross" INTEGER NOT NULL,

    CONSTRAINT "product_variant_price_tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_add_on" (
    "productId" UUID NOT NULL,
    "addOnId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "defaultVariantId" UUID,

    CONSTRAINT "product_add_on_pkey" PRIMARY KEY ("productId","addOnId")
);

-- CreateTable
CREATE TABLE "product_pack_component" (
    "packProductId" UUID NOT NULL,
    "componentProductId" UUID NOT NULL,
    "componentVariantId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "product_pack_component_pkey" PRIMARY KEY ("packProductId","componentProductId")
);

-- CreateTable
CREATE TABLE "product_category" (
    "productId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_category_pkey" PRIMARY KEY ("productId","categoryId")
);

-- CreateTable
CREATE TABLE "cart" (
    "id" UUID NOT NULL,
    "customerId" UUID,
    "tokenHash" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "discountCode" VARCHAR(64),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_item" (
    "id" UUID NOT NULL,
    "cartId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceGross" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "packProductId" UUID,
    "packInstanceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "type" "DiscountType" NOT NULL,
    "value" INTEGER NOT NULL,
    "minimumSubtotal" INTEGER,
    "currency" CHAR(3),
    "maxRedemptions" INTEGER,
    "maxRedemptionsPerCustomer" INTEGER,
    "timesRedeemed" INTEGER NOT NULL DEFAULT 0,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "affiliateId" UUID,

    CONSTRAINT "discount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "country" CHAR(2) NOT NULL,
    "socialHandle" VARCHAR(200) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "customerId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "affiliate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_link" (
    "id" UUID NOT NULL,
    "affiliateId" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "affiliate_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_link_click" (
    "id" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_link_click_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_redemption" (
    "id" UUID NOT NULL,
    "discountId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "customerId" UUID,
    "amountApplied" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" UUID NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "taxClass" "TaxClass" NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_zone" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "countryCodes" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "shipping_zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_rate" (
    "id" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "strategy" VARCHAR(16) NOT NULL,
    "priceGross" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "minValue" INTEGER,
    "maxValue" INTEGER,
    "freeOverSubtotal" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "transitDaysMin" INTEGER,
    "transitDaysMax" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "shipping_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" UUID NOT NULL,
    "orderNumber" VARCHAR(20) NOT NULL,
    "customerId" UUID,
    "email" CITEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "currency" CHAR(3) NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "discountTotal" INTEGER NOT NULL DEFAULT 0,
    "shippingTotal" INTEGER NOT NULL DEFAULT 0,
    "taxTotal" INTEGER NOT NULL DEFAULT 0,
    "grandTotal" INTEGER NOT NULL,
    "refundedTotal" INTEGER NOT NULL DEFAULT 0,
    "shipFirstName" VARCHAR(80) NOT NULL,
    "shipLastName" VARCHAR(80) NOT NULL,
    "shipCompany" VARCHAR(120),
    "shipLine1" VARCHAR(200) NOT NULL,
    "shipLine2" VARCHAR(200),
    "shipCity" VARCHAR(120) NOT NULL,
    "shipRegion" VARCHAR(120) NOT NULL,
    "shipPostalCode" VARCHAR(20),
    "shipCountryCode" CHAR(2) NOT NULL,
    "shipPhone" VARCHAR(32),
    "billFirstName" VARCHAR(80) NOT NULL,
    "billLastName" VARCHAR(80) NOT NULL,
    "billCompany" VARCHAR(120),
    "billLine1" VARCHAR(200) NOT NULL,
    "billLine2" VARCHAR(200),
    "billCity" VARCHAR(120) NOT NULL,
    "billRegion" VARCHAR(120) NOT NULL,
    "billPostalCode" VARCHAR(20),
    "billCountryCode" CHAR(2) NOT NULL,
    "billPhone" VARCHAR(32),
    "invoiceNumber" VARCHAR(32),
    "documentType" "IdentityDocumentType" NOT NULL,
    "documentNumber" VARCHAR(20) NOT NULL,
    "shippingMethodName" VARCHAR(120),
    "acceptedTermsVersion" VARCHAR(32),
    "shippingRateId" UUID,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "variantId" UUID,
    "productName" VARCHAR(200) NOT NULL,
    "variantName" VARCHAR(120),
    "sku" VARCHAR(64) NOT NULL,
    "imageUrl" VARCHAR(1024),
    "quantity" INTEGER NOT NULL,
    "unitPriceNet" INTEGER NOT NULL,
    "unitPriceGross" INTEGER NOT NULL,
    "lineDiscount" INTEGER NOT NULL DEFAULT 0,
    "taxRateBps" INTEGER NOT NULL,
    "taxAmount" INTEGER NOT NULL,
    "lineTotalNet" INTEGER NOT NULL,
    "lineTotalGross" INTEGER NOT NULL,
    "packProductId" UUID,
    "packInstanceId" UUID,

    CONSTRAINT "order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_event" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "message" VARCHAR(1000) NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'WOMPI',
    "status" "PaymentStatus" NOT NULL DEFAULT 'REQUIRES_PAYMENT_METHOD',
    "amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "providerReference" VARCHAR(64),
    "providerPaymentId" TEXT,
    "providerTransactionId" TEXT,
    "cardBrand" VARCHAR(32),
    "cardLast4" CHAR(4),
    "failureCode" VARCHAR(64),
    "failureMessage" VARCHAR(500),
    "capturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" "RefundReason" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "providerRefundId" TEXT,
    "note" VARCHAR(1000),
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "providerDisputeId" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "evidenceDueBy" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "carrier" VARCHAR(64) NOT NULL,
    "trackingNumber" VARCHAR(128),
    "trackingUrl" VARCHAR(1024),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_item" (
    "id" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "shipment_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_request" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "customerId" UUID,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" VARCHAR(500) NOT NULL,
    "adminNote" VARCHAR(1000),
    "returnLabelUrl" VARCHAR(1024),
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "return_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_event" (
    "id" UUID NOT NULL,
    "recipient" CITEXT NOT NULL,
    "templateKey" VARCHAR(64) NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" VARCHAR(200),
    "orderId" UUID,
    "error" VARCHAR(1000),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dedupeScope" VARCHAR(64) NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppression" (
    "email" CITEXT NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppression_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "outbox_message" (
    "id" UUID NOT NULL,
    "topic" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(1000),
    "processedAt" TIMESTAMP(3),
    "deadAt" TIMESTAMP(3),
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "key" VARCHAR(128) NOT NULL,
    "userId" VARCHAR(64) NOT NULL,
    "route" VARCHAR(128) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "responseSnapshot" JSONB,
    "statusCode" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("key","userId","route")
);

-- CreateTable
CREATE TABLE "provider_event" (
    "id" VARCHAR(128) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "actorRole" "Role",
    "action" VARCHAR(80) NOT NULL,
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" VARCHAR(64) NOT NULL,
    "diff" JSONB NOT NULL,
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(512),
    "requestId" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_record" (
    "id" UUID NOT NULL,
    "customerId" UUID,
    "email" CITEXT,
    "kind" VARCHAR(32) NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "ipAddress" VARCHAR(45),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_counter" (
    "key" VARCHAR(200) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_counter_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "invoice_counter" (
    "id" BOOLEAN NOT NULL DEFAULT true,
    "lastNumber" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_counter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_settings" (
    "id" BOOLEAN NOT NULL DEFAULT true,
    "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_post" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "status" "BlogPostStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "coverObjectKey" VARCHAR(512),
    "category" "BlogCategory" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "excerpt" VARCHAR(500) NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "metaTitle" VARCHAR(200),
    "metaDescription" VARCHAR(320),
    "coverAlt" VARCHAR(300) NOT NULL DEFAULT '',
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blog_post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_email_key" ON "customer"("email");

-- CreateIndex
CREATE INDEX "customer_createdAt_idx" ON "customer"("createdAt");

-- CreateIndex
CREATE INDEX "customer_anonymisedAt_idx" ON "customer"("anonymisedAt");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_code_codeHash_key" ON "recovery_code"("codeHash");

-- CreateIndex
CREATE INDEX "recovery_code_customerId_idx" ON "recovery_code"("customerId");

-- CreateIndex
CREATE INDEX "session_customerId_idx" ON "session"("customerId");

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_tokenHash_key" ON "refresh_token"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_token_familyId_idx" ON "refresh_token"("familyId");

-- CreateIndex
CREATE INDEX "refresh_token_customerId_idx" ON "refresh_token"("customerId");

-- CreateIndex
CREATE INDEX "refresh_token_expiresAt_idx" ON "refresh_token"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "auth_token_tokenHash_key" ON "auth_token"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_token_customerId_purpose_idx" ON "auth_token"("customerId", "purpose");

-- CreateIndex
CREATE INDEX "auth_token_expiresAt_idx" ON "auth_token"("expiresAt");

-- CreateIndex
CREATE INDEX "email_otp_expiresAt_idx" ON "email_otp"("expiresAt");

-- CreateIndex
CREATE INDEX "address_customerId_type_idx" ON "address"("customerId", "type");

-- CreateIndex
CREATE INDEX "product_status_deletedAt_idx" ON "product"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "product_createdAt_idx" ON "product"("createdAt");

-- CreateIndex
CREATE INDEX "product_sortOrder_idx" ON "product"("sortOrder");

-- CreateIndex
CREATE INDEX "product_kind_idx" ON "product"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "product_slug_history_slug_key" ON "product_slug_history"("slug");

-- CreateIndex
CREATE INDEX "product_variant_productId_idx" ON "product_variant"("productId");

-- CreateIndex
CREATE INDEX "product_variant_isActive_deletedAt_idx" ON "product_variant"("isActive", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_productId_id_key" ON "product_variant"("productId", "id");

-- CreateIndex
CREATE INDEX "price_history_variantId_validFrom_idx" ON "price_history"("variantId", "validFrom");

-- CreateIndex
CREATE INDEX "inventory_ledger_variantId_createdAt_idx" ON "inventory_ledger"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_ledger_orderId_idx" ON "inventory_ledger"("orderId");

-- CreateIndex
CREATE INDEX "stock_reservation_expiresAt_releasedAt_idx" ON "stock_reservation"("expiresAt", "releasedAt");

-- CreateIndex
CREATE INDEX "stock_reservation_variantId_idx" ON "stock_reservation"("variantId");

-- CreateIndex
CREATE INDEX "media_asset_productId_sortOrder_idx" ON "media_asset"("productId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "media_asset_variantId_key" ON "media_asset"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_price_tier_variantId_minQuantity_key" ON "product_variant_price_tier"("variantId", "minQuantity");

-- CreateIndex
CREATE INDEX "product_add_on_addOnId_idx" ON "product_add_on"("addOnId");

-- CreateIndex
CREATE INDEX "product_pack_component_componentProductId_idx" ON "product_pack_component"("componentProductId");

-- CreateIndex
CREATE INDEX "product_category_categoryId_sortOrder_idx" ON "product_category"("categoryId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "cart_tokenHash_key" ON "cart"("tokenHash");

-- CreateIndex
CREATE INDEX "cart_customerId_idx" ON "cart"("customerId");

-- CreateIndex
CREATE INDEX "cart_expiresAt_idx" ON "cart"("expiresAt");

-- CreateIndex
CREATE INDEX "cart_item_cartId_variantId_idx" ON "cart_item"("cartId", "variantId");

-- CreateIndex
CREATE INDEX "cart_item_cartId_idx" ON "cart_item"("cartId");

-- CreateIndex
CREATE UNIQUE INDEX "discount_code_key" ON "discount"("code");

-- CreateIndex
CREATE INDEX "discount_code_deletedAt_idx" ON "discount"("code", "deletedAt");

-- CreateIndex
CREATE INDEX "discount_affiliateId_idx" ON "discount"("affiliateId");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_customerId_key" ON "affiliate"("customerId");

-- CreateIndex
CREATE INDEX "affiliate_deletedAt_idx" ON "affiliate"("deletedAt");

-- CreateIndex
CREATE INDEX "affiliate_link_affiliateId_idx" ON "affiliate_link"("affiliateId");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_link_slug_key" ON "affiliate_link"("slug");

-- CreateIndex
CREATE INDEX "affiliate_link_click_linkId_idx" ON "affiliate_link_click"("linkId");

-- CreateIndex
CREATE INDEX "discount_redemption_customerId_idx" ON "discount_redemption"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "discount_redemption_discountId_orderId_key" ON "discount_redemption"("discountId", "orderId");

-- CreateIndex
CREATE INDEX "tax_rate_countryCode_taxClass_idx" ON "tax_rate"("countryCode", "taxClass");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rate_countryCode_taxClass_validFrom_key" ON "tax_rate"("countryCode", "taxClass", "validFrom");

-- CreateIndex
CREATE INDEX "shipping_zone_countryCodes_idx" ON "shipping_zone" USING GIN ("countryCodes");

-- CreateIndex
CREATE INDEX "shipping_rate_zoneId_isActive_idx" ON "shipping_rate"("zoneId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "order_orderNumber_key" ON "order"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "order_invoiceNumber_key" ON "order"("invoiceNumber");

-- CreateIndex
CREATE INDEX "order_customerId_placedAt_idx" ON "order"("customerId", "placedAt");

-- CreateIndex
CREATE INDEX "order_status_placedAt_idx" ON "order"("status", "placedAt");

-- CreateIndex
CREATE INDEX "order_email_idx" ON "order"("email");

-- CreateIndex
CREATE INDEX "order_placedAt_idx" ON "order"("placedAt");

-- CreateIndex
CREATE INDEX "order_shippingRateId_idx" ON "order"("shippingRateId");

-- CreateIndex
CREATE INDEX "order_item_orderId_idx" ON "order_item"("orderId");

-- CreateIndex
CREATE INDEX "order_item_sku_idx" ON "order_item"("sku");

-- CreateIndex
CREATE INDEX "order_event_orderId_createdAt_idx" ON "order_event"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_providerPaymentId_key" ON "payment"("providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_providerTransactionId_key" ON "payment"("providerTransactionId");

-- CreateIndex
CREATE INDEX "payment_orderId_idx" ON "payment"("orderId");

-- CreateIndex
CREATE INDEX "payment_status_idx" ON "payment"("status");

-- CreateIndex
CREATE INDEX "payment_providerReference_idx" ON "payment"("providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "refund_providerRefundId_key" ON "refund"("providerRefundId");

-- CreateIndex
CREATE INDEX "refund_orderId_idx" ON "refund"("orderId");

-- CreateIndex
CREATE INDEX "refund_paymentId_idx" ON "refund"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_providerDisputeId_key" ON "dispute"("providerDisputeId");

-- CreateIndex
CREATE INDEX "dispute_orderId_idx" ON "dispute"("orderId");

-- CreateIndex
CREATE INDEX "shipment_orderId_idx" ON "shipment"("orderId");

-- CreateIndex
CREATE INDEX "shipment_trackingNumber_idx" ON "shipment"("trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_item_shipmentId_orderItemId_key" ON "shipment_item"("shipmentId", "orderItemId");

-- CreateIndex
CREATE INDEX "return_request_orderId_idx" ON "return_request"("orderId");

-- CreateIndex
CREATE INDEX "return_request_status_idx" ON "return_request"("status");

-- CreateIndex
CREATE INDEX "email_event_recipient_idx" ON "email_event"("recipient");

-- CreateIndex
CREATE INDEX "email_event_status_createdAt_idx" ON "email_event"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_event_orderId_templateKey_dedupeScope_key" ON "email_event"("orderId", "templateKey", "dedupeScope");

-- CreateIndex
CREATE INDEX "outbox_message_processedAt_availableAt_idx" ON "outbox_message"("processedAt", "availableAt");

-- CreateIndex
CREATE INDEX "outbox_message_topic_idx" ON "outbox_message"("topic");

-- CreateIndex
CREATE INDEX "idempotency_record_expiresAt_idx" ON "idempotency_record"("expiresAt");

-- CreateIndex
CREATE INDEX "provider_event_type_idx" ON "provider_event"("type");

-- CreateIndex
CREATE INDEX "audit_log_entityType_entityId_idx" ON "audit_log"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_actorId_idx" ON "audit_log"("actorId");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "consent_record_customerId_idx" ON "consent_record"("customerId");

-- CreateIndex
CREATE INDEX "consent_record_email_idx" ON "consent_record"("email");

-- CreateIndex
CREATE INDEX "rate_limit_counter_resetAt_idx" ON "rate_limit_counter"("resetAt");

-- CreateIndex
CREATE UNIQUE INDEX "blog_post_slug_key" ON "blog_post"("slug");

-- CreateIndex
CREATE INDEX "blog_post_status_publishedAt_idx" ON "blog_post"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "blog_post_authorId_idx" ON "blog_post"("authorId");

-- AddForeignKey
ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_otp" ADD CONSTRAINT "email_otp_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "address" ADD CONSTRAINT "address_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_slug_history" ADD CONSTRAINT "product_slug_history_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant_price_tier" ADD CONSTRAINT "product_variant_price_tier_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_add_on" ADD CONSTRAINT "product_add_on_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_add_on" ADD CONSTRAINT "product_add_on_addOnId_fkey" FOREIGN KEY ("addOnId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_add_on" ADD CONSTRAINT "product_add_on_addOnId_defaultVariantId_fkey" FOREIGN KEY ("addOnId", "defaultVariantId") REFERENCES "product_variant"("productId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_pack_component" ADD CONSTRAINT "product_pack_component_packProductId_fkey" FOREIGN KEY ("packProductId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_pack_component" ADD CONSTRAINT "product_pack_component_componentProductId_fkey" FOREIGN KEY ("componentProductId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_pack_component" ADD CONSTRAINT "product_pack_component_componentProductId_componentVariant_fkey" FOREIGN KEY ("componentProductId", "componentVariantId") REFERENCES "product_variant"("productId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart" ADD CONSTRAINT "cart_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount" ADD CONSTRAINT "discount_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate" ADD CONSTRAINT "affiliate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_link" ADD CONSTRAINT "affiliate_link_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_link_click" ADD CONSTRAINT "affiliate_link_click_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "affiliate_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_redemption" ADD CONSTRAINT "discount_redemption_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "discount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_rate" ADD CONSTRAINT "shipping_rate_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "shipping_zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_shippingRateId_fkey" FOREIGN KEY ("shippingRateId") REFERENCES "shipping_rate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_item" ADD CONSTRAINT "shipment_item_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_post" ADD CONSTRAINT "blog_post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

