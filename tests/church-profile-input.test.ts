import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMING_LATER_SERMONS_PER_WEEK,
  sermonsPerWeekSchema,
  SUPPORTED_SERMONS_PER_WEEK,
} from "@/lib/church-profile-input";

/**
 * What a church may say about its own week.
 *
 * A disabled `<option>` is courtesy, not a control — the value travels in a form body and can be
 * forged. So the rule that holds is this schema, and these cases are about the server rather than
 * the markup.
 */

describe("sermons per week", () => {
  it.each(SUPPORTED_SERMONS_PER_WEEK)("accepts %i, which is supported", (value) => {
    expect(sermonsPerWeekSchema.parse(String(value))).toBe(value);
  });

  it("refuses a forged three, whatever the select said", () => {
    const result = sermonsPerWeekSchema.safeParse(String(COMING_LATER_SERMONS_PER_WEEK));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("not supported yet");
    }
  });

  it.each(["0", "-1", "4", "99", "1.5", "two", ""])("refuses %o", (value) => {
    expect(sermonsPerWeekSchema.safeParse(value).success).toBe(false);
  });

  /**
   * Both actions parse a form body, where every value is a string. Coercion is what makes `"2"`
   * the number 2, and a schema that only accepted numbers would reject every real submission.
   */
  it("coerces the string a form actually sends", () => {
    expect(sermonsPerWeekSchema.parse("2")).toBe(2);
    expect(sermonsPerWeekSchema.parse(2)).toBe(2);
  });
});

/**
 * The markup and the rule have to agree, and they are in different files. These read the pages
 * rather than render them: the claim is about what the source says, and there is no component
 * test environment in this repo to render it in.
 */
describe("the pages that offer the choice", () => {
  const pages = [
    "src/app/onboarding/page.tsx",
    "src/app/app/settings/page.tsx",
  ] as const;

  it.each(pages)("%s offers three services as disabled, not selectable", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain('<option value="3" disabled>');
    expect(source).toContain("Coming later");
    // And still offers the two that are real.
    for (const supported of SUPPORTED_SERMONS_PER_WEEK) {
      expect(source).toContain(`<option value="${supported}">`);
    }
  });

  /**
   * The settings page used to claim the church profile "controls how many clips we generate per
   * sermon". It never did: the retained candidate count is a staff control a church cannot see or
   * change (plan §2.2, product-owner Decision 1), and telling a church otherwise invites a
   * conversation about a number they have no lever for.
   */
  it("claims nothing about how many candidates are generated", () => {
    const source = readFileSync("src/app/app/settings/page.tsx", "utf8");
    // Split so this test does not itself contain the phrase it forbids.
    expect(source).not.toContain(["how many clips we", "generate per sermon"].join(" "));
    for (const forbidden of [
      "candidateLimit",
      "candidate limit",
      "masterDefault",
      "hardMaximum",
      "up to 18",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("tells a church that a change affects only sermons uploaded afterwards", () => {
    const source = readFileSync("src/app/app/settings/page.tsx", "utf8");
    expect(source).toContain("apply to sermons you upload from now on");
  });
});
