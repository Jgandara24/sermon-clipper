import type { TrackingRecord } from '../../src/lib/speaker-tracking/types';
export function trackingFixture(): TrackingRecord {
  return { version: 'speaker-v1', mapping: 'pixels-linear-v1', workspaceId: 'workspace', sourceVideoId: 'source', sourceChecksum: 'a'.repeat(64),
    geometry: { width: 640, height: 360, rotation: 0, pixelAspect: '1:1', timebase: '1/3000000' },
    start: 12.013, end: 15.282, aspect: '9:16', detector: { kind: 'synthetic', version: 'fixture-v1', weightHashes: [] },
    configuration: 'synthetic-v1', availability: 'available', crop: { w: 202, h: 360 }, bodyEvidence: 'synthetic-measured', requiredPictureReview: true,
    shots: [{ id: 'left', start: 12.013, end: 14, selectedSubject: 'speaker', keys: [
      { t: 12.013, x: 10, y: 0 }, { t: 13, x: 70, y: 0 }, { t: 14, x: 130, y: 0 }] },
    { id: 'right', start: 14, end: 15.282, selectedSubject: 'speaker-2', keys: [
      { t: 14, x: 430, y: 0 }, { t: 15.282, x: 280, y: 0 }] }], unresolved: [] };
}
