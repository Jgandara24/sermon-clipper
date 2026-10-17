#!/usr/bin/env python3
"""Evaluate pinned face or person models on one public portrait. No activation."""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import signal
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = "https://raw.githubusercontent.com/scikit-image/scikit-image/e8a42ba85aaf5fd9322ef9ca51bc21063b22fcae/skimage/data/"
FIXTURE_SHA = "88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5"
YOLOX_HELPER_SHA = "c99d8f103d93d27d0fb1807c7b91cb32d2d6c4959326cb88c801f17d00468f84"
YOLOX_DEMO_SHA = "44295a9a9616fd1d8dcb7ebf337f655d85db8e8e9413ca1d2e8a9891549c68d6"
LICENSE_SHA = "7f429eaa2284e18df7b170b19f675488347ff90dfee2eb101fbced2c072f4bde"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def download(url, limit, expected=None):
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit or (expected and sha(data) != expected):
        raise ValueError("Downloaded bytes exceed the limit or fail checksum verification.")
    return data


def raw_url(url):
    match = re.fullmatch(r"https://github.com/([^/]+)/([^/]+)/blob/([0-9a-f]{40})/(.+)", url)
    if not match:
        raise ValueError("A pinned GitHub blob URL is required.")
    return "https://raw.githubusercontent.com/" + "/".join(match.groups())


def run(args):
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                          cwd=ROOT, start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=120)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args, stdout, stderr)
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


def worker(model, portrait, output, detector_kind="face"):
    import cv2
    import numpy as np
    cv2.setNumThreads(1)
    cv2.ocl.setUseOpenCL(False)
    photo = cv2.imread(str(portrait))
    if photo is None or photo.shape != (512, 512, 3):
        raise ValueError("The portrait dimensions changed.")
    started = time.monotonic()
    if detector_kind == "person":
        helper = model.parent / "yolox.py"
        if sha(helper.read_bytes()) != YOLOX_HELPER_SHA:
            raise ValueError("The reviewed detector helper changed.")
        spec = importlib.util.spec_from_file_location("p4_pinned_yolox", helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        detector = module.YoloX(str(model), confThreshold=0.5, nmsThreshold=0.5, objThreshold=0.5,
                               backendId=cv2.dnn.DNN_BACKEND_OPENCV, targetId=cv2.dnn.DNN_TARGET_CPU)
    else:
        detector = cv2.FaceDetectorYN.create(str(model), "", (854, 480), 0.9, 0.3, 5000,
                                           cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)
    load_ms = (time.monotonic() - started) * 1000
    results = []
    for side in [480, 128, 64, 0]:
        image = np.zeros((480, 854, 3), dtype=np.uint8)
        if side:
            x, y = (854 - side) // 2, (480 - side) // 2
            image[y:y+side, x:x+side] = cv2.resize(photo, (side, side), interpolation=cv2.INTER_AREA)
        fixture = output / f"portrait-{side}.png"
        if not cv2.imwrite(str(fixture), image):
            raise ValueError("The fixture could not be saved.")
        started = time.monotonic()
        if detector_kind == "person":
            # Match the pinned demo: RGB, proportional resize, top-left placement, and 114 padding.
            scale = min(640 / image.shape[0], 640 / image.shape[1])
            resized = cv2.resize(cv2.cvtColor(image, cv2.COLOR_BGR2RGB),
                                 (int(image.shape[1] * scale), int(image.shape[0] * scale)), interpolation=cv2.INTER_LINEAR)
            padded = np.full((640, 640, 3), 114, dtype=np.float32)
            padded[:resized.shape[0], :resized.shape[1]] = resized
            detections = detector.infer(padded)
            values = detections.tolist()
            if any(len(row) != 6 or not all(np.isfinite(row)) or row[5] != int(row[5]) or not 0 <= row[5] < 80 or not 0 <= row[4] <= 1 or row[2] <= 0 or row[3] <= 0 for row in values):
                raise ValueError("The detector returned malformed object data.")
            source_boxes = [[*(coordinate / scale for coordinate in row[:4]), *row[4:]] for row in values]
            observed = sum(row[5] == 0 for row in values)
            details = {"nativeDetections": values, "sourceDetections": source_boxes,
                       "letterboxScale": scale, "expectedPersonCount": 1 if side else 0, "observedPersonCount": observed}
        else:
            _, faces = detector.detect(image)
            values = [] if faces is None else faces.tolist()
            if any(len(row) != 15 or not all(np.isfinite(row)) for row in values):
                raise ValueError("The detector returned malformed face data.")
            details = {"expectedFaceCount": 1 if side else 0, "observedFaceCount": len(values), "nativeFaces": values}
        elapsed = (time.monotonic() - started) * 1000
        results.append({"fixture": fixture.name, "sha256": sha(fixture.read_bytes()),
                        "width": 854, "height": 480, "portraitSidePx": side,
                        **details, "wallMs": elapsed})
    return {"opencvVersion": cv2.__version__, "numpyVersion": np.__version__, "threads": cv2.getNumThreads(),
            "backend": "DNN_BACKEND_OPENCV", "target": "DNN_TARGET_CPU", "opencl": False,
            "settings": ({"scoreThreshold": 0.5, "nmsThreshold": 0.5, "inputSize": [640, 640], "personClassId": 0,
                          "objectThresholdArgument": 0.5, "objectThresholdAppliedSeparately": False,
                          "note": "The pinned helper multiplies objectness and class score; it does not use objThreshold separately."}
                         if detector_kind == "person" else {"scoreThreshold": 0.9, "nmsThreshold": 0.3, "topK": 5000}),
            "detectorKind": detector_kind,
            "nativeObjectColumns": ["x", "y", "width", "height", "objectnessTimesClassScore", "classId"] if detector_kind == "person" else None,
            "modelLoadWallMs": load_ms, "results": results,
            "nativeFaceColumns": ["x", "y", "width", "height", "rightEyeX", "rightEyeY", "leftEyeX", "leftEyeY",
                                  "noseX", "noseY", "rightMouthX", "rightMouthY", "leftMouthX", "leftMouthY", "score"] if detector_kind == "face" else None}


def evaluate(output, detector_kind="face"):
    if detector_kind not in {"face", "person"}:
        raise ValueError("Unknown detector kind.")
    if output.exists():
        raise ValueError("The output directory already exists.")
    if platform.system() != "Darwin" or not shutil.which("npx"):
        raise ValueError("This experiment requires macOS resource measurements and npx.")
    for package, version in [("opencv-python-headless", "4.11.0.86"), ("numpy", "2.2.6")]:
        if importlib.metadata.version(package) != version:
            raise ValueError(f"The experiment requires {package}=={version}.")
    candidate_id = "yunet-2023mar" if detector_kind == "face" else "yolox-s-2022nov"
    candidate = next(item for item in json.loads((ROOT / "evaluation/p4-model-candidates-2026-10-16.json").read_text())["candidates"]
                     if item["candidateId"] == candidate_id)
    if candidate["licenseReview"] != "PERMISSIVE_LICENSE_EVIDENCE_FOUND":
        raise ValueError("The model lacks prior license review.")
    output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="p4-portrait-model-") as temporary:
        models = Path(temporary)
        checked = {}
        for url_key, hash_key in [("licenseEvidenceUrl", "licenseFileSha256"), ("weightsLicenseScopeUrl", "readmeSha256")]:
            data = download(raw_url(candidate[url_key]), 1048576, candidate[hash_key])
            checked[hash_key] = sha(data)
        helper_evidence = None
        if detector_kind == "person":
            base = raw_url(candidate["sourceUrl"]).rsplit("/", 1)[0] + "/"
            for name, expected in [("yolox.py", YOLOX_HELPER_SHA), ("demo.py", YOLOX_DEMO_SHA)]:
                data = download(base + name, 1048576, expected)
                if name == "yolox.py":
                    (models / name).write_bytes(data)
            helper_evidence = {"helperUrl": base + "yolox.py", "helperSha256": YOLOX_HELPER_SHA,
                               "preprocessingReferenceUrl": base + "demo.py", "preprocessingReferenceSha256": YOLOX_DEMO_SHA}
        pointer = download(raw_url(candidate["sourceUrl"]), 1024)
        if f"oid sha256:{candidate['expectedSha256']}" not in pointer.decode() or f"size {candidate['expectedByteCount']}" not in pointer.decode():
            raise ValueError("The pinned Git LFS pointer changed.")
        url = raw_url(candidate["sourceUrl"]).replace("https://raw.githubusercontent.com/", "https://media.githubusercontent.com/media/")
        weights = download(url, candidate["expectedByteCount"], candidate["expectedSha256"])
        if len(weights) != candidate["expectedByteCount"]:
            raise ValueError("The model byte count changed.")
        model = models / ("yunet.onnx" if detector_kind == "face" else "yolox.onnx")
        model.write_bytes(weights)
        descriptor = {"modelId": candidate["candidateId"], "version": candidate["upstreamRevision"], "roles": candidate["roles"],
            "relativePath": model.name, "sha256": sha(weights), "byteCount": len(weights),
            "upstreamRevision": candidate["upstreamRevision"], "sourceUrl": candidate["sourceUrl"],
            "license": {"spdx": candidate["weightsLicense"], "codeEvidenceUrl": candidate["licenseEvidenceUrl"],
                "weightsEvidenceUrl": candidate["weightsLicenseScopeUrl"], "reviewStatus": "REVIEWED_FOR_EVALUATION",
                "reviewReference": "evaluation/p4-model-candidates-2026-10-16.json#" + candidate_id},
            "productionApproval": {"approved": False, "evaluationEvidenceSha256": None, "decisionReference": None}}
        descriptor_path = output / "model-descriptor.json"
        descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n")
        verifier = '''import { readFileSync } from "node:fs";
import { verifyLocalModel } from "./src/lib/media/local-models.ts";
verifyLocalModel(JSON.parse(readFileSync(process.argv[1], "utf8")), {modelRoot: process.argv[2], usage: "evaluation"})
.then(({path, ...evidence}) => process.stdout.write(JSON.stringify(evidence)))
.catch(error => { console.error(error.message); process.exitCode = 1; });'''
        verified = json.loads(run(["npx", "tsx", "-e", verifier, str(descriptor_path), str(models)]).stdout)
        license_data = download(FIXTURE_ROOT + "_fetchers.py", 1048576, LICENSE_SHA)
        portrait = output / "astronaut.png"
        portrait.write_bytes(download(FIXTURE_ROOT + "astronaut.png", 1048576, FIXTURE_SHA))
        timing = models / "timing.txt"
        started = time.monotonic()
        result = run(["/usr/bin/time", "-l", "-o", str(timing), sys.executable, str(Path(__file__).resolve()),
                      "--worker", str(model), str(portrait), str(output), detector_kind])
        wall_ms = (time.monotonic() - started) * 1000
        native = json.loads(result.stdout)
        measurements = timing.read_text()
        cpu = re.search(r"([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys", measurements)
        rss = re.search(r"(\d+)\s+maximum resident set size", measurements)
        if not cpu or not rss or sha(model.read_bytes()) != descriptor["sha256"]:
            raise ValueError("Resource measurements or final model identity are invalid.")
        report = {"version": "p4-yunet-public-fixture-v1" if detector_kind == "face" else "p4-yolox-public-fixture-v1", "scope": "ONE_PUBLIC_PORTRAIT_AT_THREE_SCALES_AND_BLANK_CONTROL",
            "model": verified, "helperEvidence": helper_evidence, "licenseEvidence": checked, "pointerSha256": sha(pointer),
            "fixtureEvidence": {"imageUrl": FIXTURE_ROOT + "astronaut.png", "imageSha256": FIXTURE_SHA,
                "licenseEvidenceUrl": FIXTURE_ROOT + "_fetchers.py", "licenseEvidenceSha256": sha(license_data),
                "licenseStatus": "UPSTREAM_DOCUMENTS_PUBLIC_DOMAIN", "representativeSermonFootage": False},
            "runtime": {"python": platform.python_version(), "platform": platform.platform(),
                "machine": platform.machine(), "cpu": run(["sysctl", "-n", "machdep.cpu.brand_string"]).stdout.strip()},
            "processMeasurement": {"scope": "PYTHON_IMPORT_MODEL_LOAD_FOUR_INFERENCES_AND_PNG_OUTPUT",
                "wallMs": wall_ms, "nativeRealSeconds": float(cpu[1]), "userCpuSeconds": float(cpu[2]),
                "systemCpuSeconds": float(cpu[3]), "peakResidentBytes": int(rss[1])},
            "inference": native, "productionApproved": False, "qualityEvidence": None,
            "limitations": ["One portrait does not establish representative accuracy or false-positive rates.",
                "Scores are native model estimates, not calibrated confidence.",
                "A detection does not prove a pastor or live camera footage.",
                "Printed faces and presentation slides remain unresolved.",
                "Settings describe this experiment and are not production defaults."]}
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        return report


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        print(json.dumps(worker(*map(Path, sys.argv[2:5]), sys.argv[5] if len(sys.argv) > 5 else "face")))
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--output", required=True, type=Path)
        parser.add_argument("--detector", choices=["face", "person"], default="face")
        args = parser.parse_args()
        report = evaluate(args.output.resolve(), args.detector)
        print(json.dumps({"report": str(args.output / "report.json"),
                          "counts": [row["observedFaceCount" if args.detector == "face" else "observedPersonCount"] for row in report["inference"]["results"]]}))
