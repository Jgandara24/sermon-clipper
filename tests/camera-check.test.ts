import { describe, expect, it } from "vitest";
import {
  cameraCheckPrompt,
  CameraFrameLabelsSchema,
  cameraRunsToShow,
  decideCameraCheck,
  decideEmptyFrames,
  emptyRuns,
  groupNoFaceRuns,
  runsToDetectPeople,
  sceneChangeRuns,
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
      { start: 1, end: 2.5, image: "frame-3.jpg", via: "no face" },
      { start: 3, end: 3.5, image: "frame-6.jpg", via: "no face" },
    ]);
  });

  it("returns nothing when the preacher's face is always visible", () => {
    expect(groupNoFaceRuns(samples([1, 1, 2, 1]))).toEqual([]);
  });
});

describe("fix Y: scene changes go to the model too", () => {
  // Lab sermon 4i clip 6: the "Christians Never Die" slide at 16.0 s, gray difference 58, between two samples with a face.
  const faceless = [
    { start: 40, end: 43, image: "turned-away.jpg", via: "no face" as const },
    { start: 10, end: 10.25, image: "blink.jpg", via: "no face" as const },
  ];

  it("turns each scene change into a run one sample long", () => {
    expect(sceneChangeRuns([{ t: 1939.23, score: 58.4, image: "scene-000.jpg" }], 0.25)).toEqual([
      { start: 1939.23, end: 1939.48, image: "scene-000.jpg", via: "scene change" },
    ]);
  });

  it("shows scene changes outside the faceless runs first, then the faceless runs longest first", () => {
    const scene = sceneChangeRuns(
      [
        { t: 16, score: 58, image: "slide.jpg" },
        { t: 41, score: 37, image: "inside-a-run.jpg" },
      ],
      0.25,
    );
    expect(cameraRunsToShow(faceless, scene, 12).map((run) => run.image)).toEqual(["slide.jpg", "turned-away.jpg", "blink.jpg"]);
  });

  it("keeps the scene changes when the cap cuts the list", () => {
    const scene = sceneChangeRuns([{ t: 16, score: 58, image: "slide.jpg" }], 0.25);
    expect(cameraRunsToShow(faceless, scene, 2).map((run) => run.image)).toEqual(["slide.jpg", "turned-away.jpg"]);
  });

  it("passes a clip with no faceless runs and no scene changes", () => {
    expect(cameraRunsToShow([], [], 12)).toEqual([]);
  });

  it("says a slide was found at a scene change", () => {
    const scene = sceneChangeRuns([{ t: 16, score: 58, image: "slide.jpg" }], 0.25);
    expect(decideCameraCheck(cameraRunsToShow(faceless, scene, 12), ["SLIDE", "PREACHER_OR_STAGE", "OTHER"])).toEqual({
      pass: false,
      reason: "slide",
      at: 16,
      via: "scene change",
    });
  });

  it("tells the model a slide fading in over the camera view is still a slide", () => {
    expect(cameraCheckPrompt(2)).toMatch(/fading in or out .* still a SLIDE/);
  });
});

describe("decideCameraCheck", () => {
  const runs = [
    { start: 4, end: 9, image: "a.jpg", via: "no face" as const },
    { start: 20, end: 21, image: "b.jpg", via: "no face" as const },
  ];

  it("rejects a clip when any run is a full-screen slide", () => {
    const result = decideCameraCheck(runs, ["PREACHER_OR_STAGE", "SLIDE"]);
    expect(result).toEqual({ pass: false, reason: "slide", at: 20, via: "no face" });
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

describe("fix AC: an empty stretch rejects the clip as off-screen", () => {
  // Samples every 0.25 s, as the sampler takes them; lab sermon 1q clip 4 had no face at 8.5 s and 8.75 s and nobody in either frame.
  const quarter = (faces: number[], start = 0): CameraSample[] =>
    faces.map((faceCount, i) => ({ t: start + i * 0.25, faceCount, image: faceCount === 0 ? `frame-${i}.jpg` : null }));
  const nobody = () => 0;

  it("only the faceless runs of half a second or more go to the person detector", () => {
    const runs = runsToDetectPeople(quarter([1, 0, 1, 0, 0, 1, 0, 0, 0, 1]));
    expect(runs.map((r) => [r.start, r.end])).toEqual([
      [0.75, 1.25],
      [1.5, 2.25],
    ]);
  });

  it("finds a run of faceless samples where nobody is seen, half a second or more", () => {
    expect(emptyRuns(quarter([1, 1, 0, 0, 1]), nobody)).toEqual([{ start: 0.5, end: 1 }]);
    expect(emptyRuns(quarter([1, 1, 0, 1]), nobody)).toEqual([]);
    // At the clip's end the last sample counts for one step.
    expect(emptyRuns(quarter([1, 1, 0, 0]), nobody)).toEqual([{ start: 0.5, end: 1 }]);
  });

  it("ends a run where someone is seen, or where the detector did not look", () => {
    // Faceless at 0.25 s to 1.0 s; someone is seen at 0.5 s, so only 0.75 s to 1.25 s is empty.
    const seen = (image: string) => (image === "frame-2.jpg" ? 1 : 0);
    expect(emptyRuns(quarter([1, 0, 0, 0, 0, 1]), seen)).toEqual([{ start: 0.75, end: 1.25 }]);
    expect(emptyRuns(quarter([1, 0, 0, 0, 0, 0, 1]), seen)).toEqual([{ start: 0.75, end: 1.5 }]);
    const unseen = (image: string) => (image === "frame-2.jpg" ? undefined : 0);
    expect(emptyRuns(quarter([1, 0, 0, 0, 1]), unseen)).toEqual([]);
  });

  it("rejects on the first empty stretch", () => {
    expect(decideEmptyFrames([])).toEqual({ pass: true });
    expect(decideEmptyFrames([{ start: 2833.64, end: 2834.14 }])).toEqual({ pass: false, reason: "off-screen", at: 2833.64, via: "no person" });
  });
});
