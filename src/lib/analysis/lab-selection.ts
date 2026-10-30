import { dropoutInClip, type AudioDropout } from "./audio-dropout";
import type { CameraCheckResult } from "./camera-check";

/**
 * Phase 1 lab steps that run after scoring, before ANALYZE writes clips:
 * 0. Only the sermon (fix J): clips whose middle falls outside the sermon's span are dropped before
 *    the boundary step, and any clip still crossing its edge after it.
 * 1. The boundary step moves each top clip to whole sentences where its thought starts and lands.
 *    A clip it cannot fix keeps its raw window and goes behind every other clip (Jake, lab sermon
 *    3 clip 5: a raw window ran past the punch line).
 * 2. The audio dropout check (fix Q) rejects every clip whose sound the recording lost for a second
 *    or more. It is free, so it runs before the camera check and on the reserves too.
 * 3. The camera check walks the clips in rank order and rejects any that show a slide, until the
 *    target number of first picks has passed. Later clips stay as unchecked reserves.
 * All are dependencies, so this ordering is tested without a model, ffmpeg or a database.
 */

type LabClip = { startMs: number; endMs: number; text: string; total: number; title: string };
type Segment = { idx: number; startMs: number; endMs: number; text: string };

export type LabSelectionDependencies<T extends LabClip> = {
  segments: Segment[];
  /** How many clips must pass the camera check: the first picks. */
  targetCount: number;
  boundary: ((clip: T) => Promise<{ startMs: number; endMs: number } | null>) | null;
  cameraCheck: ((clip: T) => Promise<CameraCheckResult>) | null;
  /** Only the top clips get a boundary call; the rest are deep reserves. */
  boundaryTopN?: number;
  /** Where the sermon starts and ends on the source clock; null or absent keeps every clip. */
  sermonSpan?: { startMs: number; endMs: number } | null;
  /** Where the recording lost its sound, on the source clock; null or absent checks nothing. */
  audioDropouts?: AudioDropout[] | null;
  concurrency?: number;
};

export type LabSelectionResult<T> = {
  clips: T[];
  rejected: { title: string; reason: string; at: number }[];
  boundaryChanged: number;
  /** Clips dropped because they are not inside the sermon. */
  outsideSermon: number;
};

/**
 * The share of the shorter clip that the two clips have in common. Gate run, 2026-10-20: lab sermon
 * 4c clip 6 became 85 seconds and held all 29.6 seconds of clip 5, an intersection over union of only
 * 0.35; Jake failed both 4c clips that overlapped. Clips may now run to 90 seconds, so one can hold
 * another.
 */
function sharedShare(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): number {
  const shared = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return shorter > 0 ? shared / shorter : 0;
}

/**
 * Agreement ranking (2026-10-29). Lab rounds 5 and 7 ran the same code twice: all 35 sheet clips
 * whose moment both candidate runs found passed, and all 5 fails were moments only one run found.
 * So the candidate model runs a second time, and the moments it also found come first; each group
 * keeps its score order. Two clips are the same moment when they share more than half of the
 * longer one: a short window inside a long clip is not the same moment (lab 4l clip 3, a fail,
 * held a 20-second window the other run found).
 */
export function orderByAgreement<T extends LabClip>(
  ranked: T[],
  second: { startMs: number; endMs: number }[],
): { clips: T[]; agreed: T[] } {
  const sameMoment = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) => {
    const shared = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
    return shared / Math.max(a.endMs - a.startMs, b.endMs - b.startMs) > 0.5;
  };
  const agreed = ranked.filter((clip) => second.some((other) => sameMoment(clip, other)));
  return { clips: [...agreed, ...ranked.filter((clip) => !agreed.includes(clip))], agreed };
}

async function inBatches<A, B>(items: A[], size: number, run: (item: A) => Promise<B>): Promise<B[]> {
  const out: B[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return out;
}

export async function applyLabSelectionSteps<T extends LabClip>(
  kept: T[],
  deps: LabSelectionDependencies<T>,
): Promise<LabSelectionResult<T>> {
  const span = deps.sermonSpan ?? null;
  const dropouts = deps.audioDropouts ?? [];
  if (!deps.boundary && !deps.cameraCheck && !span && dropouts.length === 0) {
    return { clips: kept, rejected: [], boundaryChanged: 0, outsideSermon: 0 };
  }
  let clips = kept;
  let boundaryChanged = 0;
  let outsideSermon = 0;
  const keepWhere = (inside: (clip: T) => boolean) => {
    const before = clips.length;
    clips = clips.filter(inside);
    outsideSermon += before - clips.length;
  };

  if (span) keepWhere((clip) => (clip.startMs + clip.endMs) / 2 >= span.startMs && (clip.startMs + clip.endMs) / 2 <= span.endMs);

  if (deps.boundary) {
    const boundary = deps.boundary;
    const topN = deps.boundaryTopN ?? 12;
    const top = clips.slice(0, topN);
    const ranges = await inBatches(top, deps.concurrency ?? 4, (clip) => boundary(clip));
    const fixed: T[] = [];
    const unfixed: T[] = [];
    top.forEach((clip, i) => {
      const range = ranges[i];
      if (!range) return unfixed.push(clip);
      if (range.startMs === clip.startMs && range.endMs === clip.endMs) return fixed.push(clip);
      boundaryChanged += 1;
      const text = deps.segments
        .filter((s) => s.endMs > range.startMs && s.startMs < range.endMs)
        .map((s) => s.text)
        .join(" ");
      fixed.push({ ...clip, startMs: range.startMs, endMs: range.endMs, text });
    });
    // Fixed clips first, then the deep reserves, then the clips the step could not fix. Moved
    // clips can now cover the same words; the clip ahead in that order keeps them when the two share
    // more than half of the shorter one.
    const byScore = (list: T[]) => [...list].sort((a, b) => b.total - a.total);
    const ordered = [...byScore(fixed), ...byScore(clips.slice(topN)), ...byScore(unfixed)];
    clips = ordered.filter((clip, i) => !ordered.slice(0, i).some((other) => sharedShare(clip, other) > 0.5));
  }
  // A raw window the boundary step could not fix, or a deep reserve, may still cross the edge.
  if (span) keepWhere((clip) => clip.startMs >= span.startMs && clip.endMs <= span.endMs);

  const rejected: LabSelectionResult<T>["rejected"] = [];
  if (dropouts.length > 0) {
    clips = clips.filter((clip) => {
      const dropout = dropoutInClip(clip, dropouts);
      if (dropout) rejected.push({ title: clip.title, reason: "audio dropout", at: dropout.startMs / 1000 });
      return !dropout;
    });
  }
  if (deps.cameraCheck) {
    const passed: T[] = [];
    let next = 0;
    while (next < clips.length && passed.length < deps.targetCount) {
      const clip = clips[next];
      const result = await deps.cameraCheck(clip);
      if (result.pass) passed.push(clip);
      else rejected.push({ title: clip.title, reason: result.reason, at: result.at });
      next += 1;
    }
    clips = [...passed, ...clips.slice(next)];
  }

  return { clips, rejected, boundaryChanged, outsideSermon };
}
