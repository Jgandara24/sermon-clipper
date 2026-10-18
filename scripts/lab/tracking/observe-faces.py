"""Phase 1 lab: YuNet face observations for one clip of a source video.

A generalized copy of Codex's scripts/p4/track-c1.py (branch codex/p4-sermon-understanding):
the same detector, threshold, camera-cut rule and output shape, with the source, range and
frame size taken from arguments instead of being written into the script.

    python observe-faces.py --source <mp4> --start <s> --end <s> --out <json>

Run with the venv Codex built: /Users/jakegandara/ai-runtimes/p4-speaker-tracking-py313/bin/python
Reads the source only. Writes one JSON file.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
import time

MODEL = pathlib.Path('/Users/jakegandara/ai-models/p4-speaker-tracking/face_detection_yunet_2023mar.onnx')
MODEL_HASH = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
SCORE_THRESHOLD = .9   # Codex's value
CUT_THRESHOLD = .12    # Codex's value: mean absolute difference of 64x36 grayscale frames


def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        while data := stream.read(1024 * 1024):
            value.update(data)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=pathlib.Path, required=True)
    parser.add_argument('--start', type=float, required=True)
    parser.add_argument('--end', type=float, required=True)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    args = parser.parse_args()
    assert args.end > args.start, 'end must be after start'

    import cv2
    import numpy as np
    assert cv2.__version__ == '4.11.0' and np.__version__ == '2.2.6', 'use the Codex tracking venv'
    assert digest(MODEL) == MODEL_HASH, 'face model checksum does not match'

    source = args.source.resolve()
    stream = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'stream=width,height,sample_aspect_ratio,time_base', '-of', 'json', str(source)]))['streams'][0]
    width, height = stream['width'], stream['height']
    assert stream.get('sample_aspect_ratio', '1:1') in ('1:1', '0:1', None), 'non-square pixels are not supported'

    # Native presentation timestamps, as Codex did, so cut times are exact source times.
    native = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-read_intervals', f'{args.start}%{args.end + 1}', '-select_streams', 'v:0',
        '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', str(source)]))
    times = [float(f['best_effort_timestamp_time']) for f in native['frames']
             if 'best_effort_timestamp_time' in f and args.start <= float(f['best_effort_timestamp_time']) < args.end]
    times.sort()

    started = time.monotonic()
    detector = cv2.FaceDetectorYN.create(str(MODEL), '', (width, height), SCORE_THRESHOLD)
    decoder = subprocess.Popen(
        ['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{times[0]:.6f}', '-i', str(source), '-frames:v', str(len(times)),
         '-an', '-pix_fmt', 'bgr24', '-f', 'rawvideo', '-'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frames = []
    previous = None
    try:
        for t in times:
            data = decoder.stdout.read(width * height * 3)
            if len(data) < width * height * 3:
                break
            frame = np.frombuffer(data, np.uint8).reshape(height, width, 3)
            gray = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (64, 36)).astype(float)
            difference = 0 if previous is None else float(np.mean(abs(gray - previous)) / 255)
            previous = gray
            _, found = detector.detect(frame)
            faces = []
            for face in ([] if found is None else found):
                x, y, w, h = [float(v) for v in face[:4]]
                x1, y1 = min(width, x + w), min(height, y + h)
                x, y = max(0, x), max(0, y)
                if x1 > x and y1 > y:
                    faces.append({'box': {'x': x, 'y': y, 'w': x1 - x, 'h': y1 - y}, 'score': float(face[-1])})
            frames.append({'t': t, 'cut': difference > CUT_THRESHOLD, 'faces': faces})
    finally:
        decoder.stdout.close()
        if decoder.poll() is None:
            decoder.kill()
        decoder.wait(timeout=10)
    assert len(frames) >= len(times) - 1, f'decoded {len(frames)} of {len(times)} frames'

    seconds = time.monotonic() - started
    out = {
        'observations': {'frames': frames},
        'geometry': {'width': width, 'height': height, 'rotation': 0, 'pixelAspect': '1:1',
                     'timebase': stream['time_base']},
        'source': str(source), 'start': frames[0]['t'], 'end': args.end, 'modelSha256': MODEL_HASH,
        'detector': {'scoreThreshold': SCORE_THRESHOLD, 'cutThreshold': CUT_THRESHOLD},
        'computeSeconds': round(seconds, 2),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out))
    print(json.dumps({'frames': len(frames), 'framesWithFaces': sum(bool(f['faces']) for f in frames),
                      'framesWithOneFace': sum(len(f['faces']) == 1 for f in frames),
                      'cuts': [round(f['t'], 3) for f in frames if f['cut']], 'computeSeconds': round(seconds, 2)}))


if __name__ == '__main__':
    main()
