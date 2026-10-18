import { buildDefaultEditorState } from "@/lib/editor/types";
import { defaultTitleBanner } from "@/lib/editor/title-banner";
import { POLICY } from "@/lib/analysis/complete-message/contract";
import type { ExportRenderPlanInput } from "@/lib/exports/render-plan";

let serial = 0;
export function fixture(durationMs = 152000): ExportRenderPlanInput {
  const id = `synthetic-${++serial}`;
  const startMs = 10000 + serial * 1000;
  const endMs = startMs + durationMs;
  const state = buildDefaultEditorState({ sourceVideoId: id, startMs, endMs });
  state.overlays = [{ ...defaultTitleBanner({ startMs, endMs }), text: "Invented title" }];
  return {
    state, source: { id, durationMs: endMs + 10000 },
    sourceWidth: 1920, sourceHeight: 1080, outputWidth: 1080, outputHeight: 1920, brandTemplate: null,
    processingConfig: { completeMessagePolicy: {
      enabled: true, version: POLICY.version, evidence: { revision: id, regions: [], gaps: [] },
    } },
    segments: [{ id: `${id}-segment`, startMs, endMs, words: [
      { word: "Consider", startMs, endMs: startMs + 500, confidence: 1, isFiller: false, deleted: false },
      { word: "answer.", startMs: endMs - 500, endMs, confidence: 1, isFiller: false, deleted: false },
    ] }],
  };
}
