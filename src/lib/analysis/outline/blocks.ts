import type { TranscriptSegmentInput } from "../chunking";
import type { AnalysisBlock } from "./types";

const DEFAULT_TARGET_BLOCK_MS = 4 * 60 * 1000;
// A pause this long between segments is a natural break worth closing a block at, even a bit
// short of the duration target — service transitions (song ends, preacher walks up) show up as
// exactly this kind of gap in whisper output.
const PAUSE_BREAK_MS = 2_500;
// Don't strand a tiny final block: below this fraction of the target it merges into the
// previous block rather than becoming an analysis unit too small to classify meaningfully.
const MIN_FINAL_BLOCK_FRACTION = 0.35;

/**
 * Divides the transcript into ~3–5 minute analysis blocks of consecutive segments. Blocks close
 * at the first segment boundary past the duration target, or early at a long pause once the
 * block is at least half the target. Every segment lands in exactly one block, in order.
 */
export function buildAnalysisBlocks(
  segments: TranscriptSegmentInput[],
  options: { targetBlockMs?: number } = {},
): AnalysisBlock[] {
  const targetMs = options.targetBlockMs ?? DEFAULT_TARGET_BLOCK_MS;
  if (segments.length === 0) return [];

  const blocks: AnalysisBlock[] = [];
  let blockStart = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const blockDuration = segments[i].endMs - segments[blockStart].startMs;
    const nextGap = i + 1 < segments.length ? segments[i + 1].startMs - segments[i].endMs : 0;
    const pastTarget = blockDuration >= targetMs;
    const pauseBreak = blockDuration >= targetMs / 2 && nextGap >= PAUSE_BREAK_MS;
    const isLast = i === segments.length - 1;

    if (pastTarget || pauseBreak || isLast) {
      blocks.push(toBlock(segments, blockStart, i, blocks.length));
      blockStart = i + 1;
    }
  }

  // Merge an undersized trailing block into its predecessor.
  if (blocks.length >= 2) {
    const last = blocks[blocks.length - 1];
    if (last.endMs - last.startMs < targetMs * MIN_FINAL_BLOCK_FRACTION) {
      const prev = blocks[blocks.length - 2];
      blocks.splice(
        blocks.length - 2,
        2,
        toBlock(
          [...prev.segments, ...last.segments],
          0,
          prev.segments.length + last.segments.length - 1,
          prev.blockIdx,
        ),
      );
    }
  }

  return blocks;
}

function toBlock(
  segments: TranscriptSegmentInput[],
  startIdx: number,
  endIdx: number,
  blockIdx: number,
): AnalysisBlock {
  const slice = segments.slice(startIdx, endIdx + 1);
  return {
    blockIdx,
    startSegmentIdx: slice[0].idx,
    endSegmentIdx: slice[slice.length - 1].idx,
    startMs: slice[0].startMs,
    endMs: slice[slice.length - 1].endMs,
    segments: slice,
  };
}
