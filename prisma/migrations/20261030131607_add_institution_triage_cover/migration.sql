-- AlterTable
ALTER TABLE "institutions" ADD COLUMN     "coversTriage" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "triages" ADD COLUMN     "sponsoringInstitutionId" TEXT;

-- CreateIndex
CREATE INDEX "triages_sponsoringInstitutionId_idx" ON "triages"("sponsoringInstitutionId");

-- AddForeignKey
ALTER TABLE "triages" ADD CONSTRAINT "triages_sponsoringInstitutionId_fkey" FOREIGN KEY ("sponsoringInstitutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
