-- CreateTable
CREATE TABLE "kcb_ipn_notifications" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "messageId" TEXT,
    "businessKey" TEXT,
    "debitMsisdn" TEXT,
    "amountKes" INTEGER,
    "currency" TEXT,
    "transactionType" TEXT,
    "narration" TEXT,
    "transactionDate" TEXT,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "matchedPaymentId" TEXT,
    "amountMatches" BOOLEAN,
    "rawBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kcb_ipn_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kcb_ipn_notifications_transactionId_key" ON "kcb_ipn_notifications"("transactionId");

-- CreateIndex
CREATE INDEX "kcb_ipn_notifications_matchedPaymentId_idx" ON "kcb_ipn_notifications"("matchedPaymentId");

-- CreateIndex
CREATE INDEX "kcb_ipn_notifications_createdAt_idx" ON "kcb_ipn_notifications"("createdAt");
