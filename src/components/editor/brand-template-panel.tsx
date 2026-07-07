"use client";

import { BadgeCheck } from "lucide-react";
import type { EditorState } from "@/lib/editor/types";

export type EditorBrandTemplate = {
  id: string;
  name: string;
  churchName: string;
  speakerName: string | null;
  primaryColor: string;
  accentColor: string;
  captionPresetId: string;
  lowerThird: {
    headline: string;
    subhead: string;
    showSpeaker: boolean;
  };
};

export function BrandTemplatePanel({
  templates,
  selectedId,
  onApply,
}: {
  templates: EditorBrandTemplate[];
  selectedId: string | null;
  onApply: (template: EditorBrandTemplate | null) => void;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <BadgeCheck size={18} className="text-teal-800" aria-hidden="true" />
        <h2 className="font-semibold">Brand</h2>
      </div>
      {templates.length === 0 ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          No brand template yet. Create one from Templates to enable lower-thirds.
        </p>
      ) : (
        <div className="mt-3 grid gap-2">
          <button
            type="button"
            onClick={() => onApply(null)}
            className={`rounded-md border px-3 py-2 text-left text-sm ${
              selectedId === null
                ? "border-stone-900 bg-stone-100"
                : "border-stone-300 text-stone-600 hover:bg-stone-50"
            }`}
          >
            No template
          </button>
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => onApply(template)}
              className={`rounded-md border px-3 py-2 text-left text-sm ${
                selectedId === template.id
                  ? "border-teal-700 bg-teal-50 text-teal-900"
                  : "border-stone-300 text-stone-600 hover:bg-stone-50"
              }`}
            >
              <span className="block font-medium">{template.name}</span>
              <span className="mt-1 block text-xs">{template.churchName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function applyBrandTemplateToState(
  state: EditorState,
  template: EditorBrandTemplate | null,
): EditorState {
  if (!template) {
    return { ...state, brandTemplateId: null };
  }

  return {
    ...state,
    brandTemplateId: template.id,
    captions: {
      ...state.captions,
      presetId: template.captionPresetId,
      overrides: {
        ...state.captions.overrides,
        highlightColor: template.accentColor,
      },
    },
    overlays: [
      ...state.overlays.filter(
        (overlay) =>
          !(
            overlay &&
            typeof overlay === "object" &&
            "type" in overlay &&
            overlay.type === "lowerThird"
          ),
      ),
      { type: "lowerThird", templateId: template.id, startMs: 0, endMs: 4000 },
    ],
  };
}
