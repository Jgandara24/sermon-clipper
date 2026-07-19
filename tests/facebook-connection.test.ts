import { describe, expect, it } from "vitest";
import { isEligibleForAutoPost, parseFacebookConnection } from "@/lib/facebook-connection";

describe("parseFacebookConnection", () => {
  it("defaults to disconnected and disabled when settings is empty", () => {
    expect(parseFacebookConnection(null)).toEqual({ pageId: null, autoPostEnabled: false });
  });

  it("reads a configured connection", () => {
    const settings = { facebookConnection: { pageId: "1128280933691493", autoPostEnabled: true } };
    expect(parseFacebookConnection(settings)).toEqual({
      pageId: "1128280933691493",
      autoPostEnabled: true,
    });
  });

  it("treats a blank pageId as not connected", () => {
    const settings = { facebookConnection: { pageId: "   ", autoPostEnabled: true } };
    expect(parseFacebookConnection(settings).pageId).toBeNull();
  });
});

describe("isEligibleForAutoPost", () => {
  it("requires both a page id and the go-live flag", () => {
    expect(isEligibleForAutoPost({ pageId: null, autoPostEnabled: true })).toBe(false);
    expect(isEligibleForAutoPost({ pageId: "123", autoPostEnabled: false })).toBe(false);
    expect(isEligibleForAutoPost({ pageId: "123", autoPostEnabled: true })).toBe(true);
  });
});
