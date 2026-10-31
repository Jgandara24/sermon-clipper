import { TrackingError, type TrackingRecord } from './types';

/** Linear interpolation inside each shot. A cut selects the next shot immediately.
 * Coordinates are displayed source pixels. Round positions once, identically in both consumers. */
export function trackingCropAt(record: TrackingRecord, t: number) {
  if (!Number.isFinite(t) || t < record.start || t > record.end) throw new TrackingError('Time is outside tracking coverage.');
  const shot = record.shots.find(s => t >= s.start && t < s.end) ?? (t === record.end ? record.shots.at(-1) : undefined);
  if (!shot) throw new TrackingError('Tracking shot is unavailable.');
  let lo = 0, hi = shot.keys.length - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (shot.keys[mid].t <= t) lo = mid; else hi = mid; }
  const a = shot.keys[lo], b = shot.keys[hi];
  const f = a.hold && t < b.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  const round = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v)));
  return { x: round(a.x + (b.x - a.x) * f, record.geometry.width - record.crop.w),
    y: round(a.y + (b.y - a.y) * f, record.geometry.height - record.crop.h), ...record.crop };
}
