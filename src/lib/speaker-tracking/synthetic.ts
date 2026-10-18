import { buildTrackingPath, type TrackingSample, type TrackingShot } from './motion';
import type { TrackingRecord } from './types';
export type SyntheticSample = TrackingSample;
export type SyntheticShot = TrackingShot;

/** Fixture-only evidence. Never label real detections as synthetic. */
export function buildSyntheticTracking(base: Omit<TrackingRecord, 'shots' | 'unresolved'>, shots: SyntheticShot[]) {
  if (base.detector.kind !== 'synthetic' || base.configuration !== 'synthetic-v1') throw new Error('Synthetic provenance required.');
  return buildTrackingPath(base, shots);
}
