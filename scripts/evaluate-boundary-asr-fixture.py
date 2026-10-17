#!/usr/bin/env python3
"""Verify pinned whisper weights and measure one synthetic boundary window without production activation."""
import argparse
import hashlib
import json
import math
import platform
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def download(url, limit):
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Download exceeded its byte limit.")
    return data


def run(args, timeout=120):
    return subprocess.run(args, check=True, timeout=timeout, capture_output=True, text=True, cwd=ROOT)


def evaluate(output):
    if platform.system() != "Darwin":
        raise ValueError("This experiment requires macOS speech synthesis and native resource measurements.")
    for binary in ["say", "ffmpeg", "ffprobe", "whisper-cli", "npx"]:
        if not shutil.which(binary):
            raise ValueError(f"Required tool is missing: {binary}")
    candidate = next(row for row in json.loads((ROOT / "evaluation/p4-model-candidates-2026-10-16.json").read_text())["candidates"]
                     if row["candidateId"] == "whisper-base-en-boundary")
    if candidate["licenseReview"] != "PERMISSIVE_LICENSE_EVIDENCE_FOUND":
        raise ValueError("The candidate lacks reviewed license evidence.")
    output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="p4-boundary-evaluation-") as temporary:
        temporary = Path(temporary)
        models = temporary / "models"
        models.mkdir()
        scratch = temporary / "scratch"
        scratch.mkdir()
        licenses = {}
        for url_key, hash_key in [("licenseEvidenceUrl", "licenseFileSha256"), ("weightsLicenseScopeUrl", "readmeSha256"),
                                  ("weightsLicenseUrl", "weightsLicenseFileSha256"), ("pointerUrl", "pointerSha256"),
                                  ("modelCardUrl", "modelCardSha256")]:
            digest = sha(download(candidate[url_key], 1048576))
            if digest != candidate[hash_key]:
                raise ValueError("Pinned license or pointer evidence changed.")
            licenses[hash_key] = digest
        weights = download(candidate["sourceUrl"], candidate["expectedByteCount"])
        if len(weights) != candidate["expectedByteCount"] or sha(weights) != candidate["expectedSha256"]:
            raise ValueError("Model bytes differ from the pinned checksum or size.")
        model = models / "ggml-base.en.bin"
        model.write_bytes(weights)
        del weights
        descriptor = {"modelId": candidate["candidateId"], "version": candidate["upstreamRevision"], "roles": ["BOUNDARY_ASR"],
            "relativePath": model.name, "sha256": candidate["expectedSha256"], "byteCount": candidate["expectedByteCount"],
            "upstreamRevision": candidate["upstreamRevision"], "sourceUrl": candidate["sourceUrl"],
            "license": {"spdx": "MIT", "codeEvidenceUrl": candidate["licenseEvidenceUrl"],
                "weightsEvidenceUrl": candidate["weightsLicenseScopeUrl"], "reviewStatus": "REVIEWED_FOR_EVALUATION",
                "reviewReference": "evaluation/p4-model-candidates-2026-10-16.json#whisper-base-en-boundary"},
            "productionApproval": {"approved": False, "evaluationEvidenceSha256": None, "decisionReference": None}}
        descriptor_path = output / "model-descriptor.json"
        descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n")
        expected = "This is a local boundary sampling test."
        speech = temporary / "speech.aiff"
        # Use an installed voice. This command does not request a voice download.
        run(["say", "-v", "Samantha", "-r", "140", "-o", str(speech), expected])
        speech_audio = temporary / "speech.flac"
        run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(speech), "-ac", "1", "-ar", "16000", "-c:a", "flac", str(speech_audio)])
        facts = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(speech_audio)]).stdout)["streams"][0]
        speech_ms = math.ceil(facts["duration_ts"] / 16)
        total_ms = speech_ms + 4000
        audio = output / "analysis.flac"
        run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(speech_audio), "-af",
            f"adelay=2000:all=1,apad,atrim=end_sample={total_ms * 16},asetpts=PTS-STARTPTS", "-c:a", "flac", "-threads", "1", str(audio)])
        adapter = '''import { readFileSync } from "node:fs";
import { fileIdentity } from "./src/lib/storage/file-identity.ts";
import { sampleAmbiguousBoundaries } from "./src/lib/media/boundary-asr.ts";
(async () => {
  const model = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const identity = await fileIdentity(process.argv[3]);
  const duration = Number(process.argv[6]);
  const input = {path: process.argv[3], ...identity, sourceInterval: {startMs: 60000, endMs: 60000 + duration}};
  const plan = {sourceVideoId: "11111111-1111-4111-8111-111111111111", sourceSha256: identity.sha256,
    corridor: {startMs: 62000, endMs: 60000 + duration - 2000}, maxWindowMs: duration - 2000, maxTotalMs: duration - 2000,
    windows: [{edge: "START", state: "AMBIGUOUS", sourceInterval: {startMs: 61000, endMs: 60000 + duration - 1000},
      evidenceSha256: identity.sha256}]};
  const result = await sampleAmbiguousBoundaries(input, plan,
    {binaryPath: process.argv[4], modelRoot: process.argv[2], usage: "evaluation", model, language: "en", threads: 2,
      timeoutMs: 60000, maxOutputBytes: 1048576,
      extraction: {threads: 1, flacCompressionLevel: 5, timeoutMs: 30000, maxMetadataBytes: 1048576, maxFileBytes: 1048576}},
    process.argv[5]);
  process.stdout.write(JSON.stringify(result));
})().catch(error => { console.error(error.message); process.exitCode = 1; });'''
        timing = temporary / "time.txt"
        started = time.monotonic()
        completed = run(["/usr/bin/time", "-l", "-o", str(timing), "npx", "tsx", "-e", adapter,
            str(descriptor_path), str(models), str(audio), shutil.which("whisper-cli"), str(scratch), str(total_ms)])
        wall_ms = (time.monotonic() - started) * 1000
        result = json.loads(completed.stdout)
        (output / "boundary-asr.json").write_text(json.dumps(result, indent=2) + "\n")
        timing_text = timing.read_text()
        cpu = re.search(r"([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys", timing_text)
        rss = re.search(r"(\d+)\s+maximum resident set size", timing_text)
        if not cpu or not rss:
            raise ValueError("Native resource measurements are unavailable.")
        recognized = " ".join(segment["text"] for item in result["results"] for segment in item["segments"])
        normalized = lambda text: re.findall(r"[a-z0-9]+", text.lower())
        report = {"version": "p4-boundary-synthetic-fixture-v1", "scope": "ONE_SYNTHETIC_SPEECH_WINDOW_ONLY",
            "model": result["model"], "licenseEvidence": licenses,
            "fixture": {"kind": "synthetic-audio-only", "voice": "Samantha", "speechRate": 140,
                "audioSha256": sha(audio.read_bytes()), "durationMs": total_ms,
                "expectedText": expected, "recognizedText": recognized,
                "normalizedExactMatch": normalized(expected) == normalized(recognized),
                "sourceOffsetMs": 61000, "sampledDurationMs": total_ms - 2000},
            "adapterEvidenceSha256": result["evidenceSha256"],
            "runtime": {"platform": platform.platform(), "machine": platform.machine(),
                "whisperVersion": run(["whisper-cli", "--version"]).stdout.strip(), "threads": 2,
                "measurementScope": "whole-adapter-process-tree-including-node-and-media-tools",
                "wallTimeMs": wall_ms, "nativeRealSeconds": float(cpu[1]), "userCpuSeconds": float(cpu[2]),
                "systemCpuSeconds": float(cpu[3]), "peakResidentBytes": int(rss[1]),
                "binarySha256": result["binarySha256"]},
            "temporaryOutputsRemoved": not any(scratch.iterdir()), "modelBytesRetained": False,
            "representativeQuality": "NOT_MEASURED", "boundaryRecall": None, "productionApproved": False}
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output / "report.json"), "exactFixtureMatch": report["fixture"]["normalizedExactMatch"],
        "productionApproved": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New output directory; existing directories are rejected.")
    evaluate(parser.parse_args().output.resolve())
