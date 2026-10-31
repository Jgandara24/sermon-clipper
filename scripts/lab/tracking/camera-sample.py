"""Phase 1 lab camera check sampler: N frames per second of one clip, face count per frame.

Frames without a face are saved as JPEG so the vision model can say whether they are a slide.

Fix Y (lab sermon 4i clip 6, 2026-10-25): a "Christians Never Die" slide dissolved in for a quarter
of a second, 16 seconds into the clip. At 2 frames per second every sample held a face, so no frame
went to the vision model. The sampler now decodes once at --scan-fps (12), checks faces every
(scan-fps / fps) frames, and reports a scene change wherever a frame differs from the one before by
--scene-diff (20) or more in mean gray level, each with its frame, so a slide that flashes between
face samples is seen. That slide scored 58, camera-angle cuts in lab sermon 2k scored 37, and steady
preaching stays under 5. (ffmpeg's select=scene filter does the same but took 28 seconds a clip.)

    python camera-sample.py --source <mp4> --start <s> --end <s> --out-dir <dir> [--fps 4] [--scan-fps 12] [--scene-diff 20]

Run with Codex's tracking venv. Prints one JSON object:
{"samples": [{"t", "faceCount", "image"}], "sceneChanges": [{"t", "score", "image"}]}.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess

MODEL = pathlib.Path('/Users/jakegandara/ai-models/p4-speaker-tracking/face_detection_yunet_2023mar.onnx')
MODEL_HASH = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
# Lower than the tracker's 0.9: here the question is only "is anyone's face on screen?", and a
# preacher looking down must not read as a slide.
SCORE_THRESHOLD = .6
WIDTH, HEIGHT = 640, 360


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=pathlib.Path, required=True)
    parser.add_argument('--start', type=float, required=True)
    parser.add_argument('--end', type=float, required=True)
    parser.add_argument('--out-dir', type=pathlib.Path, required=True)
    parser.add_argument('--fps', type=float, default=4, help='face checks per second')
    parser.add_argument('--scan-fps', type=float, default=12, help='decoded frames per second, for scene changes')
    parser.add_argument('--scene-diff', type=float, default=20, help='mean gray difference from the frame before that marks a scene change')
    args = parser.parse_args()
    assert args.end > args.start and args.fps > 0 and args.scan_fps >= args.fps
    every = max(1, round(args.scan_fps / args.fps))

    import cv2
    import numpy as np
    assert hashlib.sha256(MODEL.read_bytes()).hexdigest() == MODEL_HASH, 'face model checksum does not match'

    args.out_dir.mkdir(parents=True, exist_ok=True)
    detector = cv2.FaceDetectorYN.create(str(MODEL), '', (WIDTH, HEIGHT), SCORE_THRESHOLD)
    decoder = subprocess.Popen(
        ['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{args.start:.3f}', '-i', str(args.source),
         '-t', f'{args.end - args.start:.3f}', '-an',
         '-vf', f'fps={args.scan_fps},scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=disable',
         '-pix_fmt', 'bgr24', '-f', 'rawvideo', '-'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    samples = []
    scene_changes = []
    previous = None
    try:
        index = 0
        while True:
            data = decoder.stdout.read(WIDTH * HEIGHT * 3)
            if len(data) < WIDTH * HEIGHT * 3:
                break
            frame = np.frombuffer(data, np.uint8).reshape(HEIGHT, WIDTH, 3)
            t = round(args.start + index / args.scan_fps, 3)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.int16)
            if previous is not None:
                score = float(np.abs(gray - previous).mean())
                if score >= args.scene_diff:
                    image = str(args.out_dir / f'scene-{len(scene_changes):03d}.jpg')
                    cv2.imwrite(image, frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    scene_changes.append({'t': t, 'score': round(score, 1), 'image': image})
            previous = gray
            if index % every == 0:
                _, found = detector.detect(frame)
                count = 0 if found is None else len(found)
                image = None
                if count == 0:
                    image = str(args.out_dir / f'frame-{index:04d}.jpg')
                    cv2.imwrite(image, frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                samples.append({'t': t, 'faceCount': count, 'image': image})
            index += 1
    finally:
        decoder.stdout.close()
        if decoder.poll() is None:
            decoder.kill()
        decoder.wait(timeout=10)
    print(json.dumps({'samples': samples, 'sceneChanges': scene_changes}))


if __name__ == '__main__':
    main()
