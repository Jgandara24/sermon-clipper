import { parseTrackingRecord, type TrackingRecord, type SubjectRect } from './types';

export type TrackingSample = { t: number; people: Array<{ id: string; score: number; certainty: number; body: SubjectRect }>;
  importantText?: SubjectRect[] };
export type TrackingShot = { id: string; start: number; end: number; selectedSubject: string | null; samples: TrackingSample[] };

/** Crop motion only. Callers supply selected subjects and independently validated evidence. */
export function buildTrackingPath(base: Omit<TrackingRecord, 'shots' | 'unresolved'>, shots: TrackingShot[]): TrackingRecord {
  const unresolved: TrackingRecord['unresolved'] = [];
  const { width, height } = base.geometry;
  const { w, h } = base.crop;
  const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
  const built = shots.map(shot => {
    let x = (width - w) / 2, y = (height - h) / 2, vx = 0, vy = 0;
    let reliable = -Infinity;
    const keys: TrackingRecord['shots'][number]['keys'] = [];
    if (!shot.samples.length || shot.samples[0].t !== shot.start) throw new Error('Tracking samples must start at the shot boundary.');
    shot.samples.forEach((sample, i) => {
      const next = shot.samples[i + 1]?.t ?? shot.end;
      if (next <= sample.t || sample.t < shot.start || next > shot.end) throw new Error('Tracking sample timestamps are invalid.');
      const person = sample.people.find(p => p.id === shot.selectedSubject && p.score >= 0.8 && p.certainty >= 0.9);
      const reason = !shot.selectedSubject ? 'identity' : sample.people.length && !person ? 'identity' : 'missing';
      if (!person) {
        // Hold only. Never select a different person or extrapolate invented confidence.
        const from = reason === 'missing' ? Math.max(sample.t, reliable + 0.25) : sample.t;
        if (from < next) unresolved.push({ start: from, end: next, reason });
        vx = vy = 0;
      } else {
        reliable = sample.t;
        if (next > reliable + 0.25) unresolved.push({ start: reliable + 0.25, end: next, reason: 'missing' });
        const body = person.body;
        if (![body.x, body.y, body.w, body.h].every(Number.isFinite) || body.w <= 0 || body.h <= 0) throw new Error('Invalid tracking body.');
        const region = { x: body.x, y: Math.max(0, body.y - body.h * 0.08), w: body.w, h: body.h * 1.08 };
        // One sample of offline look-ahead. Containment takes priority over smoothing.
        const future = shot.samples[i + 1]?.people.find(p => p.id === person.id && p.certainty >= 0.9 && p.score >= 0.8);
        const center = (body.x + body.w / 2) * 0.75 + ((future?.body.x ?? body.x) + (future?.body.w ?? body.w) / 2) * 0.25;
        const targetX = clamp(center - w / 2, width - w);
        const targetY = clamp(region.y - h * 0.08, height - h);
        const dt = i ? sample.t - shot.samples[i - 1].t : 0;
        const move = (pos: number, target: number, velocity: number) => {
          if (!i) return [target, 0];
          if (['face-follow-smooth-v2', 'face-recovery-v1'].includes(base.configuration)) {
            // Critically damped response, with time-based speed and acceleration limits.
            // Stop before a known detection gap. No crop movement or identity prediction fills that gap.
            let speedLimit = 60;
            for (let j = i + 1; j < shot.samples.length && shot.samples[j].t - sample.t <= .65; j++) {
              const nextSample = shot.samples[j];
              if (!nextSample.people.some(p => p.id === person.id && p.certainty >= .9 && p.score >= .8)) {
                speedLimit = Math.min(speedLimit, 100 * Math.max(0, nextSample.t - sample.t - dt));
                break;
              }
            }
            const error = pos - target;
            const damped = (velocity - 5 * (velocity + 5 * error) * dt) * Math.exp(-5 * dt);
            const desired = Math.max(-speedLimit, Math.min(speedLimit, damped));
            const speed = Math.max(velocity - 100 * dt, Math.min(velocity + 100 * dt, desired));
            return [pos + (velocity + speed) * dt / 2, speed];
          }
          const desired = Math.abs(target - pos) < 4 ? 0 : clamp((target - pos) / dt + 120, 240) - 120;
          const speed = Math.max(velocity - 240 * dt, Math.min(velocity + 240 * dt, desired));
          return [pos + speed * dt, speed];
        };
        [x, vx] = move(x, targetX, vx); [y, vy] = move(y, targetY, vy);
        if (region.w > w || region.h > h || region.x < 0 || region.x + region.w > width || region.y + region.h > height) {
          unresolved.push({ start: sample.t, end: next, reason: 'framing' });
        } else {
          x = Math.max(region.x + region.w - w, Math.min(region.x, x));
          y = Math.max(region.y + region.h - h, Math.min(region.y, y));
        }
        x = clamp(x, width - w); y = clamp(y, height - h);
      }
      if (sample.importantText?.some(r => r.x < x || r.y < y || r.x + r.w > x + w || r.y + r.h > y + h))
        unresolved.push({ start: sample.t, end: next, reason: 'source-text' });
      keys.push({ t: sample.t, x, y, ...(!person ? { hold: true } : {}) });
    });
    keys.push({ ...keys.at(-1)!, t: shot.end });
    if (!shot.selectedSubject) unresolved.push({ start: shot.start, end: shot.end, reason: 'identity' });
    return { id: shot.id, start: shot.start, end: shot.end, selectedSubject: shot.selectedSubject, keys };
  });
  return parseTrackingRecord({ ...base, availability: unresolved.length ? (shots.every(s => s.samples.every(p => !p.people.length)) ? 'unavailable' : 'uncertain') : 'available', shots: built, unresolved });
}
