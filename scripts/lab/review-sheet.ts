/**
 * Phase 1 lab, Step 1: the review sheet (docs/PHASE1_LAB_PLAN.md).
 *
 *   npm run lab:review -- --project <projectId> [--count 6] [--port 4545] [--export-timeout-min 30]
 *
 * For the first picks of one project it makes sure a captioned MP4 export exists (through the
 * normal export queue, rendered by the lab worker), waits for the renders, then serves one page
 * on localhost: each clip's video, start and end, the words with a little context, and
 * Pass / Fail buttons. Marks are saved to evaluation/lab-labels/<projectId>.json.
 *
 * Reads the lab database only. Publishes nothing. Changes no clip.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { PrismaClient, ProcessingJobState } from "@prisma/client";
import { RETAINED_CLIP_STATUSES } from "@/lib/analysis/clip-status";
import { buildDefaultExportFilename } from "@/lib/export/filename";
import { DEFAULT_EDIT_VERSION } from "@/lib/exports/edit-version";
import { enqueueExportJob } from "@/lib/exports/queue";
import type { TranscriptWord } from "@/lib/transcription/types";
import {
  assertLabEnvironment,
  formatClock,
  LabEnvironmentError,
  readArgs,
  sleep,
} from "./lab-guard";

const QUALITY_TESTS: Record<number, string> = {
  1: "Starts or ends at the wrong time",
  2: "Not the preacher preaching (announcements, altar call, worship, prayer, baptism)",
  3: "The video shows a slide, song words, or a logo instead of the preacher",
  4: "Not engaging",
};

type ClipLabel = {
  rank: number;
  startMs: number;
  endMs: number;
  verdict: "pass" | "fail";
  failedTests: number[];
  note: string;
  labeledAt: string;
};

type LabelFile = {
  projectId: string;
  projectName: string;
  sourceUrl: string | null;
  judge: string;
  clips: Record<string, ClipLabel>;
};

type SheetClip = {
  id: string;
  rank: number;
  startMs: number;
  endMs: number;
  title: string;
  summary: string;
  modelVersion: string | null;
  exportState: string;
  exportError: string | null;
  exportJobId: string | null;
  videoPath: string | null;
  before: string[];
  words: string[];
  after: string[];
};

async function main() {
  const args = readArgs(process.argv.slice(2));
  const projectId = args.get("project");
  if (typeof projectId !== "string") {
    console.error("Usage: npm run lab:review -- --project <projectId> [--count 6] [--port 4545]");
    process.exit(2);
  }
  const count = typeof args.get("count") === "string" ? Number(args.get("count")) : 6;
  const port = typeof args.get("port") === "string" ? Number(args.get("port")) : 4545;
  const exportTimeoutMs =
    (typeof args.get("export-timeout-min") === "string" ? Number(args.get("export-timeout-min")) : 30) * 60_000;

  assertLabEnvironment({ requireAnthropicKey: false });
  const storageRoot = path.resolve(process.env.STORAGE_LOCAL_ROOT ?? ".data/storage");

  const prisma = new PrismaClient();
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        sourceVideo: { include: { transcript: { include: { segments: { orderBy: { idx: "asc" } } } } } },
      },
    });
    if (!project) throw new LabEnvironmentError(`Project ${projectId} was not found in the lab database.`);
    if (!project.sourceVideo?.transcript) {
      throw new LabEnvironmentError("This project has no transcript yet. Wait for the run to finish (npm run lab:run -- --watch <id>).");
    }

    const clips = await prisma.generatedClip.findMany({
      where: { projectId, status: { in: [...RETAINED_CLIP_STATUSES] } },
      orderBy: { rank: "asc" },
      include: { score: true, edits: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (clips.length === 0) throw new LabEnvironmentError("This project has no kept clips. Did ANALYZE finish?");
    const firstPicks = clips.slice(0, count);
    const reserves = clips.slice(count);

    // 1. Make sure every first pick has an export job. Same identity rule as the app (clip + edit version).
    const jobIds = new Map<string, string>();
    for (const clip of firstPicks) {
      const editVersion = clip.edits[0]?.version ?? DEFAULT_EDIT_VERSION;
      const job = await enqueueExportJob(prisma, {
        clipId: clip.id,
        workspaceId: clip.workspaceId,
        filename: buildDefaultExportFilename({
          seriesOrProject: project.series ?? project.name,
          clipTitle: clip.title,
          date: new Date(),
        }),
        editVersion,
        priority: 1,
      });
      jobIds.set(clip.id, job.id);
    }

    // 2. Wait for the lab worker to render them.
    console.log(`Waiting for ${firstPicks.length} exports. The lab worker renders them (npm run lab:worker).`);
    const startedAt = Date.now();
    let lastReport = "";
    while (Date.now() - startedAt < exportTimeoutMs) {
      const jobs = await prisma.exportJob.findMany({ where: { id: { in: [...jobIds.values()] } } });
      const done = jobs.filter((job) => job.state === ProcessingJobState.SUCCEEDED).length;
      const failed = jobs.filter((job) => job.state === ProcessingJobState.FAILED && job.attempt >= job.maxAttempts).length;
      const report = `${done} rendered, ${failed} failed, ${jobs.length - done - failed} waiting`;
      if (report !== lastReport) {
        console.log(`${new Date().toLocaleTimeString()}  ${report}`);
        lastReport = report;
      }
      if (done + failed === jobs.length) break;
      await sleep(3_000);
    }

    // 3. Build the sheet.
    const words = flattenWords(project.sourceVideo.transcript.segments);
    const sheetClips: SheetClip[] = [];
    for (const clip of firstPicks) {
      const job = await prisma.exportJob.findUnique({
        where: { id: jobIds.get(clip.id)! },
        include: { outputFile: true },
      });
      const text = wordsForRange(words, clip.startMs, clip.endMs);
      sheetClips.push({
        id: clip.id,
        rank: clip.rank,
        startMs: clip.startMs,
        endMs: clip.endMs,
        title: clip.title,
        summary: clip.summary,
        modelVersion: clip.score?.modelVersion ?? null,
        exportState: job?.state ?? "MISSING",
        exportError: job?.errorMessageUser ?? null,
        exportJobId: job?.id ?? null,
        videoPath: job?.outputFile ? path.join(storageRoot, job.outputFile.storageKey) : null,
        ...text,
      });
    }

    const labelsPath = path.resolve("evaluation/lab-labels", `${projectId}.json`);
    await mkdir(path.dirname(labelsPath), { recursive: true });
    let labels: LabelFile = {
      projectId,
      projectName: project.name,
      sourceUrl: project.sourceVideo.originUrl,
      judge: "jake",
      clips: {},
    };
    try {
      labels = JSON.parse(await readFile(labelsPath, "utf8")) as LabelFile;
    } catch {
      // first visit: no labels yet
    }

    const header = {
      name: project.name,
      sourceUrl: project.sourceVideo.originUrl,
      durationMs: project.sourceVideo.durationS ? Number(project.sourceVideo.durationS) * 1000 : null,
      pickers: [...new Set(clips.map((clip) => clip.score?.modelVersion ?? "no score"))],
      keptCount: clips.length,
      reserves: reserves.map((clip) => ({ rank: clip.rank, startMs: clip.startMs, endMs: clip.endMs, title: clip.title })),
    };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(renderPage(header, sheetClips, labels));
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/media/")) {
          const clip = sheetClips.find((c) => c.exportJobId === url.pathname.slice("/media/".length));
          if (!clip?.videoPath) {
            res.writeHead(404);
            res.end("no video");
            return;
          }
          await streamVideo(clip.videoPath, req, res);
          return;
        }
        if (req.method === "GET" && url.pathname === "/labels") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(labels, null, 2));
          return;
        }
        if (req.method === "POST" && url.pathname === "/label") {
          const body = JSON.parse(await readBody(req)) as {
            clipId: string;
            verdict: "pass" | "fail";
            failedTests?: number[];
            note?: string;
          };
          const clip = sheetClips.find((c) => c.id === body.clipId);
          if (!clip || (body.verdict !== "pass" && body.verdict !== "fail")) {
            res.writeHead(400);
            res.end("bad label");
            return;
          }
          labels.clips[clip.id] = {
            rank: clip.rank,
            startMs: clip.startMs,
            endMs: clip.endMs,
            verdict: body.verdict,
            failedTests: body.verdict === "fail" ? (body.failedTests ?? []).filter((n) => QUALITY_TESTS[n]) : [],
            note: (body.note ?? "").slice(0, 2000),
            labeledAt: new Date().toISOString(),
          };
          await writeFile(labelsPath, JSON.stringify(labels, null, 2) + "\n");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, saved: Object.keys(labels.clips).length }));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      } catch (error) {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : "error");
      }
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`\nReview sheet: http://localhost:${port}/`);
      console.log(`Marks save to: ${labelsPath}`);
      console.log("Press Ctrl+C when you are done.");
    });
    await new Promise(() => {
      /* serve until Ctrl+C */
    });
  } finally {
    await prisma.$disconnect();
  }
}

type FlatWord = { word: string; startMs: number; endMs: number };

function flattenWords(segments: { startMs: number; endMs: number; text: string; words: unknown }[]): FlatWord[] {
  const out: FlatWord[] = [];
  for (const segment of segments) {
    const words = Array.isArray(segment.words) ? (segment.words as TranscriptWord[]) : [];
    const usable = words.filter((w) => w && typeof w.word === "string" && Number.isFinite(w.startMs) && Number.isFinite(w.endMs));
    if (usable.length > 0) {
      for (const w of usable) out.push({ word: w.word, startMs: w.startMs, endMs: w.endMs });
    } else {
      // No word times: treat the whole segment as one unit so the sheet still shows text.
      out.push({ word: segment.text, startMs: segment.startMs, endMs: segment.endMs });
    }
  }
  return out;
}

function wordsForRange(all: FlatWord[], startMs: number, endMs: number, context = 8) {
  const firstIdx = all.findIndex((w) => w.endMs > startMs);
  let lastIdx = -1;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].startMs < endMs) {
      lastIdx = i;
      break;
    }
  }
  if (firstIdx === -1 || lastIdx < firstIdx) return { before: [], words: [], after: [] };
  return {
    before: all.slice(Math.max(0, firstIdx - context), firstIdx).map((w) => w.word),
    words: all.slice(firstIdx, lastIdx + 1).map((w) => w.word),
    after: all.slice(lastIdx + 1, lastIdx + 1 + context).map((w) => w.word),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 100_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function streamVideo(filePath: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const info = await stat(filePath);
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    res.writeHead(206, {
      "content-type": "video/mp4",
      "content-range": `bytes ${start}-${end}/${info.size}`,
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": "video/mp4", "content-length": info.size, "accept-ranges": "bytes" });
  createReadStream(filePath).pipe(res);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderPage(
  header: {
    name: string;
    sourceUrl: string | null;
    durationMs: number | null;
    pickers: string[];
    keptCount: number;
    reserves: { rank: number; startMs: number; endMs: number; title: string }[];
  },
  clips: SheetClip[],
  labels: LabelFile,
): string {
  const passed = clips.filter((c) => labels.clips[c.id]?.verdict === "pass").length;
  const failed = clips.filter((c) => labels.clips[c.id]?.verdict === "fail").length;
  const cards = clips
    .map((clip) => {
      const label = labels.clips[clip.id];
      const video = clip.videoPath
        ? `<video controls preload="metadata" src="/media/${clip.exportJobId}"></video>`
        : `<div class="novideo">No video yet. Export state: ${escapeHtml(clip.exportState)}${
            clip.exportError ? ` — ${escapeHtml(clip.exportError)}` : ""
          }</div>`;
      const tests = Object.entries(QUALITY_TESTS)
        .map(
          ([n, text]) =>
            `<label class="test"><input type="checkbox" name="test" value="${n}" ${
              label?.failedTests.includes(Number(n)) ? "checked" : ""
            }> <b>Test ${n}.</b> ${escapeHtml(text)}</label>`,
        )
        .join("");
      return `
<section class="card" data-clip="${clip.id}">
  <div class="head">
    <span class="rank">Clip ${clip.rank}</span>
    <span class="time">${formatClock(clip.startMs)} → ${formatClock(clip.endMs)} &nbsp;(${formatClock(clip.endMs - clip.startMs)})</span>
    <span class="verdict ${label?.verdict ?? ""}">${label ? (label.verdict === "pass" ? "PASS" : "FAIL") : "not marked"}</span>
  </div>
  <h2>${escapeHtml(clip.title)}</h2>
  ${video}
  <p class="words"><span class="ctx">${escapeHtml(clip.before.join(" "))}</span> <span class="in">${escapeHtml(
    clip.words.join(" "),
  )}</span> <span class="ctx">${escapeHtml(clip.after.join(" "))}</span></p>
  <p class="summary">${escapeHtml(clip.summary)}</p>
  <div class="mark">
    <button class="pass" type="button">Pass</button>
    <button class="fail" type="button">Fail</button>
    <div class="failbox" ${label?.verdict === "fail" ? "" : "hidden"}>
      <p>Which test did it fail? Tick every one that applies.</p>
      ${tests}
      <textarea name="note" placeholder="Optional note. For example: starts two words late.">${escapeHtml(label?.note ?? "")}</textarea>
      <button class="save" type="button">Save fail</button>
    </div>
    <span class="saved"></span>
  </div>
</section>`;
    })
    .join("\n");

  const reserves = header.reserves
    .map((r) => `<li>Clip ${r.rank} — ${formatClock(r.startMs)} → ${formatClock(r.endMs)} — ${escapeHtml(r.title)}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lab review — ${escapeHtml(header.name)}</title>
<style>
  :root { color-scheme: light dark; --ok:#1b7f3b; --bad:#b3261e; --muted:#777; }
  body { font: 16px/1.45 -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; max-width: 900px; margin-inline: auto; }
  header { margin-bottom: 20px; }
  header .meta { color: var(--muted); font-size: 14px; }
  .score { font-size: 20px; font-weight: 600; margin: 8px 0; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 16px; margin: 16px 0; }
  .head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  .rank { font-weight: 700; font-size: 18px; }
  .time { color: var(--muted); font-variant-numeric: tabular-nums; }
  .verdict { margin-left: auto; font-weight: 700; color: var(--muted); }
  .verdict.pass { color: var(--ok); } .verdict.fail { color: var(--bad); }
  h2 { font-size: 18px; margin: 8px 0; }
  video { width: 100%; max-height: 70vh; background: #000; border-radius: 8px; }
  .novideo { padding: 24px; background: #8882; border-radius: 8px; color: var(--muted); }
  .words { margin: 12px 0; } .ctx { color: var(--muted); } .in { font-weight: 500; }
  .summary { color: var(--muted); font-size: 14px; }
  .mark { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid #8886; cursor: pointer; background: #8881; }
  button.pass { border-color: var(--ok); color: var(--ok); } button.fail { border-color: var(--bad); color: var(--bad); }
  .failbox { flex-basis: 100%; border-top: 1px solid #8884; padding-top: 10px; }
  .test { display: block; margin: 6px 0; }
  textarea { width: 100%; min-height: 60px; font: inherit; margin: 8px 0; border-radius: 8px; border: 1px solid #8886; padding: 8px; }
  .saved { color: var(--muted); font-size: 14px; }
  details { margin-top: 24px; color: var(--muted); } details li { margin: 4px 0; }
</style></head>
<body>
<header>
  <h1>${escapeHtml(header.name)}</h1>
  <div class="meta">
    ${header.sourceUrl ? `<a href="${escapeHtml(header.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(header.sourceUrl)}</a><br>` : ""}
    Sermon length: ${header.durationMs ? formatClock(header.durationMs) : "unknown"} · Picker: ${escapeHtml(header.pickers.join(", "))} · ${header.keptCount} clips kept, ${clips.length} first picks shown
  </div>
  <div class="score" id="score">${passed} pass · ${failed} fail · ${clips.length - passed - failed} not marked</div>
  <p>Watch each clip. Press <b>Pass</b> if it passes all four tests. Press <b>Fail</b> and tick the test it failed. Marks save at once.</p>
</header>
${cards}
<details><summary>Reserves (${header.reserves.length}) — not shown as video</summary><ul>${reserves}</ul></details>
<script>
  const total = ${clips.length};
  async function send(card, verdict) {
    const clipId = card.dataset.clip;
    const failedTests = [...card.querySelectorAll('input[name=test]:checked')].map(i => Number(i.value));
    const note = card.querySelector('textarea[name=note]').value;
    const res = await fetch('/label', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clipId, verdict, failedTests, note }) });
    const ok = res.ok;
    card.querySelector('.saved').textContent = ok
      ? 'Saved ' + new Date().toLocaleTimeString()
      : (res.status === 400 ? 'Not saved: this page is out of date. Reload the page (Cmd+R), then mark again.' : 'Not saved — try again');
    if (!ok) return;
    const v = card.querySelector('.verdict'); v.className = 'verdict ' + verdict; v.textContent = verdict.toUpperCase();
    const cards = [...document.querySelectorAll('.card')];
    const pass = cards.filter(c => c.querySelector('.verdict').classList.contains('pass')).length;
    const fail = cards.filter(c => c.querySelector('.verdict').classList.contains('fail')).length;
    document.getElementById('score').textContent = pass + ' pass · ' + fail + ' fail · ' + (total - pass - fail) + ' not marked';
  }
  document.querySelectorAll('.card').forEach(card => {
    card.querySelector('button.pass').onclick = () => { card.querySelector('.failbox').hidden = true; send(card, 'pass'); };
    card.querySelector('button.fail').onclick = () => { card.querySelector('.failbox').hidden = false; };
    card.querySelector('button.save').onclick = () => send(card, 'fail');
  });
</script>
</body></html>`;
}

main().catch((error) => {
  if (error instanceof LabEnvironmentError) {
    console.error(`\nStopped: ${error.message}`);
    process.exit(1);
  }
  throw error;
});
