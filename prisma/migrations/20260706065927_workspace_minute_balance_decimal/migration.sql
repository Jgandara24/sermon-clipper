/*
  Warnings:

  - You are about to alter the column `minute_balance` on the `workspaces` table. The data in that column could be lost. The data in that column will be cast from `Integer` to `Decimal(10,2)`.

*/
-- AlterTable
ALTER TABLE "workspaces" ALTER COLUMN "minute_balance" SET DEFAULT 60,
ALTER COLUMN "minute_balance" SET DATA TYPE DECIMAL(10,2);
