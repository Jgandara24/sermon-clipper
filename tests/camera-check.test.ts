import { describe, expect, it } from "vitest";
import {
  cameraCheckPrompt,
  CameraFrameLabelsSchema,
  decideCameraCheck,
  groupNoFaceRuns,
  type CameraSample,
} from "@/lib/analysis/camera-check";

/** Samples every 0.5 s; `faces[i]` is the face count of sample i. */
function samples(faces: number[], start = 0): CameraSample[] {
  return faces.map((faceCount, i) => ({ t: start + i * 0.5, faceCount, image: `frame-${i}.jpg` }));
}

describe("groupNoFaceRuns", () => {
  it("groups consecutive samples with no face and picks the middle frame of each run", () => {
    const runs = groupNoFaceRuns(samples([1, 1, 0, 0, 0, 1, 0, 1]));
    expect(runs).toEqual([
      { start: 1, end: 2.5, image: "frame-3.jpg" },
      { start: 3, end: 3.5, image: "frame-6.jpg" },
    ]);
  });

  it("returns nothing when the preacher's face is always visible", () => {
    expect(groupNoFaceRuns(samples([1, 1, 2, 1]))).toEqual([]);
  });
});

describe("decideCameraCheck", () => {
  const runs = [
    { start: 4, end: 9, image: "a.jpg" },
    { start: 20, end: 21, image: "b.jpg" },
  ];

  it("rejects a clip when any run is a full-screen slide", () => {
    const result = decideCameraCheck(runs, ["PREACHER_OR_STAGE", "SLIDE"]);
    expect(result).toEqual({ pass: false, reason: "slide", at: 20 });
  });

  it("passes a clip whose faceless moments are the preacher turned away or the stage", () => {
    expect(decideCameraCheck(runs, ["PREACHER_OR_STAGE", "OTHER"])).toEqual({ pass: true });
  });

  it("passes a clip with no faceless moments at all", () => {
    expect(decideCameraCheck([], [])).toEqual({ pass: true });
  });

  it("fails closed when the labels do not match the runs", () => {
    expect(decideCameraCheck(runs, ["SLIDE"])).toEqual({ pass: false, reason: "unchecked", at: 4 });
  });
});

describe("cameraCheckPrompt", () => {
  const prompt = cameraCheckPrompt(3);

  it("names every kind of full-screen graphic the founder rejects", () => {
    for (const word of [/verse/i, /title/i, /lyrics|song words/i, /logo/i]) expect(prompt).toMatch(word);
  });

  it("asks for one label per numbered frame", () => {
    expect(prompt).toContain("3 frames");
    expect(prompt).toContain("SLIDE");
    expect(prompt).toContain("PREACHER_OR_STAGE");
  });

  it("parses the model's labels", () => {
    expect(CameraFrameLabelsSchema.parse({ frames: [{ index: 0, label: "SLIDE" }] }).frames[0].label).toBe("SLIDE");
    expect(() => CameraFrameLabelsSchema.parse({ frames: [{ index: 0, label: "MAYBE" }] })).toThrow();
  });
});
