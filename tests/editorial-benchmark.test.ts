import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BenchmarkManifestSchema,
  buildJsonSchema,
  validateBenchmarkManifest,
} from "@/lib/evaluation/benchmark-manifest";

const EVALUATION_DIR = join(process.cwd(), "evaluation");

function loadExample(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(EVALUATION_DIR, "benchmark-manifest.example.json"), "utf8"));
}

/**
 * These tests deliberately construct manifests that violate the contract, so the working copy is
 * intentionally untyped — typing it would make the invalid cases unwritable, which is the thing
 * being tested.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MutableManifest = any;

/** Deep clone so each case mutates in isolation. */
function example(): MutableManifest {
  return structuredClone(loadExample());
}

function messages(result: ReturnType<typeof validateBenchmarkManifest>): string[] {
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

describe("benchmark manifest", () => {
  it("accepts the committed example manifest", () => {
    const result = validateBenchmarkManifest(loadExample());
    expect(result.ok).toBe(true);
  });

  it("rejects a missing source checksum", () => {
    const m = example();
    delete m.source.sha256;
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/source\.sha256/);
  });

  it("rejects a malformed checksum", () => {
    const m = example();
    m.source.sha256 = "not-a-real-hash";
    expect(validateBenchmarkManifest(m).ok).toBe(false);
  });

  it("rejects an invalid region kind", () => {
    const m = example();
    m.regions[0].kind = "SOUNDCHECK";
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/regions\.0\.kind/);
  });

  it("rejects a region that ends before it starts", () => {
    const m = example();
    m.regions[0] = { kind: "SERMON", startMs: 500, endMs: 100 };
    expect(validateBenchmarkManifest(m).ok).toBe(false);
  });

  it("rejects a region running past the source duration", () => {
    const m = example();
    m.regions[0].endMs = m.source.durationMs + 1000;
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/exceeds source durationMs/);
  });

  it("rejects an invalid decision", () => {
    const m = example();
    m.candidates[0].decision = "MAYBE";
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/candidates\.0\.decision/);
  });

  // The continuous-source rule is structural: a candidate has one `range` object, so a
  // multi-range candidate cannot be expressed at all.
  it("rejects a candidate expressed as multiple ranges", () => {
    const m = example();
    m.candidates[0].range = [
      { startMs: 175000, endMs: 200000 },
      { startMs: 210000, endMs: 232000 },
    ];
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/candidates\.0\.range/);
  });

  it("rejects a candidate range that ends before it starts", () => {
    const m = example();
    m.candidates[0].range = { startMs: 300000, endMs: 299000 };
    expect(validateBenchmarkManifest(m).ok).toBe(false);
  });

  it("rejects duplicate candidate ids", () => {
    const m = example();
    m.candidates[1].id = m.candidates[0].id;
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/duplicate candidate id/);
  });
});

describe("benchmark manifest — editorial policy", () => {
  it("rejects REVISE citing a replace-only category", () => {
    const m = example();
    m.candidates[3].decision = "REVISE"; // cand-004 carries CONTENT feedback
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/replace-only/);
  });

  it("allows REVISE citing boundary and caption defects", () => {
    const result = validateBenchmarkManifest(loadExample());
    expect(result.ok).toBe(true); // cand-003 is exactly this case
  });

  it("rejects ACCEPT carrying critical feedback", () => {
    const m = example();
    m.candidates[0].feedback = [{ category: "BOUNDARY", severity: "CRITICAL", note: "cuts the verb" }];
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/CRITICAL/);
  });

  it("rejects ACCEPT overlapping a forbidden region", () => {
    const m = example();
    // cand-004 sits inside the ANNOUNCEMENT block.
    m.candidates[3].decision = "ACCEPT";
    m.candidates[3].feedback = [];
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/forbidden region\(s\): ANNOUNCEMENT/);
  });

  it("rejects ACCEPT with a full-screen slide inside the range", () => {
    const m = example();
    // cand-002 straddles the 300000-312000 slide.
    m.candidates[1].decision = "ACCEPT";
    m.candidates[1].feedback = [];
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/full-screen slide inside the range/);
  });

  it("allows a slide touching only the edge of an accepted range", () => {
    const m = example();
    m.regions = m.regions.filter((r: MutableManifest) => r.kind !== "FULLSCREEN_SLIDE");
    m.regions.push({ kind: "FULLSCREEN_SLIDE", startMs: 232000, endMs: 240000 });
    // cand-001 ends exactly at 232000, so the slide abuts but does not intrude.
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(true);
  });

  it("warns when no sermon region is labeled", () => {
    const m = example();
    m.regions = m.regions.filter((r: MutableManifest) => r.kind !== "SERMON");
    m.candidates = [];
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((w) => w.message).join("\n")).toMatch(/no SERMON region/);
    }
  });
});

describe("benchmark manifest — media must never ride along", () => {
  it("rejects an artifactId that is a file path", () => {
    const m = example();
    m.source.artifactId = "/Users/someone/sermons/service.mp4";
    expect(validateBenchmarkManifest(m).ok).toBe(false);
  });

  it("rejects a URL hidden in a note", () => {
    const m = example();
    m.regions[0].note = "see https://example.com/private/service.mp4";
    const result = validateBenchmarkManifest(m);
    expect(result.ok).toBe(false);
    expect(messages(result).join("\n")).toMatch(/must not contain a file path or URL/);
  });

  it("rejects a media filename hidden in feedback", () => {
    const m = example();
    m.candidates[0].feedback = [{ category: "AUDIO_LEVEL", severity: "MINOR", note: "compare against master.wav" }];
    expect(validateBenchmarkManifest(m).ok).toBe(false);
  });
});

describe("benchmark manifest — published schema", () => {
  it("keeps the committed JSON Schema in sync with the module", () => {
    const committed = readFileSync(join(EVALUATION_DIR, "benchmark-manifest.schema.json"), "utf8");
    expect(committed).toBe(`${JSON.stringify(buildJsonSchema(), null, 2)}\n`);
  });

  it("exposes the manifest type through the zod schema", () => {
    expect(BenchmarkManifestSchema.safeParse(loadExample()).success).toBe(true);
  });
});
