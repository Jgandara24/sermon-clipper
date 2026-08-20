import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeScribeKeyterms,
  parseScribeResponse,
  readScribeKeyterms,
  requestScribe,
  scribePricePerMinuteUsd,
  ScribeTranscriptionProvider,
} from "@/lib/transcription/scribe-provider";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ScribeTranscriptionProvider", () => {
  it("uses base Scribe v2 without paid keyterms by default", async () => {
    const calls: unknown[] = [];
    const provider = new ScribeTranscriptionProvider({
      apiKey: "test-key",
      request: async (request) => {
        calls.push(request);
        return {
          language_code: "en",
          language_probability: 1,
          text: "Psalm 139 is clear.",
          words: [
            {
              text: "Psalm",
              start: 0.1,
              end: 0.42,
              type: "word",
              speaker_id: "speaker_0",
              logprob: -0.01,
            },
            {
              text: " ",
              start: 0.42,
              end: 0.48,
              type: "spacing",
              speaker_id: "speaker_0",
              logprob: 0,
            },
            {
              text: "139",
              start: 0.48,
              end: 0.8,
              type: "word",
              speaker_id: "speaker_0",
              logprob: -0.02,
            },
            {
              text: "is",
              start: 0.86,
              end: 0.96,
              type: "word",
              speaker_id: "speaker_0",
              logprob: -0.01,
            },
            {
              text: "clear.",
              start: 1,
              end: 1.3,
              type: "word",
              speaker_id: "speaker_0",
              logprob: -0.01,
            },
          ],
        };
      },
    });

    const result = await provider.transcribe({ audioPath: "/tmp/sermon.flac", language: "en" });

    expect(calls).toEqual([
      expect.objectContaining({
        apiKey: "test-key",
        audioPath: "/tmp/sermon.flac",
        language: "en",
        keyterms: [],
      }),
    ]);
    expect(result.language).toBe("en");
    expect(result.segments.flatMap((segment) => segment.words).map((word) => word.word)).toEqual([
      "Psalm",
      "139",
      "is",
      "clear.",
    ]);
  });

  it("matches the benchmark request and lets Scribe detect the speaker count", async () => {
    const forms: FormData[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        forms.push(init?.body as FormData);
        return new Response(
          JSON.stringify({
            language_code: "en",
            text: "Amen.",
            words: [{ text: "Amen.", start: 0, end: 0.3, type: "word" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await requestScribe({
      apiKey: "test-key",
      audioPath: path.resolve("tests/scribe-provider.test.ts"),
      language: "en",
      keyterms: [],
    });

    const form = forms[0];
    expect(form?.get("model_id")).toBe("scribe_v2");
    expect(form?.get("diarize")).toBe("true");
    expect(form?.get("tag_audio_events")).toBe("true");
    expect(form?.get("no_verbatim")).toBe("false");
    expect(form?.get("num_speakers")).toBeNull();
    expect(form?.getAll("keyterms")).toEqual([]);
  });

  it("sends only normalized church-specific keyterms when they are supplied", async () => {
    let receivedKeyterms: string[] = [];
    const provider = new ScribeTranscriptionProvider({
      apiKey: "test-key",
      request: async (request) => {
        receivedKeyterms = request.keyterms;
        return {
          language_code: "en",
          text: "Pastor Rivera.",
          words: [
            {
              text: "Pastor",
              start: 0,
              end: 0.2,
              type: "word",
              speaker_id: "speaker_0",
              logprob: 0,
            },
            {
              text: "Rivera.",
              start: 0.22,
              end: 0.5,
              type: "word",
              speaker_id: "speaker_0",
              logprob: 0,
            },
          ],
        };
      },
    });

    await provider.transcribe({
      audioPath: "/tmp/sermon.flac",
      keyterms: ["  Pastor Rivera ", "Grace Church", "pastor rivera", "", "one two three four five six"],
    });

    expect(receivedKeyterms).toEqual(["Pastor Rivera", "Grace Church"]);
  });

  it("builds speaker-aware sentence segments and removes active-word overlaps", () => {
    const result = parseScribeResponse({
      language_code: "en",
      text: "Hello world. Welcome back.",
      words: [
        {
          text: "Hello",
          start: 0.1,
          end: 0.5,
          type: "word",
          speaker_id: "speaker_0",
          logprob: -0.1,
        },
        {
          text: "world.",
          start: 0.48,
          end: 0.8,
          type: "word",
          speaker_id: "speaker_0",
          logprob: -0.2,
        },
        {
          text: "[applause]",
          start: 0.9,
          end: 1.3,
          type: "audio_event",
          speaker_id: "speaker_1",
          logprob: 0,
        },
        {
          text: "Welcome",
          start: 1.5,
          end: 1.8,
          type: "word",
          speaker_id: "speaker_1",
          logprob: -0.1,
        },
        {
          text: "back.",
          start: 1.82,
          end: 2.1,
          type: "word",
          speaker_id: "speaker_1",
          logprob: -0.1,
        },
      ],
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({
      text: "Hello world.",
      speakerLabel: "speaker_0",
      startMs: 100,
      endMs: 800,
    });
    expect(result.segments[0].words[0].endMs).toBe(480);
    expect(result.segments[1]).toMatchObject({
      text: "Welcome back.",
      speakerLabel: "speaker_1",
      startMs: 1500,
      endMs: 2100,
    });
    expect(result.segments.flatMap((segment) => segment.words).map((word) => word.word)).not.toContain(
      "[applause]",
    );
  });

  it("rejects a successful API response that contains no spoken words", () => {
    expect(() =>
      parseScribeResponse({
        language_code: "en",
        text: "[music]",
        words: [
          {
            text: "[music]",
            start: 0,
            end: 3,
            type: "audio_event",
            logprob: 0,
          },
        ],
      }),
    ).toThrow("no spoken words");
  });

  it("keeps project keyterms opt-in instead of charging every sermon", () => {
    expect(readScribeKeyterms({ genre: "sermon" })).toEqual([]);
    expect(
      readScribeKeyterms({
        transcriptionKeyterms: ["  Pastor Rivera ", "Grace Church", "pastor rivera"],
      }),
    ).toEqual(["Pastor Rivera", "Grace Church"]);
  });

  it("removes keyterms with characters that the Scribe API rejects", () => {
    expect(
      normalizeScribeKeyterms(["Pastor Rivera", "Grace [Downtown]", "John \\ Calvin", "Mozi"]),
    ).toEqual(["Pastor Rivera", "Mozi"]);
  });

  it("prices base Scribe separately from the optional keyterm surcharge", () => {
    expect(scribePricePerMinuteUsd(false, 0.22, 0.05)).toBeCloseTo(0.22 / 60, 8);
    expect(scribePricePerMinuteUsd(true, 0.22, 0.05)).toBeCloseTo(0.27 / 60, 8);
  });

  it("gives a final zero-duration word a visible caption interval", () => {
    const result = parseScribeResponse({
      language_code: "en",
      text: "Amen.",
      words: [
        {
          text: "Amen.",
          start: 2,
          end: 2,
          type: "word",
          speaker_id: "speaker_0",
          logprob: 0,
        },
      ],
    });

    expect(result.segments[0].words[0]).toMatchObject({ startMs: 2000, endMs: 2080 });
  });

  it("distributes a same-time word group across the next available interval", () => {
    const result = parseScribeResponse({
      language_code: "en",
      text: "Holy fear. Amen.",
      words: [
        {
          text: "Holy",
          start: 2,
          end: 2,
          type: "word",
          speaker_id: "speaker_0",
          logprob: 0,
        },
        {
          text: "fear.",
          start: 2,
          end: 2,
          type: "word",
          speaker_id: "speaker_0",
          logprob: 0,
        },
        {
          text: "Amen.",
          start: 2.2,
          end: 2.4,
          type: "word",
          speaker_id: "speaker_0",
          logprob: 0,
        },
      ],
    });
    const words = result.segments.flatMap((segment) => segment.words);

    expect(words.slice(0, 2)).toMatchObject([
      { word: "Holy", startMs: 2000, endMs: 2100 },
      { word: "fear.", startMs: 2100, endMs: 2200 },
    ]);
  });
});
