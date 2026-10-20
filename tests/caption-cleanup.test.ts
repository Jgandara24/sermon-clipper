import { describe, expect, it } from "vitest";
import { collapseStutters, CONGREGATION_QUIET_DB, dropCongregationResponses, withoutPunctuation } from "@/lib/editor/caption-cleanup";
import type { CaptionWord } from "@/lib/editor/caption-lines";

/** Words 300 ms apart; `levels` gives each word's loudness in dB, by position. */
function words(text: string, levels: number[] = []) {
  const list: CaptionWord[] = text.split(" ").map((word, i) => ({ id: `w${i}`, word, startMs: i * 300, endMs: i * 300 + 250 }));
  const db = new Map(list.map((w, i) => [w.id, levels[i] ?? -28]));
  return { list, db };
}
const text = (list: CaptionWord[]) => list.map((w) => w.word).join(" ");

describe("dropCongregationResponses (fix G1)", () => {
  // Jake, 2026-10-18: "Sometimes a background audience or congregation words will get transcribed.
  // Ex: somone might shout, "Amen", and it get's transcribed. We don't want that." Measured on lab
  // sermons 1e, 2c and 3c: the congregation's "Amen." sits 15 to 55 dB below the preacher's usual
  // level, his own "Amen?" 0 to 7 dB below. Scribe labels both as the preacher.
  it("drops a short response the congregation says, far quieter than the preacher", () => {
    const { list, db } = words("God can change anybody. Amen. That's right. He changed this man.", [-28, -27, -29, -30, -55, -60, -62, -26, -28, -29, -30]);
    const { words: kept, dropped } = dropCongregationResponses(list, db);
    expect(text(kept)).toBe("God can change anybody. He changed this man.");
    expect(text(dropped)).toBe("Amen. That's right.");
  });

  it("keeps the preacher's own response words, said at his own level", () => {
    const { list, db } = words("Amen? Yeah. God can change anybody.", [-30, -33, -28, -27, -29, -30]);
    expect(text(dropResponses(list, db))).toBe("Amen? Yeah. God can change anybody.");
  });

  it("keeps a quiet sentence that is not a response", () => {
    // He drops his voice for effect.
    const { list, db } = words("Listen to me. He is able.", [-28, -28, -28, -50, -52, -51]);
    expect(text(dropResponses(list, db))).toBe("Listen to me. He is able.");
  });

  it("drops only below the threshold, measured from the clip's median word", () => {
    const quiet = -28 - CONGREGATION_QUIET_DB;
    expect(text(dropResponses(...args("He is able. Amen.", [-28, -28, -28, quiet - 1])))).toBe("He is able.");
    expect(text(dropResponses(...args("He is able. Amen.", [-28, -28, -28, quiet + 1])))).toBe("He is able. Amen.");
  });

  it("keeps every word when no levels were measured", () => {
    const { list } = words("He is able. Amen.");
    expect(text(dropResponses(list, new Map()))).toBe("He is able. Amen.");
  });

  function args(t: string, levels: number[]): [CaptionWord[], Map<string, number>] {
    const { list, db } = words(t, levels);
    return [list, db];
  }
  function dropResponses(list: CaptionWord[], db: Map<string, number>) {
    return dropCongregationResponses(list, db).words;
  }
});

describe("collapseStutters (fix G2)", () => {
  // Jake, 2026-10-18: "If the speaker stutters, like, ", I, I, I, I married my high school
  // sweetheart." please just transcribe "I" once."
  it("shows a stammered word once", () => {
    const { list } = words("I, I, I, I married my high school sweetheart.");
    const kept = collapseStutters(list);
    expect(text(kept)).toBe("I married my high school sweetheart.");
    // The word shows when he starts the stammer.
    expect(kept[0]).toMatchObject({ startMs: 0, id: "w3" });
  });

  it("keeps the capital letter of a sentence that starts with a stammer", () => {
    expect(text(collapseStutters(words("The, the very people that laughed at me.").list))).toBe("The very people that laughed at me.");
    expect(text(collapseStutters(words("Some of you today, you're, you're just trying.").list))).toBe("Some of you today, you're just trying.");
  });

  it("drops a word he cut off and started again, keeping a sentence's capital letter", () => {
    expect(text(collapseStutters(words("A- and you know what Jesus wants?").list))).toBe("And you know what Jesus wants?");
    expect(text(collapseStutters(words("May- maybe it's a wife.").list))).toBe("Maybe it's a wife.");
    expect(text(collapseStutters(words("I mean, i- listen, if you can trust Him.").list))).toBe("I mean, listen, if you can trust Him.");
    expect(text(collapseStutters(words("that- that- that touch of kindness.").list))).toBe("that touch of kindness.");
  });

  it("keeps a word he repeats for emphasis, and a repeat without a pause mark", () => {
    expect(text(collapseStutters(words("Holy, holy, holy is the Lord.").list))).toBe("Holy, holy, holy is the Lord.");
    expect(text(collapseStutters(words("No, no, no, sir.").list))).toBe("No, no, no, sir.");
    expect(text(collapseStutters(words("I know that that is true.").list))).toBe("I know that that is true.");
    expect(text(collapseStutters(words("Would you be willing to offer somebody some warmth- and help?").list))).toBe(
      "Would you be willing to offer somebody some warmth- and help?",
    );
  });

  it("does not change the input", () => {
    const { list } = words("I, I married her.");
    const before = JSON.stringify(list);
    collapseStutters(list);
    expect(JSON.stringify(list)).toBe(before);
  });
});

// Jake, 2026-10-19: "make subtitles full caps right now, no punctuation, and slighly larger font."
describe("withoutPunctuation", () => {
  it.each([
    ["Therefore, draw near to God.", "Therefore draw near to God"],
    ["Did you get it?", "Did you get it"],
    ['"Man, how in the world am I gonna do this?', "Man how in the world am I gonna do this"],
    ["Amen!", "Amen"],
    ["God— he is faithful…", "God he is faithful"],
    ["(Laughter) That's right; amen:", "Laughter That's right amen"],
    ["Na- Nate turned from his sin.", "Na Nate turned from his sin"],
  ])("drops the punctuation from %j", (text, expected) => {
    expect(withoutPunctuation(text)).toBe(expected);
  });

  it.each([
    ["They're the one that determines", "They're the one that determines"],
    ["He’ll draw near to you, God's way.", "He’ll draw near to you God's way"],
    ["Ephesians 2:8-9, by grace.", "Ephesians 2:8-9 by grace"],
    ["2,000 years later.", "2,000 years later"],
    ["so-and-so passed away.", "so-and-so passed away"],
  ])("keeps the marks inside a word or a number in %j", (text, expected) => {
    expect(withoutPunctuation(text)).toBe(expected);
  });

  it("leaves nothing of a word that was only punctuation", () => {
    expect(withoutPunctuation("—")).toBe("");
  });
});
