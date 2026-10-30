-- AlterTable
ALTER TABLE "triages" ADD COLUMN     "clinicianPayoutKes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payoutId" TEXT;

-- CreateIndex
CREATE INDEX "triages_payoutId_idx" ON "triages"("payoutId");

-- AddForeignKey
ALTER TABLE "triages" ADD CONSTRAINT "triages_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
