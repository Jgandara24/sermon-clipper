import { describe, expect, it } from "vitest";
import { applyBodyFill, type PeopleObservations } from "@/lib/speaker-tracking/body-fill";
import type { FaceObservations } from "@/lib/speaker-tracking/faces";

// Lab sermons 2 and 3, 2026-10-18: six of Jake's seven failures were the crop losing the preacher
// when he turned sideways ("track his body and shoulders"). These clips are 1280×720 at 30 fps;
// the person detector samples every third frame, as the lab observer does.
const FPS = 30;
const FACE_W = 60;
const BODY_W = 280;

type Scene = {
  frames: number;
  /** Center x of his lone face at frame i, or null when the face detector cannot see it. */
  face: (i: number) => number | null;
  /** Center x of each person box at frame i (his first). */
  people: (i: number) => number[];
  cuts?: number[];
};

function scene({ frames, face, people, cuts = [] }: Scene) {
  const t = (i: number) => 100 + i / FPS;
  const faces: FaceObservations = {
    frames: Array.from({ length: frames }, (_, i) => {
      const x = face(i);
      return {
        t: t(i),
        cut: cuts.includes(i),
        faces: x === null ? [] : [{ score: 0.92, box: { x: x - FACE_W / 2, y: 100, w: FACE_W, h: 72 } }],
      };
    }),
  };
  const bodies: PeopleObservations = {
    frames: Array.from({ length: Math.ceil(frames / 3) }, (_, k) => ({
      t: t(k * 3),
      people: people(k * 3).map((x) => ({ score: 0.92, box: { x: x - BODY_W / 2, y: 70, w: BODY_W, h: 640 } })),
    })),
  };
  return { faces, bodies };
}

const centerAt = (observations: FaceObservations, i: number) => {
  const f = observations.frames[i].faces;
  return f.length === 1 ? f[0].box.x + f[0].box.w / 2 : null;
};

describe("applyBodyFill", () => {
  it("follows his body while his face is turned away", () => {
    // Face seen at 600; he turns and walks to 900 over two seconds; the face comes back at 900.
    const walk = (i: number) => (i < 30 ? 600 : i < 90 ? 600 + (300 * (i - 30)) / 60 : 900);
    const { faces, bodies } = scene({ frames: 120, face: (i) => (i >= 30 && i < 90 ? null : walk(i)), people: (i) => [walk(i)] });
    const { observations, bodyFilledFrames } = applyBodyFill(faces, bodies);

    expect(bodyFilledFrames).toBe(60);
    for (let i = 30; i < 90; i += 1) expect(Math.abs(centerAt(observations, i)! - walk(i)), `frame ${i}`).toBeLessThanOrEqual(6);
  });

  it("blends the face-to-body offset so the filled path meets the real face at both ends", () => {
    // His face sits 40 px right of his body center before the turn and 30 px left after it.
    const body = (i: number) => 600 + i;
    const { faces, bodies } = scene({
      frames: 120,
      face: (i) => (i < 30 ? body(i) + 40 : i >= 90 ? body(i) - 30 : null),
      people: (i) => [body(i)],
    });
    const { observations } = applyBodyFill(faces, bodies);
    const xs = observations.frames.map((_, i) => centerAt(observations, i)!);

    expect(Math.abs(xs[30] - (body(30) + 40))).toBeLessThanOrEqual(3);
    expect(Math.abs(xs[89] - (body(89) - 30))).toBeLessThanOrEqual(3);
    const steps = xs.slice(1).map((x, i) => Math.abs(x - xs[i]));
    expect(Math.max(...steps)).toBeLessThanOrEqual(4);
  });

  it("follows the preacher, not another person on stage", () => {
    // A worship leader stands still at 250 while the preacher turns and walks right.
    const walk = (i: number) => 700 + 2 * i;
    const { faces, bodies } = scene({
      frames: 90,
      face: (i) => (i < 15 || i >= 75 ? walk(i) : null),
      people: (i) => [walk(i), 250],
    });
    const { observations } = applyBodyFill(faces, bodies);
    for (let i = 15; i < 75; i += 1) expect(Math.abs(centerAt(observations, i)! - walk(i)), `frame ${i}`).toBeLessThanOrEqual(6);
  });

  it("never follows a box across a camera cut; after a cut it works back from his next sighting", () => {
    // Close shot with him at 900, a cut at frame 30 to a wide shot, his face first seen at 400.
    const { faces, bodies } = scene({
      frames: 90,
      cuts: [30],
      face: (i) => (i < 30 ? 900 : i >= 60 ? 400 : null),
      people: (i) => (i < 30 ? [900] : [370 + Math.min(30, i - 30)]),
    });
    const { observations } = applyBodyFill(faces, bodies);
    for (let i = 30; i < 60; i += 1) expect(Math.abs(centerAt(observations, i)! - (370 + (i - 30))), `frame ${i}`).toBeLessThanOrEqual(6);
  });

  it("leaves a gap unfilled when the person detector finds nobody there", () => {
    const { faces, bodies } = scene({
      frames: 90,
      face: (i) => (i < 30 || i >= 60 ? 600 : null),
      people: (i) => (i < 30 || i >= 60 ? [600] : []),
    });
    const { observations, bodyFilledFrames } = applyBodyFill(faces, bodies);
    expect(bodyFilledFrames).toBe(0);
    expect(observations.frames[45].faces).toHaveLength(0);
  });

  it("does not follow anyone in a shot where his face never appears", () => {
    // A shot of the band: two people, no face the preacher can be matched to.
    const { faces, bodies } = scene({ frames: 60, face: () => null, people: () => [300, 900] });
    expect(applyBodyFill(faces, bodies).bodyFilledFrames).toBe(0);
  });

  it("never fills frames where two faces are on screen", () => {
    const { faces, bodies } = scene({ frames: 60, face: (i) => (i < 15 ? 600 : null), people: () => [600] });
    faces.frames[30].faces = [
      { score: 0.95, box: { x: 200, y: 100, w: 60, h: 72 } },
      { score: 0.95, box: { x: 900, y: 100, w: 60, h: 72 } },
    ];
    const { observations } = applyBodyFill(faces, bodies);
    expect(observations.frames[30].faces).toHaveLength(2);
    expect(observations.frames[29].faces).toHaveLength(1);
  });

  it("does not change the input observations", () => {
    const { faces, bodies } = scene({ frames: 60, face: (i) => (i < 15 ? 600 : null), people: () => [600] });
    const before = JSON.stringify(faces);
    applyBodyFill(faces, bodies);
    expect(JSON.stringify(faces)).toBe(before);
  });
});

describe("applyBodyFill while his arms are out (fix H)", () => {
  // Lab sermon 2c clip 5 (2026-10-18), measured: with his face turned away he spread his arms, his
  // person box grew from 390 to 642 px wide in 0.3 s, its center swung 60 px, and the crop followed.
  // Jake: "when the speaker moved side to side the stabilization/focus seems shaky/jittery".
  it("does not take his position from a box much wider than his usual box in that shot", () => {
    const t = (i: number) => 100 + i / FPS;
    const armsOut = (i: number) => i >= 60 && i < 90;
    const faces: FaceObservations = {
      frames: Array.from({ length: 150 }, (_, i) => ({
        t: t(i),
        cut: false,
        faces: i >= 30 && i < 120 ? [] : [{ score: 0.92, box: { x: 600 - FACE_W / 2, y: 100, w: FACE_W, h: 72 } }],
      })),
    };
    // He stays at 600; with an arm out to his left the box reaches 160 px further that way.
    const bodies: PeopleObservations = {
      frames: Array.from({ length: 50 }, (_, k) => ({
        t: t(3 * k),
        people: [{ score: 0.92, box: armsOut(3 * k) ? { x: 600 - BODY_W / 2, y: 70, w: BODY_W + 160, h: 640 } : { x: 600 - BODY_W / 2, y: 70, w: BODY_W, h: 640 } }],
      })),
    };
    const { observations } = applyBodyFill(faces, bodies);
    for (let i = 30; i < 120; i += 1) {
      const center = centerAt(observations, i);
      // Either filled from a normal box (at 600) or left for the crop to hold; never pulled to 680.
      if (center !== null) expect(Math.abs(center - 600), `frame ${i}`).toBeLessThanOrEqual(6);
    }
    expect(centerAt(observations, 75)).toBeNull();
    expect(centerAt(observations, 45)).not.toBeNull();
  });

  it("still follows a box that is wide for the whole shot", () => {
    // A wide shot from the side: his box is wide throughout, so wide is his usual size there.
    const walk = (i: number) => (i < 30 ? 600 : i < 90 ? 600 + (300 * (i - 30)) / 60 : 900);
    const { faces, bodies } = scene({ frames: 120, face: (i) => (i >= 30 && i < 90 ? null : walk(i)), people: (i) => [walk(i)] });
    bodies.frames.forEach((frame) => frame.people.forEach((p) => ((p.box.w = BODY_W * 2), (p.box.x -= BODY_W / 2))));
    const { bodyFilledFrames } = applyBodyFill(faces, bodies);
    expect(bodyFilledFrames).toBe(60);
  });
});

describe("applyBodyFill across a camera re-frame (fix S)", () => {
  // Lab sermon 4g clip 4 (2026-10-22): he faced sideways for the first 5.9 s, and at 5.8 s the camera
  // re-framed him without a cut. His person box jumped 147 px with the same height, so the overlap
  // chain back from his first face stopped there, and he walked out of the waiting crop for about
  // 1 s. Jake: "We cannot have a pastor be off the screen for half a second or a second."
  const t = (i: number) => 100 + i / FPS;
  /** He walks right with his face away; at frame 171 the camera re-frames him 400 px to the left. */
  const at = (i: number) => 500 + 2 * i - (i >= 171 ? 400 : 0);
  const faces: FaceObservations = {
    frames: Array.from({ length: 210 }, (_, i) => ({
      t: t(i),
      cut: false,
      faces: i < 180 ? [] : [{ score: 0.92, box: { x: at(i) + 20 - FACE_W / 2, y: 100, w: FACE_W, h: 72 } }],
    })),
  };
  const bodies = (people: (i: number) => { x: number; w: number; h: number }[]): PeopleObservations => ({
    frames: Array.from({ length: 70 }, (_, k) => ({
      t: t(3 * k),
      people: people(3 * k).map((p) => ({ score: 0.92, box: { x: p.x - p.w / 2, y: 70, w: p.w, h: p.h } })),
    })),
  });

  it("keeps following the one person in view when his box jumps but keeps its size", () => {
    const { observations, bodyFilledFrames } = applyBodyFill(faces, bodies((i) => [{ x: at(i), w: BODY_W, h: 640 }]));

    expect(bodyFilledFrames).toBe(180);
    // Frames 169 and 170 lie between the samples on either side of the jump.
    for (let i = 0; i < 180; i += 1) {
      if (i === 169 || i === 170) continue;
      expect(Math.abs(centerAt(observations, i)! - (at(i) + 20)), `frame ${i}`).toBeLessThanOrEqual(6);
    }
  });

  it("does not follow the jump when the box changes size, as at a zoom", () => {
    const { observations } = applyBodyFill(faces, bodies((i) => [i < 171 ? { x: at(i), w: BODY_W, h: 640 } : { x: at(i), w: 180, h: 420 }]));
    expect(centerAt(observations, 60)).toBeNull();
    expect(centerAt(observations, 175)).not.toBeNull();
  });

  it("does not follow the jump when two people are in view", () => {
    const { observations } = applyBodyFill(
      faces,
      bodies((i) => (i < 171 ? [{ x: at(i), w: BODY_W, h: 640 }, { x: 1150, w: BODY_W, h: 640 }] : [{ x: at(i), w: BODY_W, h: 640 }])),
    );
    expect(centerAt(observations, 60)).toBeNull();
    expect(centerAt(observations, 175)).not.toBeNull();
  });
});
