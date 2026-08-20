import { describe, expect, it } from "vitest";
import {
  applyTextCase,
  DEFAULT_TEXT_CASE,
  isTextCase,
  resolveTextCase,
  TEXT_CASE_OPTIONS,
  TEXT_CASES,
  type TextCase,
} from "@/lib/editor/text-case";

describe("the five options", () => {
  it("offers exactly the five the product defines", () => {
    expect(TEXT_CASES).toEqual(["uppercase", "sentence", "title", "lowercase", "original"]);
  });

  it("labels every option for the controls that will present them", () => {
    expect(TEXT_CASE_OPTIONS.map((option) => option.value)).toEqual([...TEXT_CASES]);
    for (const option of TEXT_CASE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it("defaults to Uppercase", () => {
    expect(DEFAULT_TEXT_CASE).toBe("uppercase");
  });

  it("recognises its own values and rejects anything else", () => {
    for (const value of TEXT_CASES) expect(isTextCase(value)).toBe(true);
    expect(isTextCase("shouty")).toBe(false);
    expect(isTextCase(undefined)).toBe(false);
  });
});

describe("applyTextCase", () => {
  const sentence = "peace is not the absence of trouble. it is the presence of rest.";

  it("uppercases", () => {
    expect(applyTextCase(sentence, "uppercase")).toBe(
      "PEACE IS NOT THE ABSENCE OF TROUBLE. IT IS THE PRESENCE OF REST.",
    );
  });

  it("lowercases", () => {
    expect(applyTextCase("PEACE Is Not THE Absence", "lowercase")).toBe("peace is not the absence");
  });

  it("leaves the original alone", () => {
    expect(applyTextCase("PeAcE is NOT", "original")).toBe("PeAcE is NOT");
  });

  it("capitalises each sentence for Sentence case", () => {
    expect(applyTextCase(sentence, "sentence")).toBe(
      "Peace is not the absence of trouble. It is the presence of rest.",
    );
  });

  /**
   * Documented, not hidden: Sentence case flattens proper nouns, because nothing here can tell a
   * name from any other word. Churches who care keep Uppercase, which is the default, or Original.
   */
  it("lowercases proper nouns, which is inherent to the option", () => {
    expect(applyTextCase("the peace of God is with John.", "sentence")).toBe(
      "The peace of god is with john.",
    );
  });

  it("capitalises after every sentence terminator", () => {
    expect(applyTextCase("who is this? he is risen! truly.", "sentence")).toBe(
      "Who is this? He is risen! Truly.",
    );
  });

  it("normalises a shouted line back to Sentence case", () => {
    expect(applyTextCase("PEACE IS HERE. STAY.", "sentence")).toBe("Peace is here. Stay.");
  });

  it("capitalises each word for Title Case", () => {
    expect(applyTextCase("the weight of grace", "title")).toBe("The Weight Of Grace");
  });

  it("does not capitalise the letter after an apostrophe", () => {
    expect(applyTextCase("don't stop believing", "title")).toBe("Don't Stop Believing");
    expect(applyTextCase("god's peace", "title")).toBe("God's Peace");
  });

  it("capitalises after a hyphen, as a title would", () => {
    expect(applyTextCase("well-known truth", "title")).toBe("Well-Known Truth");
  });

  it("preserves the spacing it was given", () => {
    expect(applyTextCase("two  spaces", "title")).toBe("Two  Spaces");
    expect(applyTextCase(" leading and trailing ", "sentence")).toBe(" Leading and trailing ");
  });

  it("handles an empty string and whitespace", () => {
    for (const textCase of TEXT_CASES) {
      expect(applyTextCase("", textCase)).toBe("");
      expect(applyTextCase("   ", textCase)).toBe("   ");
    }
  });

  it("handles accented characters", () => {
    expect(applyTextCase("l'église est ouverte", "uppercase")).toBe("L'ÉGLISE EST OUVERTE");
    expect(applyTextCase("ÉGLISE", "sentence")).toBe("Église");
  });

  it("leaves digits and punctuation-only text unchanged in shape", () => {
    expect(applyTextCase("john 14:27 — peace", "title")).toBe("John 14:27 — Peace");
  });

  it("is idempotent for every option", () => {
    for (const textCase of TEXT_CASES) {
      const once = applyTextCase(sentence, textCase);
      expect(applyTextCase(once, textCase)).toBe(once);
    }
  });
});

describe("resolveTextCase — legacy documents keep rendering", () => {
  it("prefers an explicit case", () => {
    expect(resolveTextCase({ textCase: "title", legacyUppercase: false, fallback: "uppercase" })).toBe(
      "title",
    );
  });

  it("maps the old boolean true to Uppercase", () => {
    expect(resolveTextCase({ legacyUppercase: true, fallback: "original" })).toBe("uppercase");
  });

  it("maps the old boolean false to Original", () => {
    // The clip rendered untransformed text before; it must keep rendering untransformed text,
    // even though Uppercase is the default for anything new.
    expect(resolveTextCase({ legacyUppercase: false, fallback: "uppercase" })).toBe("original");
  });

  it("falls back when neither is set", () => {
    expect(resolveTextCase({ fallback: "uppercase" })).toBe("uppercase");
    expect(resolveTextCase({ fallback: "original" })).toBe("original");
  });

  it("lets an explicit case win over the old boolean, so a re-saved clip moves forward", () => {
    expect(resolveTextCase({ textCase: "lowercase", legacyUppercase: true, fallback: "uppercase" })).toBe(
      "lowercase",
    );
  });

  it("ignores an unrecognised stored value rather than rendering something arbitrary", () => {
    expect(
      resolveTextCase({ textCase: "shouty" as TextCase, legacyUppercase: true, fallback: "original" }),
    ).toBe("uppercase");
  });
});
