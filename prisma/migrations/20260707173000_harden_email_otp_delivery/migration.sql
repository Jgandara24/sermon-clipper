-- AlterTable
ALTER TABLE "email_otp_challenges" ADD COLUMN "delivery_status" "notification_status" NOT NULL DEFAULT 'pending';
ALTER TABLE "email_otp_challenges" ADD COLUMN "delivery_provider" TEXT;
ALTER TABLE "email_otp_challenges" ADD COLUMN "delivery_error_message" TEXT;
ALTER TABLE "email_otp_challenges" ADD COLUMN "sent_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "email_otp_challenges_delivery_status_idx" ON "email_otp_challenges"("delivery_status");
