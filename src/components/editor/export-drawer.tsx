"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { ExportPanel } from "@/components/editor/export-panel";

/**
 * Export, reached from the header and nowhere else.
 *
 * It used to sit at the foot of the Style column, where it was one panel among many and easy to
 * miss. The panel itself is unchanged — filename, the run, its status and the finished file — it
 * has only moved under the header, where the one button that opens it lives.
 *
 * Deliberately not a modal. An export can be refused for something the member must fix elsewhere
 * on the page — a clip carrying old word cuts is refused, and the refusal names the control in the
 * Script panel that puts them back — so a dialog that swallowed the page would name a way out it
 * had just taken away. Escape closes it, and the close button takes focus when it opens.
 */
export function ExportDrawer({
  clipId,
  publishBlockedReason,
  onClose,
}: {
  clipId: string;
  publishBlockedReason: string | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <section
      data-testid="export-dialog"
      aria-label="Export this clip"
      className="rounded-lg border border-stone-300 bg-white p-5 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Export</h2>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close export"
          title="Close this, and leave any export running"
          onClick={onClose}
          className="rounded-md p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3">
        <ExportPanel clipId={clipId} publishBlockedReason={publishBlockedReason} />
      </div>
    </section>
  );
}
