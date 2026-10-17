#!/usr/bin/env python3
"""Evaluate pinned YAMNet weights on synthetic audio fixtures. No activation."""
import argparse
import base64
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = [("tensorflow", "2.15.1"), ("tf-keras", "2.15.1"), ("numpy", "1.26.4"), ("h5py", "3.10.0")]
SOURCE_FILES = ["yamnet.py", "features.py", "params.py", "yamnet_class_map.csv"]
SPEECH_TEXT = "Please open your Bibles to the book of Romans, chapter eight, verse one."
# Named classes are reported for inspection. They are audio-event labels, not service roles.
NAMED_CLASSES = ["Speech", "Narration, monologue", "Music", "Singing", "Silence", "Sine wave", "White noise", "Pink noise"]
UPSTREAM_TESTS = {"silence": "Silence", "seeded-uniform-noise": "White noise", "sine-440hz": "Sine wave"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def download(url, limit, expected=None):
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(limit + 1)
    if len(data) > limit or (expected and sha(data) != expected):
        raise ValueError("Downloaded bytes exceed the limit or fail checksum verification.")
    return data


def raw_url(url):
    match = re.fullmatch(r"https://github.com/([^/]+)/([^/]+)/blob/([0-9a-f]{40})/(.+)", url)
    if not match:
        raise ValueError("A pinned GitHub blob URL is required.")
    return "https://raw.githubusercontent.com/" + "/".join(match.groups())


def run(args, timeout=600):
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ROOT, start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args, stdout, stderr.decode(errors="replace"))
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


def decode_pcm(path):
    """Decode with FFmpeg to 16 kHz mono float32. YAMNet expects samples in [-1, 1]."""
    import numpy as np
    data = run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]).stdout
    return np.frombuffer(data, dtype="<f4").astype(np.float32)


def fixtures(scratch):
    import numpy as np
    rate = 16000
    seconds = np.arange(0, 3, 1 / rate)
    rows = {"silence": np.zeros((3 * rate,), dtype=np.float32)}
    np.random.seed(51773)  # The pinned upstream test uses this seed.
    rows["seeded-uniform-noise"] = np.random.uniform(-1.0, 1.0, (3 * rate,)).astype(np.float32)
    rows["sine-440hz"] = np.sin(2 * np.pi * 440 * seconds).astype(np.float32)
    speech_file = scratch / "speech.aiff"
    # Use an installed voice. This command does not request a voice download.
    run(["say", "-v", "Samantha", "-r", "150", "-o", str(speech_file), SPEECH_TEXT])
    speech = decode_pcm(speech_file)
    peak = float(np.max(np.abs(speech)))
    if speech.size < rate or peak <= 0:
        raise ValueError("Speech synthesis produced no usable audio.")
    speech = (speech * (0.5 / peak)).astype(np.float32)
    rows["synthetic-speech"] = speech
    # Three steady sine tones are a crude non-music control for speech over tonal sound.
    duration = np.arange(speech.size) / rate
    tones = sum(np.sin(2 * np.pi * hz * duration) for hz in [261.63, 329.63, 392.0]) / 3
    rows["synthetic-speech-over-steady-tones"] = (speech + 0.15 * tones).astype(np.float32)
    return rows


def worker(source_dir, model_path, scratch):
    import numpy as np
    for name, expected in json.loads(os.environ["P4_YAMNET_SOURCE_SHA"]).items():
        if sha((source_dir / name).read_bytes()) != expected:
            raise ValueError("Reviewed YAMNet source changed before import.")
    if sha(model_path.read_bytes()) != os.environ["P4_YAMNET_MODEL_SHA"]:
        raise ValueError("Model bytes changed before loading.")
    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(2)
    tf.config.threading.set_inter_op_parallelism_threads(1)
    sys.path.insert(0, str(source_dir))
    import params as params_lib
    import yamnet as yamnet_lib
    params = params_lib.Params()
    started = time.monotonic()
    model = yamnet_lib.yamnet_frames_model(params)
    model.load_weights(str(model_path))
    load_ms = (time.monotonic() - started) * 1000
    classes = yamnet_lib.class_names(str(source_dir / "yamnet_class_map.csv"))
    if len(classes) != params.num_classes:
        raise ValueError("The class map does not match the model class count.")
    indices = {name: int(np.where(classes == name)[0][0]) for name in NAMED_CLASSES}
    results = []
    for fixture, waveform in fixtures(scratch).items():
        started = time.monotonic()
        scores, embeddings, spectrogram = model(waveform)
        inference_ms = (time.monotonic() - started) * 1000
        scores = scores.numpy().astype("<f4")
        clip = scores.mean(axis=0)
        top = np.argsort(clip)[-10:][::-1]
        row = {"fixture": fixture, "sampleCount": int(waveform.size), "durationMs": waveform.size / 16,
               "waveformSha256": sha(waveform.astype("<f4").tobytes()), "frameCount": int(scores.shape[0]),
               "embeddingShape": list(embeddings.shape), "spectrogramShape": list(spectrogram.shape),
               "scoreMatrixSha256": sha(scores.tobytes()), "inferenceWallMs": inference_ms,
               "clipMeanTop10": [{"classIndex": int(i), "className": str(classes[i]), "score": float(clip[i])} for i in top],
               "clipMeanNamedScores": {name: float(clip[index]) for name, index in indices.items()},
               "frameNamedScores": {name: [float(value) for value in scores[:, index]] for name, index in
                                    indices.items() if name in {"Speech", "Music", "Silence"}},
               "frameTop1": [str(classes[i]) for i in scores.argmax(axis=1)]}
        if fixture in UPSTREAM_TESTS:
            row["upstreamExpectedClass"] = UPSTREAM_TESTS[fixture]
            row["upstreamExpectationMet"] = UPSTREAM_TESTS[fixture] in row_names(row)
        results.append(row)
    return {"tensorflowVersion": tf.__version__, "kerasPackage": "tf-keras " + importlib.metadata.version("tf-keras"),
            "numpyVersion": np.__version__, "intraOpThreads": 2, "interOpThreads": 1,
            "params": {"sampleRate": params.sample_rate, "patchWindowSeconds": params.patch_window_seconds,
                       "patchHopSeconds": params.patch_hop_seconds, "classifierActivation": params.classifier_activation},
            "modelLoadWallMs": load_ms, "classCount": len(classes), "results": results}


def row_names(row):
    return [item["className"] for item in row["clipMeanTop10"]]


def evaluate(output):
    if output.exists():
        raise ValueError("The output directory already exists.")
    if platform.system() != "Darwin":
        raise ValueError("This experiment requires macOS speech synthesis and native resource measurements.")
    for binary in ["say", "ffmpeg", "npx"]:
        if not shutil.which(binary):
            raise ValueError(f"Required tool is missing: {binary}")
    for package, version in PACKAGES:
        if importlib.metadata.version(package) != version:
            raise ValueError(f"The experiment requires {package}=={version}.")
    candidate = next(item for item in json.loads((ROOT / "evaluation/p4-model-candidates-2026-10-16.json").read_text())["candidates"]
                     if item["candidateId"] == "yamnet")
    obj = json.loads((ROOT / candidate["objectIdentityReport"]).read_text())
    sources = json.loads((ROOT / candidate["sourceIdentityReport"]).read_text())["files"]
    if candidate["licenseReview"] != "PERMISSIVE_LICENSE_EVIDENCE_FOUND" or obj["sha256"] != candidate["expectedSha256"]:
        raise ValueError("The candidate lacks license review or consistent identity evidence.")
    output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="p4-yamnet-evaluation-") as temporary:
        temporary = Path(temporary)
        models, source_dir, scratch = temporary / "models", temporary / "source", temporary / "scratch"
        for directory in [models, source_dir, scratch]:
            directory.mkdir()
        readme = download(raw_url(candidate["readmeUrl"]), 1048576, candidate["readmeSha256"])
        for name in SOURCE_FILES:
            (source_dir / name).write_bytes(download(sources[name]["url"], 1048576, sources[name]["sha256"]))
        weights = download(obj["downloadUrl"], candidate["expectedByteCount"], candidate["expectedSha256"])
        md5 = base64.b64encode(hashlib.md5(weights).digest()).decode()
        if len(weights) != candidate["expectedByteCount"] or md5 != obj["verifiedMd5Base64"]:
            raise ValueError("Model bytes differ from the pinned provider identity.")
        model = models / "yamnet.h5"
        model.write_bytes(weights)
        del weights
        descriptor = {"modelId": candidate["candidateId"], "version": "gcs-generation-" + obj["metadata"]["generation"],
            "roles": candidate["roles"], "relativePath": model.name, "sha256": candidate["expectedSha256"],
            "byteCount": candidate["expectedByteCount"], "upstreamRevision": candidate["upstreamRevision"],
            "sourceUrl": obj["downloadUrl"],
            "license": {"spdx": candidate["weightsLicense"], "codeEvidenceUrl": candidate["licenseEvidenceUrl"],
                "weightsEvidenceUrl": candidate["weightsLicenseScopeUrl"], "reviewStatus": "REVIEWED_FOR_EVALUATION",
                "reviewReference": "evaluation/p4-model-candidates-2026-10-16.json#yamnet"},
            "productionApproval": {"approved": False, "evaluationEvidenceSha256": None, "decisionReference": None}}
        descriptor_path = output / "model-descriptor.json"
        descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n")
        verifier = '''import { readFileSync } from "node:fs";
import { verifyLocalModel } from "./src/lib/media/local-models.ts";
verifyLocalModel(JSON.parse(readFileSync(process.argv[1], "utf8")), {modelRoot: process.argv[2], usage: "evaluation"})
.then(({path, ...evidence}) => process.stdout.write(JSON.stringify(evidence)))
.catch(error => { console.error(error.message); process.exitCode = 1; });'''
        verified = json.loads(run(["npx", "tsx", "-e", verifier, str(descriptor_path), str(models)]).stdout)
        timing = temporary / "timing.txt"
        environment = {**os.environ, "TF_CPP_MIN_LOG_LEVEL": "2",
                       "P4_YAMNET_SOURCE_SHA": json.dumps({name: sources[name]["sha256"] for name in SOURCE_FILES}),
                       "P4_YAMNET_MODEL_SHA": candidate["expectedSha256"]}
        started = time.monotonic()
        with subprocess.Popen(["/usr/bin/time", "-l", "-o", str(timing), sys.executable, str(Path(__file__).resolve()),
                               "--worker", str(source_dir), str(model), str(scratch)], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, cwd=ROOT, env=environment, start_new_session=True) as process:
            try:
                stdout, stderr = process.communicate(timeout=600)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                raise
        wall_ms = (time.monotonic() - started) * 1000
        if process.returncode:
            raise ValueError("The YAMNet worker failed: " + stderr.decode(errors="replace")[-4000:])
        native = json.loads(stdout)
        measurements = timing.read_text()
        cpu = re.search(r"([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys", measurements)
        rss = re.search(r"(\d+)\s+maximum resident set size", measurements)
        if not cpu or not rss or sha(model.read_bytes()) != candidate["expectedSha256"]:
            raise ValueError("Resource measurements or final model identity are invalid.")
        report = {"version": "p4-yamnet-synthetic-fixture-v1", "scope": "UPSTREAM_SYNTHETIC_TESTS_PLUS_SYNTHETIC_SPEECH",
            "model": verified, "objectIdentity": {"generation": obj["metadata"]["generation"], "md5Base64": md5},
            "sourceEvidence": {name: sources[name]["sha256"] for name in SOURCE_FILES},
            "licenseEvidence": {"readmeSha256": sha(readme)},
            "fixtureEvidence": {"speechText": SPEECH_TEXT, "voice": "Samantha", "speechRate": 150,
                "speechPeakNormalizedTo": 0.5, "toneHz": [261.63, 329.63, 392.0], "toneGain": 0.15,
                "representativeSermonAudio": False},
            "runtime": {"python": platform.python_version(), "platform": platform.platform(), "machine": platform.machine(),
                "cpu": run(["sysctl", "-n", "machdep.cpu.brand_string"]).stdout.decode().strip(),
                "packages": {package: importlib.metadata.version(package) for package, _ in PACKAGES}},
            "processMeasurement": {"scope": "PYTHON_TENSORFLOW_IMPORT_MODEL_LOAD_SPEECH_SYNTHESIS_AND_FIVE_INFERENCES",
                "wallMs": wall_ms, "nativeRealSeconds": float(cpu[1]), "userCpuSeconds": float(cpu[2]),
                "systemCpuSeconds": float(cpu[3]), "peakResidentBytes": int(rss[1])},
            "inference": native, "temporaryOutputsRemoved": None, "modelBytesRetained": False,
            "productionApproved": False, "qualityEvidence": None,
            "limitations": ["Synthetic fixtures do not establish accuracy on church audio, reverberation, or live music.",
                "Scores are native sigmoid outputs, not calibrated confidence.",
                "Audio-event labels do not identify sermon, worship, prayer, announcement, or other service roles.",
                "Steady tones are not a music fixture; speech-over-music remains untested.",
                "Settings describe this experiment and are not production defaults."]}
    report["temporaryOutputsRemoved"] = not temporary.exists()
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        print(json.dumps(worker(*map(Path, sys.argv[2:5]))))
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--output", required=True, type=Path, help="New output directory; existing directories are rejected.")
        args = parser.parse_args()
        report = evaluate(args.output.resolve())
        print(json.dumps({"report": str(args.output / "report.json"),
                          "upstream": {row["fixture"]: row.get("upstreamExpectationMet") for row in report["inference"]["results"]},
                          "productionApproved": False}))
