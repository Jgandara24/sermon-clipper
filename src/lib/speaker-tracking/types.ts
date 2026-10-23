import { z } from 'zod';

const time = z.number().finite().min(0).max(86400);
const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rect = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(),
  w: z.number().finite().positive(), h: z.number().finite().positive() }).strict();
export const trackingReferenceSchema = z.object({ artifactId: z.string().uuid(), checksum: hash }).strict();
export const trackingRecordSchema = z.object({
  version: z.literal('speaker-v1'), mapping: z.literal('pixels-linear-v1'),
  workspaceId: id, sourceVideoId: id, sourceChecksum: hash,
  geometry: z.object({ width: z.number().int().min(2).max(16384), height: z.number().int().min(2).max(16384),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    pixelAspect: z.string().regex(/^\d{1,6}:\d{1,6}$/), timebase: z.string().regex(/^\d{1,9}\/\d{1,9}$/) }).strict(),
  start: time, end: time, aspect: z.enum(['9:16', '1:1', '16:9']),
  detector: z.object({ kind: z.enum(['synthetic', 'yunet', 'manual']), version: id, weightHashes: z.array(hash).max(8) }).strict(),
  configuration: z.enum(['synthetic-v1', 'face-follow-v1', 'face-follow-smooth-v2', 'manual-path-v1', 'face-recovery-v1']),
  recoveries: z.array(z.object({ shot: id, lastReliable: time, candidateStart: time, resumed: time, reviewUntil: time }).strict()).max(1000).optional(),
  analysis: z.object({ jobId: hash, attemptId: z.string().uuid(), observationsChecksum: hash }).strict().optional(),
  manualPreparation: z.object({ preparedBy: z.enum(['human', 'assistant']), proposalChecksum: hash }).strict().optional(),
  availability: z.enum(['available', 'uncertain', 'unavailable']),
  crop: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }).strict(),
  shots: z.array(z.object({ id, start: time, end: time, selectedSubject: id.nullable(),
    keys: z.array(z.object({ t: time, hold: z.boolean().optional(), x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() }).strict()).min(2).max(10000),
  }).strict()).min(1).max(1000),
  unresolved: z.array(z.object({ start: time, end: time,
    reason: z.enum(['identity', 'missing', 'framing', 'source-text', 'unavailable']) }).strict()).max(10000),
  bodyEvidence: z.enum(['synthetic-measured', 'face-estimate', 'manual-framing']),
  requiredPictureReview: z.literal(true),
}).strict().superRefine((r, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (r.detector.kind === 'yunet' && (!['face-follow-v1', 'face-follow-smooth-v2', 'face-recovery-v1'].includes(r.configuration) || r.bodyEvidence !== 'face-estimate'
    || r.detector.weightHashes.length !== 1 || !r.analysis)) invalid('Real tracking requires detector and analysis provenance.');
  if (r.detector.kind === 'synthetic' && (r.configuration !== 'synthetic-v1' || r.analysis)) invalid('Synthetic provenance is invalid.');
  if (r.detector.kind === 'manual') {
    if (r.configuration !== 'manual-path-v1' || r.bodyEvidence !== 'manual-framing'
      || r.detector.weightHashes.length || r.analysis || !r.manualPreparation) invalid('Manual paths require manual provenance only.');
    if (r.shots.some(s => s.selectedSubject !== null)) invalid('Manual paths do not claim detected subjects.');
  } else if (r.manualPreparation || r.configuration === 'manual-path-v1' || r.bodyEvidence === 'manual-framing') {
    invalid('Manual provenance requires a manual path.');
  }
  if (r.configuration === 'face-recovery-v1') {
    if (!r.recoveries) invalid('Recovery provenance is required.');
    for (const event of r.recoveries ?? []) {
      const shot = r.shots.find(s => s.id === event.shot);
      if (!shot || event.lastReliable < shot.start || event.lastReliable >= event.candidateStart
        || event.candidateStart + .2 > event.resumed + 1e-9 || event.resumed >= shot.end
        || event.resumed - event.lastReliable > .75 + 1e-9 || event.reviewUntil !== shot.end)
        invalid('Recovery event is invalid.');
      if (!r.unresolved.some(u => u.reason === 'identity' && u.start <= event.lastReliable && u.end >= event.reviewUntil))
        invalid('Recovery identity requires review through the shot ending.');
    }
  } else if (r.recoveries) invalid('Recovery provenance requires the recovery configuration.');
  if (r.end <= r.start || r.end - r.start > 1800) invalid('Tracking interval is invalid.');
  if (r.crop.w % 2 || r.crop.h % 2 || r.crop.w > r.geometry.width || r.crop.h > r.geometry.height) invalid('Crop dimensions are invalid.');
  const [ow, oh] = r.aspect.split(':').map(Number);
  const ratio = ow / oh;
  const even = (n: number) => Math.floor(n / 2) * 2;
  const expectedW = even(Math.min(r.geometry.width, r.geometry.height * ratio));
  const expectedH = even(Math.min(r.geometry.height, r.geometry.width / ratio));
  if (r.crop.w !== expectedW || r.crop.h !== expectedH) invalid('Tracking requires fixed fill dimensions for this format.');
  if (r.geometry.pixelAspect !== '1:1') invalid('Non-square source pixels require a verified display mapping.');
  if (r.geometry.timebase.split('/').some(n => Number(n) <= 0)) invalid('Source timebase is invalid.');
  if (r.availability === 'available' && r.unresolved.length) invalid('Available tracking cannot contain unresolved intervals.');
  if (r.availability !== 'available' && !r.unresolved.length) invalid('Uncertain tracking requires review intervals.');
  let end = r.start;
  let count = 0;
  const ids = new Set<string>();
  for (const shot of r.shots) {
    if (ids.has(shot.id)) invalid('Shot IDs must be unique.');
    ids.add(shot.id);
    if (shot.start !== end || shot.end <= shot.start || shot.end > r.end) invalid('Shots must cover the interval exactly.');
    end = shot.end;
    if (shot.keys[0].t !== shot.start || shot.keys.at(-1)!.t !== shot.end) invalid('Keys must cover each shot.');
    let previous = -1;
    for (const key of shot.keys) {
      count++;
      if (key.t <= previous || key.t < shot.start || key.t > shot.end) invalid('Keys must have ordered source timestamps.');
      if (key.x + r.crop.w > r.geometry.width || key.y + r.crop.h > r.geometry.height) invalid('Crop leaves the source.');
      previous = key.t;
    }
    if (r.detector.kind !== 'manual' && !shot.selectedSubject && !r.unresolved.some(u => u.start <= shot.start && u.end >= shot.end)) invalid('Unselected shots require review.');
  }
  if (end !== r.end || count > 20000) invalid('Tracking coverage or size is invalid.');
  for (const u of r.unresolved) if (u.start < r.start || u.end > r.end || u.end <= u.start) invalid('Review interval is invalid.');
});
export type TrackingRecord = z.infer<typeof trackingRecordSchema>;
export type TrackingReference = z.infer<typeof trackingReferenceSchema>;
export type SubjectRect = z.infer<typeof rect>;
export const subjectRectSchema = rect;
export const MAX_TRACKING_BYTES = 4 * 1024 * 1024;
export class TrackingError extends Error {}

export function parseTrackingRecord(value: unknown): TrackingRecord {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new TrackingError('Tracking record is invalid.'); }
  if (serialized === undefined) throw new TrackingError('Tracking record is invalid.');
  if (new TextEncoder().encode(serialized).byteLength > MAX_TRACKING_BYTES)
    throw new TrackingError('Tracking record is too large.');
  const result = trackingRecordSchema.safeParse(value);
  if (!result.success) throw new TrackingError('Tracking record is invalid.');
  return result.data;
}

export function assertTrackingRange(record: TrackingRecord, start: number, end: number, acceptance = false) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < record.start || end > record.end || end <= start)
    throw new TrackingError('Tracking does not cover this clip.');
  if (acceptance && record.unresolved.some(u => u.start < end && u.end > start))
    throw new TrackingError('Tracking requires review before output acceptance.');
}
