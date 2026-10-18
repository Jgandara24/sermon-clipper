import { z } from 'zod';
import { buildTrackingPath, type TrackingShot } from './motion';
import { parseTrackingRecord, subjectRectSchema, type SubjectRect, type TrackingRecord } from './types';

export const observationsSchema = z.object({
  frames: z.array(z.object({ t: z.number().finite(), cut: z.boolean(),
    faces: z.array(z.object({ box: subjectRectSchema, score: z.number().min(0).max(1) }).strict()).max(100),
  }).strict()).min(1).max(20000),
}).strict();
export type FaceObservations = z.infer<typeof observationsSchema>;
export type FaceSelection = { shot: number; faceIndex: number };

function compatible(a: SubjectRect, b: SubjectRect, elapsed: number) {
  const distance = Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
  return distance <= Math.max(a.w, a.h) * .65 + 60 * elapsed
    && b.w / a.w > .65 && b.w / a.w < 1.55 && b.h / a.h > .65 && b.h / a.h < 1.55;
}

/** Temporary geometric tracks only. No biometric identity or automatic largest-face choice. */
export function buildRecoverableFaceTracking(base: Omit<TrackingRecord, 'shots' | 'unresolved'>,
  input: FaceObservations, selections: FaceSelection[] = []) {
  if (base.configuration !== 'face-recovery-v1') throw new Error('Recovery configuration required.');
  if (base.detector.kind !== 'yunet') throw new Error('Real detector provenance required.');
  const observations = observationsSchema.parse(input);
  if (observations.frames[0].t !== base.start) throw new Error('Observations must start at the source interval.');
  for (let i = 0; i < observations.frames.length; i++) {
    const frame = observations.frames[i];
    if (frame.t >= base.end || (i && frame.t <= observations.frames[i - 1].t)) throw new Error('Invalid observation times.');
    for (const face of frame.faces) if (face.box.x + face.box.w > base.geometry.width || face.box.y + face.box.h > base.geometry.height)
      throw new Error('Face box leaves source geometry.');
  }
  const groups: FaceObservations['frames'][] = [];
  for (const frame of observations.frames) {
    if (!groups.length || frame.cut) groups.push([]);
    groups.at(-1)!.push(frame);
  }
  if (new Set(selections.map(s => s.shot)).size !== selections.length
    || selections.some(s => !Number.isInteger(s.shot) || s.shot < 0 || s.shot >= groups.length
      || !Number.isInteger(s.faceIndex) || s.faceIndex < 0 || s.faceIndex >= groups[s.shot][0].faces.length))
    throw new Error('Invalid explicit subject selection.');
  const review: Array<{ shot: number; start: number; end: number; selection: string; facesAtStart: number }> = [];
  const recoveries: NonNullable<TrackingRecord['recoveries']> = [];
  const retained: TrackingRecord['unresolved'] = [];
  const shots: TrackingShot[] = groups.map((frames, index) => {
    const selected = selections.find(s => s.shot === index);
    const first = frames[0];
    const stableSingle = frames.length >= 3 && frames.slice(0, 3).every(f => f.faces.length === 1 && f.faces[0].score >= .9)
      && frames.slice(1, 3).every(f => compatible(first.faces[0].box, f.faces[0].box, f.t - first.t));
    let previous = selected ? first.faces[selected.faceIndex] : stableSingle ? first.faces[0] : undefined;
    if (previous && previous.score < .9) previous = undefined;
    const subject = previous ? `shot-${index}-subject` : null;
    let lastTime = first.t;
    let lost = !previous;
    let blocked = !previous;
    let gapStart: number | undefined;
    let confirmation: { start: number; last: number; count: number; box: SubjectRect } | undefined;
    const end = groups[index + 1]?.[0].t ?? base.end;
    review.push({ shot: index, start: first.t, end, facesAtStart: first.faces.length,
      selection: selected ? 'explicit' : stableSingle ? 'stable-single-face' : 'unresolved' });
    const samples = frames.map((frame, i) => {
      const elapsed = frame.t - lastTime;
      if (elapsed > .25) lost = true;
      const candidates = previous ? frame.faces.filter(f => f.score >= .9 && compatible(previous!.box, f.box, elapsed)) : [];
      let found = i === 0 ? previous : !lost && candidates.length === 1 ? candidates[0] : undefined;
      // Ambiguity never enters automatic recovery. A cut creates a new selection.
      if (candidates.length > 1 && i > 0) { lost = true; blocked = true; }
      if (!found && gapStart === undefined) gapStart = frame.t;
      if (gapStart !== undefined && frame.faces.length > 0 && candidates.length !== 1) blocked = true;
      if (lost && !blocked && previous && subject) {
        // Deadline includes confirmation. It never expands with candidate drift.
        if (elapsed > .75 + 1e-9) blocked = true;
        else if (frame.faces.length === 1 && candidates.length === 1) {
          const candidate = candidates[0];
          if (!confirmation) confirmation = { start: frame.t, last: frame.t, count: 1, box: candidate.box };
          else if (frame.t - confirmation.last <= .1 + 1e-9
            && compatible(confirmation.box, candidate.box, frame.t - confirmation.last)) {
            confirmation.last = frame.t; confirmation.count++; confirmation.box = candidate.box;
          } else { blocked = true; }
          if (!blocked && confirmation.count >= 3 && frame.t - confirmation.start >= .2 - 1e-9) {
            recoveries.push({ shot: `shot-${index}`, lastReliable: lastTime, candidateStart: confirmation.start, resumed: frame.t, reviewUntil: end });
            // Geometry cannot establish identity after occlusion. Keep all later crops unapproved.
            retained.push({ start: lastTime, end, reason: 'identity' });
            found = candidate; lost = false; confirmation = undefined;
          }
        } else {
          confirmation = undefined;
          if (frame.faces.length) blocked = true;
        }
      }
      if (blocked && i > 0) { lost = true; found = undefined; }
      if (found && !lost && subject) {
        previous = found; lastTime = frame.t; gapStart = undefined;
        // Estimated upper body. Headroom is added by the shared motion solver.
        const b = found.box;
        const body = { x: b.x - b.w * .85, y: b.y, w: b.w * 2.7, h: b.h * 4.5 };
        // .9 is the rule threshold for this geometric association, not a calibrated speaker probability.
        return { t: frame.t, people: [{ id: subject, score: found.score, certainty: .9, body }] };
      }
      // An observed alternate person never substitutes for the selected track.
      return { t: frame.t, people: frame.faces.map((f, n) => ({ id: `unselected-${n}`, score: f.score, certainty: 0, body: f.box })) };
    });
    return { id: `shot-${index}`, start: first.t, end, selectedSubject: subject, samples };
  });
  const record = buildTrackingPath({ ...base, recoveries: [] }, shots);
  record.unresolved.push(...retained);
  if (record.unresolved.length) record.availability = 'uncertain';
  return { record: parseTrackingRecord({ ...record, recoveries }), review, recoveries };
}
