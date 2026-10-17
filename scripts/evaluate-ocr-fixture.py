#!/usr/bin/env python3
"""Verify pinned OCR weights and measure one synthetic frame. Never activates a production model."""
import argparse
import hashlib
import json
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
        raise ValueError("Download exceeded the evidence byte limit.")
    return data


def raw_url(url):
    match = re.fullmatch(r"https://github.com/([^/]+)/([^/]+)/blob/([0-9a-f]{40})/(.+)", url)
    if not match:
        raise ValueError("A pinned GitHub blob URL is required.")
    return "https://raw.githubusercontent.com/" + "/".join(match.groups())


def run(args, **options):
    return subprocess.run(args, check=True, timeout=60, capture_output=True, text=True, cwd=ROOT, **options)


def evaluate(output, sparse=False):
    if platform.system() != "Darwin":
        raise ValueError("This experiment requires macOS /usr/bin/time -l measurements.")
    for binary in ["tesseract", "ffmpeg", "npx"]:
        if not shutil.which(binary):
            raise ValueError(f"Required tool is missing: {binary}")
    font = Path("/System/Library/Fonts/SFNS.ttf")
    if not font.is_file():
        raise ValueError("The experiment font is missing.")
    manifest = json.loads((ROOT / "evaluation/p4-model-candidates-2026-10-16.json").read_text())
    candidate = next(row for row in manifest["candidates"] if row["candidateId"] == "tesseract-eng-fast")
    if candidate["licenseReview"] != "PERMISSIVE_LICENSE_EVIDENCE_FOUND":
        raise ValueError("The candidate lacks prior license review evidence.")
    output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="p4-ocr-evaluation-") as temporary:
        models = Path(temporary) / "models"
        models.mkdir()
        checked = {}
        for url_field, hash_field in [("licenseEvidenceUrl", "licenseFileSha256"), ("weightsLicenseScopeUrl", "readmeSha256")]:
            digest = sha(download(raw_url(candidate[url_field]), 1024 * 1024))
            if digest != candidate[hash_field]:
                raise ValueError("License evidence changed from the reviewed pinned bytes.")
            checked[hash_field] = digest
        weights = download(raw_url(candidate["sourceUrl"]), candidate["expectedByteCount"])
        blob = hashlib.sha1(f"blob {len(weights)}\0".encode() + weights).hexdigest()
        if len(weights) != candidate["expectedByteCount"] or blob != candidate["gitBlobSha1"]:
            raise ValueError("Downloaded model does not match the pinned Git blob.")
        model_sha = sha(weights)
        if candidate["expectedSha256"] and model_sha != candidate["expectedSha256"]:
            raise ValueError("Downloaded model does not match the established SHA-256 checksum.")
        (models / "eng.traineddata").write_bytes(weights)
        descriptor = {"modelId": candidate["candidateId"], "version": candidate["upstreamRevision"], "roles": ["OCR"],
            "relativePath": "eng.traineddata", "sha256": model_sha, "byteCount": len(weights),
            "upstreamRevision": candidate["upstreamRevision"], "sourceUrl": candidate["sourceUrl"],
            "license": {"spdx": candidate["weightsLicense"], "codeEvidenceUrl": candidate["licenseEvidenceUrl"],
                "weightsEvidenceUrl": candidate["weightsLicenseScopeUrl"], "reviewStatus": "REVIEWED_FOR_EVALUATION",
                "reviewReference": "evaluation/p4-model-candidates-2026-10-16.json#tesseract-eng-fast"},
            "productionApproval": {"approved": False, "evaluationEvidenceSha256": None, "decisionReference": None}}
        descriptor_path = output / "model-descriptor.json"
        descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n")
        verifier = '''import { readFileSync } from "node:fs";
import { verifyLocalModel } from "./src/lib/media/local-models.ts";
verifyLocalModel(JSON.parse(readFileSync(process.argv[1], "utf8")), {modelRoot: process.argv[2], usage: "evaluation"})
.then(({path, ...evidence}) => process.stdout.write(JSON.stringify(evidence)))
.catch(error => { console.error(error.message); process.exitCode = 1; });'''
        verified = json.loads(run(["npx", "tsx", "-e", verifier, str(descriptor_path), str(models)]).stdout)
        expected = "SCRIPTURE SLIDE\nOCR TEST WORDS"
        text_path = Path(temporary) / "fixture.txt"
        text_path.write_text(expected)
        image = output / "input.png"
        run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=white:s=854x480:r=1",
            "-vf", f"drawtext=fontfile={font}:textfile={text_path}:fontsize=48:fontcolor=black:x=40:y=120:line_spacing=20",
            "-frames:v", "1", "-threads", "1", str(image)])
        timing = Path(temporary) / "time.txt"
        started = time.monotonic()
        result = run(["/usr/bin/time", "-l", "-o", str(timing), "tesseract", str(image), str(output / "recognized"),
            "--tessdata-dir", str(models), "-l", "eng", "--psm", "6", "--oem", "1"])
        wall_ms = (time.monotonic() - started) * 1000
        timing_text = timing.read_text()
        cpu = re.search(r"([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys", timing_text)
        rss = re.search(r"(\d+)\s+maximum resident set size", timing_text)
        if not cpu or not rss:
            raise ValueError("The native resource measurement could not be read.")
        recognized = (output / "recognized.txt").read_text()
        report = {"version": "p4-ocr-synthetic-fixture-v1", "scope": "ONE_SYNTHETIC_FRAME_ONLY",
            "model": verified, "pinnedGitBlobSha1": blob, "licenseEvidence": checked,
            "fixture": {"width": 854, "height": 480, "fontSha256": sha(font.read_bytes()), "fontSize": 48,
                "imageSha256": sha(image.read_bytes()), "expectedText": expected, "recognizedText": recognized,
                "normalizedExactMatch": " ".join(expected.split()) == " ".join(recognized.split())},
            "runtime": {"platform": platform.platform(), "machine": platform.machine(),
                "tesseract": run(["tesseract", "--version"]).stdout.splitlines()[0],
                "ffmpeg": run(["ffmpeg", "-version"]).stdout.splitlines()[0],
                "psm": 6, "oem": 1, "wallTimeMs": wall_ms, "nativeRealSeconds": float(cpu[1]),
                "userCpuSeconds": float(cpu[2]), "systemCpuSeconds": float(cpu[3]), "peakResidentBytes": int(rss[1]),
                "stderr": result.stderr.strip()},
            "representativeQuality": "NOT_MEASURED", "slideRecall": None, "productionApproved": False,
            "modelBytesRetained": False}
        if sparse:
            adapter = '''import { readFileSync } from "node:fs";
import { fileIdentity } from "./src/lib/storage/file-identity.ts";
import { runSparseOcr } from "./src/lib/media/sparse-ocr.ts";
(async () => {
  const model = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const image = await fileIdentity(process.argv[3]);
  const frame = {groupIndex: 0, sourceTimeMs: 0, path: process.argv[3], ...image, width: 854, height: 480};
  const result = await runSparseOcr({sourceVideoId: "11111111-1111-4111-8111-111111111111", sourceSha256: image.sha256,
    representativeEvidenceSha256: image.sha256, frames: [frame], selections: [{groupIndex: 0, frameSha256: image.sha256,
      decision: "LIKELY_STATIC_TEXT", evidenceSha256: image.sha256}]},
    {binaryPath: process.argv[4], modelRoot: process.argv[2], usage: "evaluation", model,
      pageSegmentationMode: 6, maxSelectedFrames: 1, maxInputBytes: image.byteCount,
      maxOutputBytes: 1048576, timeoutMs: 30000});
  process.stdout.write(JSON.stringify(result));
})().catch(error => { console.error(error.message); process.exitCode = 1; });'''
            result = json.loads(run(["npx", "tsx", "-e", adapter, str(descriptor_path), str(models), str(image), shutil.which("tesseract")]).stdout)
            recognized_words = " ".join(word["text"] for frame in result["results"] for word in frame["words"])
            if recognized_words != " ".join(expected.split()):
                raise ValueError("Sparse OCR adapter did not reproduce the synthetic fixture text.")
            (output / "sparse-ocr.json").write_text(json.dumps(result, indent=2) + "\n")
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output / "report.json"), "sha256": model_sha,
        "fixtureExactMatch": report["fixture"]["normalizedExactMatch"], "productionApproved": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New output directory; existing directories are refused.")
    parser.add_argument("--sparse", action="store_true", help="Also exercise the sparse OCR adapter with the synthetic frame.")
    arguments = parser.parse_args()
    evaluate(arguments.output.resolve(), arguments.sparse)
