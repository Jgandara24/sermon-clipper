"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Labelled range slider with an editable numeric field. Local state tracks the thumb every frame;
 * the commit is debounced (trailing, 120ms) so a drag reaches the editor state a handful of
 * times, and the editor's own 2s autosave then coalesces those into one save.
 */
export function StyleSlider({
  label,
  min,
  max,
  step,
  value,
  unit,
  toDisplayValue = (next) => next,
  fromDisplayValue = (next) => next,
  onCommit,
  onInteractionStart,
  onInteractionEnd,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  toDisplayValue?: (value: number) => number;
  fromDisplayValue?: (value: number) => number;
  onCommit: (value: number) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}) {
  const [local, setLocal] = useState(value);
  const [dragging, setDragging] = useState(false);
  const [editingNumber, setEditingNumber] = useState(false);
  const [draft, setDraft] = useState(String(toDisplayValue(value)));
  const [lastExternal, setLastExternal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<number | null>(null);

  // Follow a preset switch or reset unless the user is in the middle of an interaction.
  if (value !== lastExternal) {
    setLastExternal(value);
    if (!dragging && !editingNumber) {
      setLocal(value);
      setDraft(String(toDisplayValue(value)));
    }
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function queueCommit(next: number, syncDraft = true) {
    setLocal(next);
    if (syncDraft) setDraft(String(toDisplayValue(next)));
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = next;
    timerRef.current = setTimeout(() => {
      pendingRef.current = null;
      onCommit(next);
    }, 120);
  }

  function flushPendingCommit() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending !== null) onCommit(pending);
  }

  function clamp(valueToClamp: number) {
    return Math.min(max, Math.max(min, valueToClamp));
  }

  function commitDraft() {
    setEditingNumber(false);
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(toDisplayValue(local)));
      return;
    }
    const next = clamp(fromDisplayValue(parsed));
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = null;
    setLocal(next);
    setDraft(String(toDisplayValue(next)));
    onCommit(next);
  }

  const displayMin = toDisplayValue(min);
  const displayMax = toDisplayValue(max);
  const displayStep = Math.abs(toDisplayValue(min + step) - displayMin) || step;

  return (
    <label className="block text-xs text-stone-600">
      <span className="flex items-center justify-between">
        {label}
        <span className="flex items-center overflow-hidden rounded-md border border-stone-300 bg-white focus-within:border-red-500 focus-within:ring-1 focus-within:ring-red-500">
          <input
            type="number"
            min={displayMin}
            max={displayMax}
            step={displayStep}
            value={draft}
            onFocus={() => {
              setEditingNumber(true);
              onInteractionStart?.();
            }}
            onChange={(event) => {
              const nextDraft = event.target.value;
              setDraft(nextDraft);
              if (nextDraft.trim() === "") return;
              const parsed = Number(nextDraft);
              if (!Number.isFinite(parsed)) return;
              const next = fromDisplayValue(parsed);
              if (next < min || next > max) return;
              queueCommit(next, false);
            }}
            onBlur={() => {
              commitDraft();
              onInteractionEnd?.();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraft(String(toDisplayValue(value)));
                setLocal(value);
                event.currentTarget.blur();
              }
            }}
            className="w-14 bg-transparent px-2 py-1 text-right font-semibold tabular-nums text-stone-900 outline-none"
            aria-label={`${label} value`}
          />
          {unit ? (
            <span className="border-l border-stone-200 px-2 py-1 text-[10px] text-stone-400">
              {unit}
            </span>
          ) : null}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={(event) => queueCommit(Number(event.target.value))}
        onPointerDown={() => {
          setDragging(true);
          onInteractionStart?.();
        }}
        onPointerUp={() => {
          flushPendingCommit();
          setDragging(false);
          onInteractionEnd?.();
        }}
        onPointerCancel={() => {
          flushPendingCommit();
          setDragging(false);
          onInteractionEnd?.();
        }}
        className="mt-2 w-full accent-red-600"
      />
    </label>
  );
}
