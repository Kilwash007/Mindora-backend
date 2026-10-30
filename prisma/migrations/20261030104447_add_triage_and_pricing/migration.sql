/*
  Warnings:

  - A unique constraint covering the columns `[triageId]` on the table `payments` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('TRIAGE', 'COUNSELLING', 'PSYCHOLOGY', 'PSYCHIATRY_INITIAL', 'PSYCHIATRY_FOLLOWUP');

-- CreateEnum
CREATE TYPE "CareLevel" AS ENUM ('COUNSELLING', 'PSYCHOLOGY', 'PSYCHIATRY', 'EMERGENCY_REFERRAL');

-- CreateEnum
CREATE TYPE "TriageStatus" AS ENUM ('AWAITING_PAYMENT', 'QUEUED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TriageUrgency" AS ENUM ('ROUTINE', 'SOON', 'URGENT');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('FEMALE', 'MALE', 'INTERSEX', 'PREFER_NOT_TO_SAY');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "listPriceKes" INTEGER,
ADD COLUMN     "serviceType" "ServiceType",
ADD COLUMN     "triageCreditKes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "triageId" TEXT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "triageId" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "triageId" TEXT,
ALTER COLUMN "appointmentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "professionals" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "lastTriageAssignedAt" TIMESTAMP(3),
ADD COLUMN     "onCallForTriage" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "county" TEXT,
ADD COLUMN     "dateOfBirth" DATE,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "nationalIdNumber" TEXT,
ADD COLUMN     "nextOfKinName" TEXT,
ADD COLUMN     "nextOfKinPhone" TEXT,
ADD COLUMN     "nextOfKinRelationship" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "sex" "Sex";

-- CreateTable
CREATE TABLE "service_prices" (
    "service" "ServiceType" NOT NULL,
    "priceKes" INTEGER NOT NULL,
    "studentPriceKes" INTEGER,
    "payoutPercent" INTEGER NOT NULL DEFAULT 65,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_prices_pkey" PRIMARY KEY ("service")
);

-- CreateTable
CREATE TABLE "triages" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "checkInId" TEXT NOT NULL,
    "clinicianId" TEXT,
    "status" "TriageStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "isFree" BOOLEAN NOT NULL DEFAULT false,
    "urgency" "TriageUrgency",
    "careLevel" "CareLevel",
    "icd10Code" TEXT,
    "icd10Label" TEXT,
    "summary" TEXT,
    "creditKes" INTEGER NOT NULL DEFAULT 0,
    "creditAppointmentId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "triages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "triages_checkInId_key" ON "triages"("checkInId");

-- CreateIndex
CREATE UNIQUE INDEX "triages_creditAppointmentId_key" ON "triages"("creditAppointmentId");

-- CreateIndex
CREATE INDEX "triages_status_createdAt_idx" ON "triages"("status", "createdAt");

-- CreateIndex
CREATE INDEX "triages_clinicianId_status_idx" ON "triages"("clinicianId", "status");

-- CreateIndex
CREATE INDEX "triages_userId_idx" ON "triages"("userId");

-- CreateIndex
CREATE INDEX "appointments_triageId_idx" ON "appointments"("triageId");

-- CreateIndex
CREATE INDEX "messages_triageId_createdAt_idx" ON "messages"("triageId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_triageId_key" ON "payments"("triageId");

-- AddForeignKey
ALTER TABLE "triages" ADD CONSTRAINT "triages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triages" ADD CONSTRAINT "triages_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "check_ins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triages" ADD CONSTRAINT "triages_clinicianId_fkey" FOREIGN KEY ("clinicianId") REFERENCES "professionals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triages" ADD CONSTRAINT "triages_creditAppointmentId_fkey" FOREIGN KEY ("creditAppointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_triageId_fkey" FOREIGN KEY ("triageId") REFERENCES "triages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_triageId_fkey" FOREIGN KEY ("triageId") REFERENCES "triages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_triageId_fkey" FOREIGN KEY ("triageId") REFERENCES "triages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written additions (reviewed 30 Oct 2026)
-- ---------------------------------------------------------------------------

-- A payment belongs to exactly one appointment OR exactly one triage.
-- Existing rows all have an appointmentId and no triageId, so they pass.
ALTER TABLE "payments" ADD CONSTRAINT "payments_exactly_one_target_chk"
  CHECK (("appointmentId" IS NOT NULL) <> ("triageId" IS NOT NULL));

-- Sanity limits on prices and money columns.
ALTER TABLE "service_prices" ADD CONSTRAINT "service_prices_price_chk"
  CHECK ("priceKes" >= 0 AND ("studentPriceKes" IS NULL OR "studentPriceKes" >= 0));
ALTER TABLE "service_prices" ADD CONSTRAINT "service_prices_payout_chk"
  CHECK ("payoutPercent" BETWEEN 0 AND 100);
ALTER TABLE "triages" ADD CONSTRAINT "triages_credit_chk"
  CHECK ("creditKes" >= 0);
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_triage_credit_chk"
  CHECK ("triageCreditKes" >= 0);

-- Price list decided 30 Oct 2026. studentPriceKes left empty: students pay
-- the standard price until student prices are set in the admin price list.
INSERT INTO "service_prices" ("service", "priceKes", "payoutPercent", "active", "updatedAt") VALUES
  ('TRIAGE',              500,  65, true, CURRENT_TIMESTAMP),
  ('COUNSELLING',         2500, 65, true, CURRENT_TIMESTAMP),
  ('PSYCHOLOGY',          4000, 65, true, CURRENT_TIMESTAMP),
  ('PSYCHIATRY_INITIAL',  7500, 65, true, CURRENT_TIMESTAMP),
  ('PSYCHIATRY_FOLLOWUP', 5000, 65, true, CURRENT_TIMESTAMP);
