import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ytDlpPath as resolveYtDlpPath } from "@/lib/env";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";

export type YtDlpMetadata = {
  videoId: string;
  title: string;
  durationS: number;
  thumbnailUrl: string | null;
};

type YtDlpJson = {
  id?: string;
  title?: string;
  duration?: number;
  thumbnail?: string;
};

type ExecFile = (
  binaryPath: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export class YtDlpParseError extends Error {}

export class YtDlpDownloadError extends Error {}

/** The merged download landed over the byte cap — the file has already been deleted. */
export class YtDlpFileTooLargeError extends Error {}

/** Pure parser for `yt-dlp --dump-json --skip-download` output. */
export function parseYtDlpMetadataJson(raw: string): YtDlpMetadata {
  let parsed: YtDlpJson;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new YtDlpParseError("yt-dlp output was not valid JSON.");
  }

  if (!parsed.id) {
    throw new YtDlpParseError("yt-dlp output did not include a video id.");
  }

  const durationS = typeof parsed.duration === "number" ? parsed.duration : NaN;
  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw new YtDlpParseError("yt-dlp output did not include a usable duration.");
  }

  return {
    videoId: parsed.id,
    title: parsed.title?.trim() || "Untitled video",
    durationS,
    thumbnailUrl: parsed.thumbnail ?? null,
  };
}

/** Resolves metadata (duration, title) for a URL without downloading it, so limits can be checked first. */
export async function fetchYtDlpMetadata(
  url: string,
  execFile: ExecFile = execFileWithTimeout,
): Promise<YtDlpMetadata> {
  const ytDlpPath = resolveYtDlpPath();
  const { stdout } = await execFile(
    ytDlpPath,
    ["--dump-json", "--skip-download", "--no-playlist", url],
    {
      timeoutMs: envTimeoutMs("YTDLP_METADATA_TIMEOUT_MS", 30_000),
      // --dump-json routinely exceeds Node's 1 MiB default (large formats lists plus
      // auto-caption entries for ~150 languages) — same 64 MiB headroom as render.ts.
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return parseYtDlpMetadataJson(stdout);
}

/**
 * Downloads a single video so the file lands exactly at `destPath`, capped at `maxBytes`.
 *
 * Two real yt-dlp behaviors are normalized here so callers get a plain "file at destPath or
 * throw" contract: yt-dlp appends the container extension when the output template has none
 * (`destPath` -> `destPath.mp4`/`.webm`), and `--max-filesize` *skips* an oversized download
 * with exit code 0 rather than failing. Both cases are resolved after the subprocess exits:
 * an extension-suffixed file is renamed onto `destPath`, and a missing file throws
 * `YtDlpDownloadError` instead of silently succeeding.
 */
export async function downloadYtDlpVideo(
  url: string,
  destPath: string,
  opts: { maxBytes: number },
  execFile: ExecFile = execFileWithTimeout,
): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const ytDlpPath = resolveYtDlpPath();
  await execFile(
    ytDlpPath,
    [
      "-f",
      "bv*[height<=1080]+ba/b[height<=1080]",
      "--merge-output-format",
      "mp4",
      "--max-filesize",
      String(opts.maxBytes),
      "--no-playlist",
      "-o",
      destPath,
      url,
    ],
    { timeoutMs: envTimeoutMs("YTDLP_DOWNLOAD_TIMEOUT_MS", 20 * 60_000) },
  );
  await resolveDownloadedFile(destPath, opts.maxBytes);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function resolveDownloadedFile(destPath: string, maxBytes: number): Promise<void> {
  if (!(await fileExists(destPath))) {
    const dir = path.dirname(destPath);
    const prefix = `${path.basename(destPath)}.`;
    const entries = await readdir(dir).catch(() => [] as string[]);
    const produced = entries.find((entry) => entry.startsWith(prefix) && !entry.endsWith(".part"));
    if (!produced) {
      throw new YtDlpDownloadError(
        "yt-dlp did not produce a video file (the download may exceed the size cap or the URL may not be a downloadable video).",
      );
    }
    await rename(path.join(dir, produced), destPath);
  }

  // --max-filesize is checked per selected format, pre-merge, and skipped entirely for
  // formats with unknown size — so the merged output can still exceed the cap. The stat
  // here is the authoritative enforcement.
  const { size } = await stat(destPath);
  if (size > maxBytes) {
    await rm(destPath, { force: true });
    throw new YtDlpFileTooLargeError(
      `Downloaded video is ${size} bytes, over the ${maxBytes}-byte limit.`,
    );
  }
}
