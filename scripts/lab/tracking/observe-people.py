"""Phase 1 lab, fix AC: YOLOX-s person boxes for a list of JPEG frames.

The camera check (src/lib/analysis/camera-check-run.ts) passes the faceless sample frames of a
clip's longer no-face runs; a run where nobody is seen for half a second or more is an empty
frame, and the clip is rejected as off-screen (lab sermon 1q clip 4, 2026-10-26).

    python observe-people.py --images a.jpg b.jpg ...

Prints {"people": {"a.jpg": [{"box", "score"}], ...}}. Run with Codex's tracking venv.
"""
import argparse
import json

from yolox_people import PEOPLE_MODEL, PEOPLE_MODEL_HASH, PersonDetector, digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--images', nargs='+', required=True)
    args = parser.parse_args()

    import cv2
    import numpy as np
    assert digest(PEOPLE_MODEL) == PEOPLE_MODEL_HASH, 'person model checksum does not match'
    detector = PersonDetector(cv2, np)
    people = {}
    for image in args.images:
        frame = cv2.imread(image)
        assert frame is not None, f'cannot read {image}'
        people[image] = detector.detect(frame)
    print(json.dumps({'people': people}))


if __name__ == '__main__':
    main()
