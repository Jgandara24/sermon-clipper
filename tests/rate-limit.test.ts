import { afterEach, describe, expect, it } from "vitest";
import {
  exportConcurrentJobLimit,
  exportDailyJobLimit,
  uploadPresignHourlyLimit,
} from "@/lib/rate-limit";

afterEach(() => {
  delete process.env.EXPORT_MAX_CONCURRENT_JOBS;
  delete process.env.EXPORT_DAILY_JOB_LIMIT;
  delete process.env.UPLOAD_PRESIGN_HOURLY_LIMIT;
});

describe("rate limit configuration", () => {
  it("has sane defaults", () => {
    expect(exportConcurrentJobLimit()).toBe(4);
    expect(exportDailyJobLimit()).toBe(50);
    expect(uploadPresignHourlyLimit()).toBe(30);
  });

  it("honors env overrides", () => {
    process.env.EXPORT_MAX_CONCURRENT_JOBS = "2";
    process.env.EXPORT_DAILY_JOB_LIMIT = "10";
    process.env.UPLOAD_PRESIGN_HOURLY_LIMIT = "5";
    expect(exportConcurrentJobLimit()).toBe(2);
    expect(exportDailyJobLimit()).toBe(10);
    expect(uploadPresignHourlyLimit()).toBe(5);
  });

  it("falls back to defaults on invalid, zero, or negative values", () => {
    process.env.EXPORT_MAX_CONCURRENT_JOBS = "not-a-number";
    process.env.EXPORT_DAILY_JOB_LIMIT = "0";
    process.env.UPLOAD_PRESIGN_HOURLY_LIMIT = "-3";
    expect(exportConcurrentJobLimit()).toBe(4);
    expect(exportDailyJobLimit()).toBe(50);
    expect(uploadPresignHourlyLimit()).toBe(30);
  });

  it("floors fractional overrides", () => {
    process.env.EXPORT_MAX_CONCURRENT_JOBS = "2.9";
    expect(exportConcurrentJobLimit()).toBe(2);
  });
});
