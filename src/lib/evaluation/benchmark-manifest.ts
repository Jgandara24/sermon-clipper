import { z } from "zod";

/**
 * The labeled-benchmark contract (see `evaluation/editorial-standard-v1.md`).
 *
 * A manifest describes one human-labeled source service: where the sermon is, where forbidden
 * service content is, and how the operator judged each candidate clip. It is the offline evidence
 * every later phase is measured against.
 *
 * Two properties are structural rather than checked, on purpose:
 *
 * 1. A candidate carries ONE `range` object, not a list. The continuous-source rule
 *    (`docs/PULPIT_ENGINE_EDITORIAL_STANDARD.md` §2) is therefore unrepresentable to violate — a
 *    multi-range candidate fails at parse rather than at review.
 * 2. Media is referenced by opaque `artifactId` + `sha256`, never by path or URL, so a manifest
 *    can be committed to a public repository without carrying church video with it.
 */

export const MANIFEST_VERSION = "1.0";

/** Media-region vocabulary. Detector facts, not editorial policy. */
export const REGION_KINDS = [
  "SERMON",
  "WORSHIP",
  "ANNOUNCEMENT",
  "PRAYER",
  "BAPTISM",
  "OTHER_SERVICE_CONTENT",
  "PASTOR_VISIBLE",
  "FULLSCREEN_SLIDE",
  "AMBIGUOUS",
] as const;
export type RegionKind = (typeof REGION_KINDS)[number];

/** Regions that make an overlapping candidate undeliverable. */
export const FORBIDDEN_REGION_KINDS: readonly RegionKind[] = [
  "WORSHIP",
  "ANNOUNCEMENT",
  "PRAYER",
  "BAPTISM",
  "OTHER_SERVICE_CONTENT",
];

export const DECISIONS = ["ACCEPT", "REVISE", "REPLACE"] as const;
export type Decision = (typeof DECISIONS)[number];

export const FEEDBACK_CATEGORIES = [
  "CONTENT",
  "FORBIDDEN_CONTENT",
  "BOUNDARY",
  "VISUAL_CROP",
  "CAPTION",
  "AUDIO_LEVEL",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/**
 * Table-driven revisable-vs-replace-only policy. A boundary or presentation defect can be fixed by
 * re-editing the same clip; a content defect cannot, because fixing it would require changing what
 * the pastor said.
 */
export const REPLACE_ONLY_CATEGORIES: readonly FeedbackCategory[] = ["CONTENT", "FORBIDDEN_CONTENT"];

export const SEVERITIES = ["MINOR", "MAJOR", "CRITICAL"] as const;

const timestampMs = z.number().int().nonnegative();

/** Opaque handle. Rejects anything that looks like a path or URL so media can't ride along. */
const artifactId = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, "artifactId must be opaque: letters, digits, dot, underscore, hyphen only");

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex characters");

const RangeSchema = z
  .object({ startMs: timestampMs, endMs: timestampMs })
  .refine((r) => r.endMs > r.startMs, { message: "endMs must be greater than startMs" });

const RegionSchema = z
  .object({
    kind: z.enum(REGION_KINDS),
    startMs: timestampMs,
    endMs: timestampMs,
    note: z.string().max(500).optional(),
  })
  .refine((r) => r.endMs > r.startMs, { message: "endMs must be greater than startMs" });

const FeedbackSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  severity: z.enum(SEVERITIES),
  note: z.string().max(1000).optional(),
});

const CandidateSchema = z.object({
  id: z.string().min(1).max(128),
  /** Exactly one continuous range. See the class comment. */
  range: RangeSchema,
  decision: z.enum(DECISIONS),
  feedback: z.array(FeedbackSchema).default([]),
});

const SourceSchema = z.object({
  artifactId,
  sha256,
  durationMs: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  serviceOccurrence: z.enum(["PRIMARY", "SECONDARY", "SPECIAL"]),
});

export const BenchmarkManifestSchema = z.object({
  manifestVersion: z.literal(MANIFEST_VERSION),
  labeledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "labeledOn must be YYYY-MM-DD"),
  labeler: z.string().min(1).max(128),
  source: SourceSchema,
  regions: z.array(RegionSchema),
  candidates: z.array(CandidateSchema),
});

export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;

export type ManifestIssue = { path: string; message: string };
export type ValidationResult =
  | { ok: true; manifest: BenchmarkManifest; warnings: ManifestIssue[] }
  | { ok: false; issues: ManifestIssue[] };

const MEDIA_BEARING_PATTERN = /(https?:\/\/|\/{2,}|\.(mp4|mov|mkv|webm|wav|mp3|m4a)\b|^[A-Za-z]:\\|\/Users\/|\/home\/)/i;

/** Walks every string in the document looking for embedded media paths or URLs. */
function findMediaReferences(value: unknown, path: string, out: ManifestIssue[]): void {
  if (typeof value === "string") {
    if (MEDIA_BEARING_PATTERN.test(value)) {
      out.push({ path, message: "must not contain a file path or URL; reference media by artifactId and sha256" });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => findMediaReferences(item, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      findMediaReferences(child, path ? `${path}.${key}` : key, out);
    }
  }
}

function overlaps(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/** True when `region` intrudes on the interior of `range` rather than merely touching an edge. */
function intrudesInterior(range: { startMs: number; endMs: number }, region: { startMs: number; endMs: number }): boolean {
  return overlaps(range, region) && region.startMs > range.startMs && region.endMs < range.endMs;
}

/**
 * Validates shape, then the semantic rules the shape cannot express. Returns every issue rather
 * than throwing on the first, so a labeler can fix a whole manifest in one pass.
 */
export function validateBenchmarkManifest(input: unknown): ValidationResult {
  const parsed = BenchmarkManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    };
  }

  const manifest = parsed.data;
  const issues: ManifestIssue[] = [];
  const warnings: ManifestIssue[] = [];

  findMediaReferences(manifest, "", issues);

  const { durationMs } = manifest.source;

  manifest.regions.forEach((region, i) => {
    if (region.endMs > durationMs) {
      issues.push({ path: `regions[${i}]`, message: `endMs ${region.endMs} exceeds source durationMs ${durationMs}` });
    }
  });

  if (!manifest.regions.some((r) => r.kind === "SERMON")) {
    warnings.push({ path: "regions", message: "no SERMON region labeled; candidate eligibility cannot be checked against it" });
  }

  const seen = new Set<string>();
  manifest.candidates.forEach((candidate, i) => {
    const at = `candidates[${i}]`;

    if (seen.has(candidate.id)) {
      issues.push({ path: `${at}.id`, message: `duplicate candidate id "${candidate.id}"` });
    }
    seen.add(candidate.id);

    if (candidate.range.endMs > durationMs) {
      issues.push({ path: `${at}.range`, message: `endMs ${candidate.range.endMs} exceeds source durationMs ${durationMs}` });
    }

    const replaceOnly = candidate.feedback.filter((f) => REPLACE_ONLY_CATEGORIES.includes(f.category));
    if (candidate.decision === "REVISE" && replaceOnly.length > 0) {
      issues.push({
        path: `${at}.decision`,
        message: `REVISE cannot resolve ${replaceOnly.map((f) => f.category).join(", ")}; those categories are replace-only`,
      });
    }

    if (candidate.decision === "ACCEPT") {
      const critical = candidate.feedback.filter((f) => f.severity === "CRITICAL");
      if (critical.length > 0) {
        issues.push({ path: `${at}.decision`, message: "ACCEPT cannot carry CRITICAL feedback" });
      }

      const forbidden = manifest.regions.filter(
        (r) => FORBIDDEN_REGION_KINDS.includes(r.kind) && overlaps(candidate.range, r),
      );
      if (forbidden.length > 0) {
        issues.push({
          path: `${at}.range`,
          message: `ACCEPT overlaps forbidden region(s): ${[...new Set(forbidden.map((r) => r.kind))].join(", ")}`,
        });
      }

      const midSlide = manifest.regions.filter(
        (r) => r.kind === "FULLSCREEN_SLIDE" && intrudesInterior(candidate.range, r),
      );
      if (midSlide.length > 0) {
        issues.push({
          path: `${at}.range`,
          message: "ACCEPT contains a full-screen slide inside the range; an interior slide cannot be trimmed away without an internal cut",
        });
      }
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, manifest, warnings };
}

/** The published JSON Schema is generated from this module so the two cannot drift. */
export function buildJsonSchema(): unknown {
  return z.toJSONSchema(BenchmarkManifestSchema);
}
