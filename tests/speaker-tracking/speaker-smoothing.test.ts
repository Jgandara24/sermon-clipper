import { describe, expect, it } from 'vitest';
import { buildFaceTracking, type FaceObservations } from '@/lib/speaker-tracking/faces';
import { trackingFixture } from './speaker-tracking.fixture';
import { trackingCropAt } from '@/lib/speaker-tracking/path';
const face = (x:number) => ({box:{x,y:60,w:25,h:30},score:.99});
const base = () => ({...trackingFixture(),start:0,end:4,configuration:'face-follow-smooth-v2' as const,
  detector:{kind:'yunet' as const,version:'generated-observations',weightHashes:['a'.repeat(64)]},bodyEvidence:'face-estimate' as const,
  analysis:{jobId:'b'.repeat(64),attemptId:'00000000-0000-4000-8000-000000000001',observationsChecksum:'c'.repeat(64)}});
function input(rate=30):FaceObservations {return {frames:Array.from({length:Math.ceil(4*rate)},(_,i)=>({t:i/rate,cut:false,faces:[face(200+Math.min(i/rate,2)*15)]})).filter(f=>f.t<4)};}
function movement(r:ReturnType<typeof buildFaceTracking>['record']) {
  const speeds:number[]=[],accelerations:number[]=[];
  for(const shot of r.shots){let last=0;for(let i=1;i<shot.keys.length-1;i++){
    const a=shot.keys[i-1],b=shot.keys[i],dt=b.t-a.t,v=(b.x-a.x)/dt;
    speeds.push(Math.abs(v));accelerations.push(Math.abs(v-last)/dt);last=v;
  }}
  return {speed:Math.max(...speeds),acceleration:Math.max(...accelerations),mean:accelerations.reduce((a,b)=>a+b,0)/accelerations.length};
}
describe('smooth tracking from generated face observations, not detector accuracy',()=>{
  it('reduces acceleration on small position changes and brakes without overshoot',()=>{
    const observations=input();
    const smooth=buildFaceTracking(base(),observations).record;
    const old=buildFaceTracking({...base(),configuration:'face-follow-v1'},observations).record;
    expect(movement(smooth).mean).toBeLessThan(movement(old).mean*.6);
    expect(movement(smooth).acceleration).toBeLessThanOrEqual(100.01);
    expect(movement(smooth).speed).toBeLessThanOrEqual(60.01);
    expect(smooth.unresolved).toEqual([]);
    const stop=230+12.5-101;
    expect(Math.max(...smooth.shots[0].keys.map(k=>k.x))).toBeLessThanOrEqual(stop+.1);
  });
  it('brakes before a brief miss and holds without invented movement',()=>{
    const observations=input();observations.frames.slice(45,49).forEach(f=>{f.faces=[];});
    const r=buildFaceTracking(base(),observations).record;
    expect(r.unresolved).toEqual([]);
    const x=r.shots[0].keys[44].x;
    expect(r.shots[0].keys.slice(45,49).every(k=>k.hold&&k.x===x)).toBe(true);
    expect(movement(r).acceleration).toBeLessThanOrEqual(100.01);
  });
  it('keeps the camera cut immediate and does not blend subjects between shots',()=>{
    const observations=input();observations.frames[60].cut=true;
    observations.frames.slice(60).forEach(f=>{f.faces=[face(440)];});
    const r=buildFaceTracking(base(),observations).record;
    expect(trackingCropAt(r,2).x-trackingCropAt(r,1.999999).x).toBeGreaterThan(190);
    expect(r.shots[0].selectedSubject).not.toBe(r.shots[1].selectedSubject);
  });
  it('keeps long missing intervals unresolved and never substitutes another face',()=>{
    const observations=input();observations.frames.slice(40,60).forEach(f=>{f.faces=[];});
    observations.frames.slice(60).forEach(f=>{f.faces=[face(440)];});
    const r=buildFaceTracking(base(),observations).record;
    expect(r.unresolved.some(u=>u.reason==='missing')).toBe(true);
    expect(r.unresolved.some(u=>u.reason==='identity')).toBe(true);
    expect(r.shots[0].keys.slice(40).every(k=>k.x===r.shots[0].keys[39].x)).toBe(true);
  });
  it.each([24,25,30000/1001,60])('uses elapsed time consistently at %s fps',rate=>{
    const reference=buildFaceTracking(base(),input(60)).record;
    const r=buildFaceTracking(base(),input(rate)).record;
    for(const t of [1,2,3])expect(Math.abs(trackingCropAt(r,t).x-trackingCropAt(reference,t).x)).toBeLessThanOrEqual(1);
    expect(movement(r).acceleration).toBeLessThanOrEqual(100.01);
  });
  it('supports irregular frame intervals without changing shot coverage',()=>{
    const observations=input(60);observations.frames=observations.frames.filter((f,i)=>f.t<2?i%2===0:i%3===0);
    const r=buildFaceTracking(base(),observations).record;
    expect(r.start).toBe(0);expect(r.end).toBe(4);expect(r.unresolved).toEqual([]);
    expect(movement(r).speed).toBeLessThanOrEqual(60.01);
  });
});
