import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  YtDlpDownloadError,
  YtDlpFileTooLargeError,
  YtDlpParseError,
  downloadYtDlpVideo,
  fetchYtDlpMetadata,
  parseYtDlpMetadataJson,
} from "@/lib/media/ytdlp";

const originalYtDlpPath = process.env.YTDLP_PATH;

beforeAll(() => {
  // The exec fakes assert on the resolved binary name; a developer machine's YTDLP_PATH
  // override must not leak into those assertions.
  delete process.env.YTDLP_PATH;
});

afterAll(() => {
  if (originalYtDlpPath === undefined) delete process.env.YTDLP_PATH;
  else process.env.YTDLP_PATH = originalYtDlpPath;
});

function fixture(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "dQw4w9WgXcQ",
    title: "Sunday Morning Message",
    duration: 2730.5,
    thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    ...overrides,
  });
}

describe("parseYtDlpMetadataJson", () => {
  it("extracts video id, title, duration, and thumbnail", () => {
    const result = parseYtDlpMetadataJson(fixture());

    expect(result.videoId).toBe("dQw4w9WgXcQ");
    expect(result.title).toBe("Sunday Morning Message");
    expect(result.durationS).toBeCloseTo(2730.5, 3);
    expect(result.thumbnailUrl).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg");
  });

  it("defaults to an untitled title when missing or blank", () => {
    expect(parseYtDlpMetadataJson(fixture({ title: undefined })).title).toBe("Untitled video");
    expect(parseYtDlpMetadataJson(fixture({ title: "   " })).title).toBe("Untitled video");
  });

  it("defaults thumbnailUrl to null when absent", () => {
    expect(parseYtDlpMetadataJson(fixture({ thumbnail: undefined })).thumbnailUrl).toBeNull();
  });

  it("throws when the JSON is malformed", () => {
    expect(() => parseYtDlpMetadataJson("not json")).toThrow(YtDlpParseError);
  });

  it("throws when the video id is missing", () => {
    expect(() => parseYtDlpMetadataJson(fixture({ id: undefined }))).toThrow(YtDlpParseError);
  });

  it("throws when duration cannot be determined", () => {
    expect(() => parseYtDlpMetadataJson(fixture({ duration: undefined }))).toThrow(YtDlpParseError);
    expect(() => parseYtDlpMetadataJson(fixture({ duration: 0 }))).toThrow(YtDlpParseError);
    expect(() => parseYtDlpMetadataJson(fixture({ duration: -5 }))).toThrow(YtDlpParseError);
  });
});

describe("fetchYtDlpMetadata", () => {
  it("invokes yt-dlp with --dump-json --skip-download and parses stdout", async () => {
    const calls: Array<{ binary: string; args: string[]; options: { timeoutMs: number; maxBuffer?: number } }> = [];
    const fakeExec = async (
      binary: string,
      args: string[],
      options: { timeoutMs: number; maxBuffer?: number },
    ) => {
      calls.push({ binary, args, options });
      return { stdout: fixture(), stderr: "" };
    };

    const result = await fetchYtDlpMetadata("https://youtube.com/watch?v=dQw4w9WgXcQ", fakeExec);

    expect(result.videoId).toBe("dQw4w9WgXcQ");
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe("yt-dlp");
    expect(calls[0].args).toEqual(
      expect.arrayContaining(["--dump-json", "--skip-download", "--no-playlist", "https://youtube.com/watch?v=dQw4w9WgXcQ"]),
    );
    // Node's 1 MiB default kills yt-dlp on routine videos with large format/caption lists.
    expect(calls[0].options.maxBuffer).toBe(64 * 1024 * 1024);
  });

  it("propagates parse errors from malformed output", async () => {
    const fakeExec = async () => ({ stdout: "not json", stderr: "" });
    await expect(fetchYtDlpMetadata("https://example.com/x", fakeExec)).rejects.toThrow(YtDlpParseError);
  });
});

describe("downloadYtDlpVideo", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("invokes yt-dlp with a max-filesize cap and the destination path", async () => {
    const destPath = path.join(workDir, "exact", "source-video");
    const calls: Array<{ binary: string; args: string[] }> = [];
    const fakeExec = async (binary: string, args: string[]) => {
      calls.push({ binary, args });
      await writeFile(destPath, "video-bytes");
      return { stdout: "", stderr: "" };
    };

    await downloadYtDlpVideo(
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
      destPath,
      { maxBytes: 5 * 1024 * 1024 * 1024 },
      fakeExec,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe("yt-dlp");
    expect(calls[0].args).toEqual(
      expect.arrayContaining([
        "--merge-output-format",
        "mp4",
        "--max-filesize",
        String(5 * 1024 * 1024 * 1024),
        "--no-playlist",
        "-o",
        destPath,
        "https://youtube.com/watch?v=dQw4w9WgXcQ",
      ]),
    );
    await expect(stat(destPath)).resolves.toBeTruthy();
  });

  it("rejects and deletes a merged file that exceeds maxBytes (per-format cap can undercount)", async () => {
    const destPath = path.join(workDir, "oversized", "source-video");
    const fakeExec = async () => {
      await writeFile(destPath, Buffer.alloc(64));
      return { stdout: "", stderr: "" };
    };

    await expect(
      downloadYtDlpVideo("https://youtube.com/watch?v=big", destPath, { maxBytes: 32 }, fakeExec),
    ).rejects.toThrow(YtDlpFileTooLargeError);
    await expect(stat(destPath)).rejects.toThrow();
  });

  it("accepts a file exactly at maxBytes", async () => {
    const destPath = path.join(workDir, "at-limit", "source-video");
    const fakeExec = async () => {
      await writeFile(destPath, Buffer.alloc(32));
      return { stdout: "", stderr: "" };
    };

    await downloadYtDlpVideo("https://youtube.com/watch?v=ok", destPath, { maxBytes: 32 }, fakeExec);
    await expect(stat(destPath)).resolves.toBeTruthy();
  });

  it("renames an extension-suffixed output onto destPath (yt-dlp appends the container ext)", async () => {
    const destPath = path.join(workDir, "renamed", "source-video");
    const fakeExec = async () => {
      // Real yt-dlp appends the container extension when the -o template has none.
      await writeFile(`${destPath}.mp4`, "video-bytes");
      return { stdout: "", stderr: "" };
    };

    await downloadYtDlpVideo("https://youtube.com/watch?v=abc", destPath, { maxBytes: 1024 }, fakeExec);

    await expect(stat(destPath)).resolves.toBeTruthy();
    await expect(readdir(path.dirname(destPath))).resolves.toEqual(["source-video"]);
  });

  it("throws when yt-dlp exits successfully without producing a file (max-filesize skip)", async () => {
    const destPath = path.join(workDir, "skipped", "source-video");
    const fakeExec = async () => ({ stdout: "File is larger than max-filesize", stderr: "" });

    await expect(
      downloadYtDlpVideo("https://youtube.com/watch?v=abc", destPath, { maxBytes: 1024 }, fakeExec),
    ).rejects.toThrow(YtDlpDownloadError);
  });

  it("does not treat a leftover .part file as a finished download", async () => {
    const destPath = path.join(workDir, "partial", "source-video");
    const fakeExec = async () => {
      await writeFile(`${destPath}.mp4.part`, "incomplete");
      return { stdout: "", stderr: "" };
    };

    await expect(
      downloadYtDlpVideo("https://youtube.com/watch?v=abc", destPath, { maxBytes: 1024 }, fakeExec),
    ).rejects.toThrow(YtDlpDownloadError);
  });
});
