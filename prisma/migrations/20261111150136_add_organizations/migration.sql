-- CreateEnum
CREATE TYPE "OrgType" AS ENUM ('PROVIDER', 'NGO', 'UNIVERSITY', 'EMPLOYER', 'INSURER');

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('ORG_OWNER', 'ORG_ADMIN', 'ORG_CLINICIAN', 'ORG_PATIENT');

-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('SESSION_COMPLETED', 'ESCALATION', 'SEAT_ACTIVE');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "orgAdminId" TEXT;

-- AlterTable
ALTER TABLE "check_ins" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "clinical_notes" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "referrals" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "safety_alerts" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "triages" ADD COLUMN     "organizationId" TEXT;

-- CreateTable
CREATE TABLE "org_admins" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "OrgType" NOT NULL,
    "status" "OrgStatus" NOT NULL DEFAULT 'TRIAL',
    "plan" TEXT NOT NULL DEFAULT 'pilot',
    "logoUrl" TEXT,
    "escalationEmails" TEXT[],
    "escalationPhone" TEXT,
    "billingEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "userId" TEXT,
    "professionalId" TEXT,
    "orgAdminId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "licenceNumber" TEXT,
    "licenceExpiry" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invites" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "licenceNumber" TEXT,
    "licenceExpiry" DATE,
    "invitedByType" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "UsageKind" NOT NULL,
    "refId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_admins_email_key" ON "org_admins"("email");

-- CreateIndex
CREATE INDEX "organizations_status_idx" ON "organizations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_userId_key" ON "organization_memberships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_professionalId_key" ON "organization_memberships"("professionalId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_orgAdminId_key" ON "organization_memberships"("orgAdminId");

-- CreateIndex
CREATE INDEX "organization_memberships_organizationId_role_idx" ON "organization_memberships"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invites_tokenHash_key" ON "organization_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "organization_invites_organizationId_idx" ON "organization_invites"("organizationId");

-- CreateIndex
CREATE INDEX "organization_invites_email_idx" ON "organization_invites"("email");

-- CreateIndex
CREATE INDEX "usage_events_organizationId_occurredAt_idx" ON "usage_events"("organizationId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_organizationId_kind_refId_key" ON "usage_events"("organizationId", "kind", "refId");

-- CreateIndex
CREATE INDEX "appointments_organizationId_idx" ON "appointments"("organizationId");

-- CreateIndex
CREATE INDEX "check_ins_organizationId_idx" ON "check_ins"("organizationId");

-- CreateIndex
CREATE INDEX "clinical_notes_organizationId_idx" ON "clinical_notes"("organizationId");

-- CreateIndex
CREATE INDEX "messages_organizationId_idx" ON "messages"("organizationId");

-- CreateIndex
CREATE INDEX "payments_organizationId_idx" ON "payments"("organizationId");

-- CreateIndex
CREATE INDEX "referrals_organizationId_idx" ON "referrals"("organizationId");

-- CreateIndex
CREATE INDEX "safety_alerts_organizationId_idx" ON "safety_alerts"("organizationId");

-- CreateIndex
CREATE INDEX "triages_organizationId_idx" ON "triages"("organizationId");

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triages" ADD CONSTRAINT "triages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_alerts" ADD CONSTRAINT "safety_alerts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_orgAdminId_fkey" FOREIGN KEY ("orgAdminId") REFERENCES "org_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_orgAdminId_fkey" FOREIGN KEY ("orgAdminId") REFERENCES "org_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Added by hand after prisma migrate dev --create-only (Prisma has no CHECK constraints).
-- A membership links exactly one account, and it must match the role.
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_one_account_for_role" CHECK (
  ("role" = 'ORG_PATIENT' AND "userId" IS NOT NULL AND "professionalId" IS NULL AND "orgAdminId" IS NULL)
  OR ("role" = 'ORG_CLINICIAN' AND "professionalId" IS NOT NULL AND "userId" IS NULL AND "orgAdminId" IS NULL)
  OR ("role" IN ('ORG_OWNER', 'ORG_ADMIN') AND "orgAdminId" IS NOT NULL AND "userId" IS NULL AND "professionalId" IS NULL)
);

-- Licence details belong to clinicians only.
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_licence_clinician_only" CHECK (
  "role" = 'ORG_CLINICIAN' OR ("licenceNumber" IS NULL AND "licenceExpiry" IS NULL)
);
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_licence_clinician_only" CHECK (
  "role" = 'ORG_CLINICIAN' OR ("licenceNumber" IS NULL AND "licenceExpiry" IS NULL)
);
