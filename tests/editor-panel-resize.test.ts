import { describe, expect, it } from "vitest";
import {
  EDITOR_PANEL_LIMITS,
  resizeEditorPanels,
} from "@/lib/editor/panel-resize";

const initial = { transcriptPx: 340, inspectorPx: 300 };

describe("resizeEditorPanels", () => {
  it("resizes the Transcript panel inside its own limits", () => {
    expect(
      resizeEditorPanels({
        widths: initial,
        target: "transcript",
        requestedPx: 420,
        containerPx: 1_200,
      }),
    ).toEqual({ transcriptPx: 420, inspectorPx: 300 });
  });

  it("resizes the Caption and Style panel inside its own limits", () => {
    expect(
      resizeEditorPanels({
        widths: initial,
        target: "inspector",
        requestedPx: 440,
        containerPx: 1_200,
      }),
    ).toEqual({ transcriptPx: 340, inspectorPx: 440 });
  });

  it("never makes the Video panel narrower than its minimum", () => {
    const widths = resizeEditorPanels({
      widths: initial,
      target: "transcript",
      requestedPx: 520,
      containerPx: 900,
    });

    expect(widths.transcriptPx).toBe(
      900 - initial.inspectorPx - EDITOR_PANEL_LIMITS.videoMinPx - EDITOR_PANEL_LIMITS.dividersPx,
    );
  });

  it("enforces each side panel minimum", () => {
    expect(
      resizeEditorPanels({
        widths: initial,
        target: "transcript",
        requestedPx: 10,
        containerPx: 1_200,
      }).transcriptPx,
    ).toBe(EDITOR_PANEL_LIMITS.transcript.minPx);
    expect(
      resizeEditorPanels({
        widths: initial,
        target: "inspector",
        requestedPx: 10,
        containerPx: 1_200,
      }).inspectorPx,
    ).toBe(EDITOR_PANEL_LIMITS.inspector.minPx);
  });
});
