"""Phase 1 lab: the YOLOX-s person detector the tracker and the camera check share.

Person boxes (lab sermons 2 and 3, 2026-10-18: the face detector loses a preacher who turns
sideways): YOLOX-s from the OpenCV Zoo (Apache 2.0). observe-faces.py runs it on every
--people-every'th frame of a clip; observe-people.py (fix AC) runs it on the camera check's
faceless sample frames. Decoded as the OpenCV Zoo demo does (letterbox, no normalization).
"""
import hashlib
import pathlib

PEOPLE_MODEL = pathlib.Path('/Users/jakegandara/ai-models/p4-speaker-tracking/object_detection_yolox_2022nov.onnx')
PEOPLE_MODEL_HASH = 'c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063'
PEOPLE_SCORE = .4      # person class score; the preacher scores .86-.94 on the lab sermons
PEOPLE_INPUT = 640     # YOLOX-s input square


class PersonDetector:
    """YOLOX-s person boxes, decoded as the OpenCV Zoo demo does (letterbox, no normalization)."""

    def __init__(self, cv2, np):
        self.cv2, self.np = cv2, np
        self.net = cv2.dnn.readNet(str(PEOPLE_MODEL))
        grids, strides = [], []
        for stride in (8, 16, 32):
            n = PEOPLE_INPUT // stride
            xv, yv = np.meshgrid(np.arange(n), np.arange(n))
            grids.append(np.stack((xv, yv), 2).reshape(1, -1, 2))
            strides.append(np.full((1, n * n, 1), stride))
        self.grids, self.strides = np.concatenate(grids, 1)[0], np.concatenate(strides, 1)[0]

    def detect(self, frame):
        cv2, np = self.cv2, self.np
        height, width = frame.shape[:2]
        ratio = min(PEOPLE_INPUT / height, PEOPLE_INPUT / width)
        padded = np.full((PEOPLE_INPUT, PEOPLE_INPUT, 3), 114.0, np.float32)
        resized = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), (int(width * ratio), int(height * ratio)))
        padded[:resized.shape[0], :resized.shape[1]] = resized
        self.net.setInput(np.transpose(padded, (2, 0, 1))[None])
        out = self.net.forward(self.net.getUnconnectedOutLayersNames())[0][0]
        centers = (out[:, :2] + self.grids) * self.strides
        sizes = np.exp(out[:, 2:4]) * self.strides
        scores = out[:, 4] * out[:, 5]  # objectness x the person class
        keep = scores > PEOPLE_SCORE
        boxes = [[float(cx - w / 2) / ratio, float(cy - h / 2) / ratio, float(w) / ratio, float(h) / ratio]
                 for (cx, cy), (w, h) in zip(centers[keep], sizes[keep])]
        chosen = cv2.dnn.NMSBoxes(boxes, scores[keep].tolist(), PEOPLE_SCORE, .5) if boxes else []
        people = []
        for i in np.array(chosen).flatten():
            x, y, w, h = boxes[i]
            x1, y1 = min(width, x + w), min(height, y + h)
            x, y = max(0., x), max(0., y)
            if x1 > x and y1 > y:
                people.append({'box': {'x': x, 'y': y, 'w': x1 - x, 'h': y1 - y}, 'score': float(scores[keep][i])})
        return people


def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        while data := stream.read(1024 * 1024):
            value.update(data)
    return value.hexdigest()
