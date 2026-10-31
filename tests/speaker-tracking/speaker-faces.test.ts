import { describe, expect, it } from 'vitest';
import { buildFaceTracking, type FaceObservations } from '@/lib/speaker-tracking/faces';
import { assertTrackingRange, parseTrackingRecord } from '@/lib/speaker-tracking/types';
import { buildSyntheticTracking } from '@/lib/speaker-tracking/synthetic';
import { trackingFixture } from './speaker-tracking.fixture';

function base() {
  const record = trackingFixture();
  return { ...record, start: 0, end: 1, detector: { kind: 'yunet' as const, version: 'opencv-4.11.0-yunet-2023mar', weightHashes: ['a'.repeat(64)] },
    configuration: 'face-follow-v1' as const, bodyEvidence: 'face-estimate' as const,
    analysis: { jobId: 'b'.repeat(64), attemptId: '00000000-0000-4000-8000-000000000001', observationsChecksum: 'c'.repeat(64) } };
}
const face = (x: number, w = 25) => ({ box: { x, y: 60, w, h: 30 }, score: .99 });
function frames(): FaceObservations {
  return { frames: Array.from({ length: 10 }, (_, i) => ({ t: i / 10, cut: false, faces: [face(200 + i)] })) };
}
describe('local face tracking integration', () => {
  it('records real provenance, body estimates, and required picture review', () => {
    const { record, review } = buildFaceTracking(base(), frames());
    expect(record.detector.kind).toBe('yunet'); expect(record.bodyEvidence).toBe('face-estimate');
    expect(record.requiredPictureReview).toBe(true); expect(record.unresolved).toEqual([]);
    expect(review[0].selection).toBe('stable-single-face');
    expect(() => buildSyntheticTracking(base(), [])).toThrow(/Synthetic provenance/);
  });
  it('steps at a cut without associating the old shot to the new subject', () => {
    const input = frames(); input.frames[5].cut = true;
    input.frames.slice(5).forEach(f => { f.faces = [face(450)]; });
    const { record } = buildFaceTracking(base(), input);
    expect(record.shots).toHaveLength(2);
    expect(record.shots[1].selectedSubject).not.toBe(record.shots[0].selectedSubject);
    expect(record.shots[1].keys[0].x - record.shots[0].keys.at(-1)!.x).toBeGreaterThan(200);
  });
  it('requires explicit selection when more than one face starts the shot', () => {
    const input = frames(); input.frames.forEach(f => f.faces.push(face(420, 40)));
    const ambiguous = buildFaceTracking(base(), input).record;
    expect(() => assertTrackingRange(ambiguous, 0, 1, true)).toThrow(/review/);
    const explicit = buildFaceTracking(base(), input, [{ shot: 0, faceIndex: 0 }]);
    expect(explicit.record.unresolved).toEqual([]); expect(explicit.review[0].selection).toBe('explicit');
  });
  it('does not jump to a larger person after missed detections', () => {
    const input = frames(); input.frames.slice(3, 7).forEach(f => { f.faces = []; });
    input.frames.slice(7).forEach(f => { f.faces = [face(400, 55)]; });
    const record = buildFaceTracking(base(), input).record;
    expect(record.unresolved.some(u => u.reason === 'missing')).toBe(true);
    expect(record.unresolved.some(u => u.reason === 'identity')).toBe(true);
    const x = record.shots[0].keys[2].x;
    expect(record.shots[0].keys.slice(3).every(k => k.x === x)).toBe(true);
  });
  it('holds a brief miss and recovers only a compatible subject', () => {
    const input = frames(); input.frames[4].faces = [];
    expect(buildFaceTracking(base(), input).record.unresolved).toEqual([]);
  });
  it('latches ambiguous crossings until review or a new shot', () => {
    const input = frames(); input.frames[4].faces.push(face(205));
    const record = buildFaceTracking(base(), input).record;
    expect(record.unresolved.at(-1)!.end).toBe(1);
  });
  it('flags body estimates outside the source instead of shifting their center', () => {
    const input = frames(); input.frames.forEach(f => { f.faces=[face(2)]; });
    const record=buildFaceTracking(base(),input).record;
    expect(record.unresolved.some(u => u.reason === 'framing')).toBe(true);
    expect(() => assertTrackingRange(record,0,1,true)).toThrow(/review/);
  });
  it('keeps low-confidence observations unresolved', () => {
    const input=frames(); input.frames.forEach(f => { f.faces[0].score=.6; });
    const record=buildFaceTracking(base(),input).record;
    expect(record.shots[0].selectedSubject).toBeNull();
    expect(() => assertTrackingRange(record,0,1,true)).toThrow(/review/);
  });
  it('rejects missing analysis provenance and invalid real configuration', () => {
    const { record } = buildFaceTracking(base(), frames());
    expect(() => parseTrackingRecord({ ...record, analysis: undefined })).toThrow();
    expect(() => parseTrackingRecord({ ...record, configuration: 'synthetic-v1' })).toThrow();
    expect(() => parseTrackingRecord({ ...record, bodyEvidence: 'synthetic-measured' })).toThrow();
  });
  it('rejects invalid observations and explicit selection', () => {
    const input = frames(); input.frames[1].t = 0;
    expect(() => buildFaceTracking(base(), input)).toThrow();
    expect(() => buildFaceTracking(base(), frames(), [{ shot: 0, faceIndex: 9 }])).toThrow();
  });
});
