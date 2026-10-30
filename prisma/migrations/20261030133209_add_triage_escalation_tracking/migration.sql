-- AlterTable
ALTER TABLE "triages" ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);
