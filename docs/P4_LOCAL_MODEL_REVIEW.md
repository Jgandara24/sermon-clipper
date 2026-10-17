# Local model candidate review

Review date: 2026-10-16.
This review identifies candidates for evaluation, not production selections.
Isolated OCR, boundary-ASR, face, person, and audio-event fixtures downloaded verified weights and removed them afterward.
No production model was activated.
No candidate has representative sermon accuracy or per-service worker resource evidence.
The [candidate inventory](../evaluation/p4-model-candidates-2026-10-16.json) records exact revisions, evidence links, and known artifact identities.

## Candidate evidence

| Role | Candidate | Weight-license evidence | Published artifact size | Current limitation |
|---|---|---|---:|---|
| Face detection | YuNet 2023mar | MIT; directory scope includes all files | 232589 bytes | One public portrait at three sizes; smaller versions were missed |
| Person detection | YOLOX_s 2022nov | Apache-2.0; directory scope includes all files | 35858002 bytes | One public portrait at three sizes; smallest version was missed |
| OCR | Tesseract `tessdata_fast` English | Apache-2.0; repository scope explicitly covers data | 4113088 bytes | SHA-256 verified; representative slide accuracy remains unverified |
| Local boundary ASR | whisper.cpp `base.en` | MIT code, model, and conversion evidence | 147964211 bytes | One synthetic speech window; representative boundary accuracy remains unverified |
| Speech/music and audio events | YAMNet | Apache-2.0; maintainer explicitly addressed architecture and weights | 15296092 bytes | Synthetic fixtures only; speech over steady tones scored low for Speech |

The pinned [YuNet directory](https://github.com/opencv/opencv_zoo/blob/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/README.md) supplies its license scope.
Its [license file](https://github.com/opencv/opencv_zoo/blob/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/LICENSE) contains the MIT terms.
The newer 2026may export changes runtime compatibility requirements.
This inventory retains the distinct 2023mar artifact instead of silently replacing its bytes.

The pinned [YOLOX directory](https://github.com/opencv/opencv_zoo/blob/47534e27c9851bb1128ccc0102f1145e27f23f98/models/object_detection_yolox/README.md) identifies the model as YOLOX_s.
Its license statement covers all directory files.
Upstream COCO results do not establish sermon visibility accuracy.

The pinned [Tesseract data repository](https://github.com/tesseract-ocr/tessdata_fast/blob/87416418657359cb625c412a48b6e1d6d41c29bd/README.md) explicitly licenses its data under Apache-2.0.
Its fast data supports the LSTM engine and trades accuracy for speed.
The Git blob SHA-1 is not a substitute for the required SHA-256.

The [YAMNet source](https://github.com/tensorflow/models/blob/34a21326906b9574fa11c4d6d0a5c534ff039267/research/audioset/yamnet/yamnet.py) carries Apache-2.0 terms.
A [maintainer response](https://groups.google.com/g/audioset-users/c/Ly4guQnlv_o) explicitly answers the architecture-and-weights license question.
The [model documentation](https://github.com/tensorflow/models/blob/34a21326906b9574fa11c4d6d0a5c534ff039267/research/audioset/yamnet/README.md) describes 521 audio-event classes.
Its Keras implementation has runtime compatibility requirements that need a separate pinned environment.
An event label does not establish worship, prayer, preaching, or another service role.

Required notices and license files must accompany any approved distribution.
Model licenses do not establish customer-recording rights or training-data rights.
The review does not authorize new training or data collection.

## Artifact integrity

The OpenCV repository publishes Git LFS pointers with SHA-256 identifiers and byte counts.
The inventory records those expected values separately from downloaded-byte verification.
The downloaded Tesseract, whisper.cpp, YuNet, and YOLOX model bytes passed checksum verification.
The YAMNet entry now has a generation-pinned identity.
Its SHA-256 came from downloaded bytes, not from an upstream SHA-256 publication.

`verifyLocalModel()` verifies existing files without downloading or substituting models.
Its descriptor requires separate code and weight-license evidence, expected size, checksum, upstream revision, and review reference.
Unreviewed and rejected descriptors cannot proceed.
Evaluation files may use an isolated temporary directory.
Production requires the `/models` path and explicit approval evidence.
The deployment must actually mount that directory and keep it read-only during inference.
The verifier checks paths and bytes; it does not prove operating-system mount configuration or authenticate approval authors.
Trusted deployment configuration must supply the approval reference.

The verifier rejects changed bytes, wrong sizes, missing files, direct symlinks, and parent-directory escapes.
It returns model identity and license provenance for later inference records.
Eleven verifier tests passed.
No production caller uses it yet.
The existing whisper.cpp startup path remains unchanged.

## Evaluation needed before selection

Representative images must include wide stages, small faces, multiple people, printed faces, slides, and camera transitions.
OCR evaluation must separate scripture, title, main point, subpoint, numbered point, and transition slides.
Audio evaluation must include speech over music, singing, applause, silence, noise, and reverberation.
Human labels must identify sermon edges and forbidden service regions.
No representative labeled P4 corpus was located in the repository.

Measure per-class recall, false detections, boundary error, and failures on each model version.
Measure wall time, CPU time, peak memory, model bytes, and processing cost per service hour.
Run vision only on selected representatives and OCR only on likely text frames.
Do not treat upstream benchmark scores as production budgets or sermon accuracy.
Record model, runtime, checksum, thresholds, dataset identity, and hardware with every evaluation.
The measured plan must select settings before production activation.

The local host has Tesseract 5.3.3.
Its inspected Python environment lacks OpenCV, ONNX Runtime, and TensorFlow.
That host inspection does not describe the deployed worker image.
No dependencies were installed during this review.

## Isolated OCR fixture — 2026-10-16

The pinned English data matched its recorded Git blob and 4113088-byte size.
The license and README bytes also matched their reviewed checksums.
The runtime model verifier accepted the temporary model for evaluation only.
Its SHA-256 is `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`.

Tesseract 5.3.3 reproduced both text lines from one generated 854×480 image.
The run used page segmentation mode 6 and OCR engine mode 1.
These settings describe this fixture only.
The run measured 320.3867319971323 ms wall time and 36032512 peak resident bytes.
Native measurements recorded 0.24 user CPU seconds and 0.03 system CPU seconds.
The host reported Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz, 12 logical CPUs, and 17179869184 memory bytes.

The [retained report](../evaluation/p4-ocr-fixture-2026-10-16.json) records model, image, font, runtime, and exact-text evidence.
The [experiment script](../scripts/evaluate-ocr-fixture.py) repeats the isolated experiment in a new output directory.
The script downloads only pinned public model and license files.
It removes temporary model bytes after the run.
Existing report directories cause refusal before downloads.

This single high-contrast image does not establish real slide accuracy, slide recall, or per-service runtime.
The test does not measure noisy footage, changing slides, multiple languages, or sparse-frame selection quality.
The candidate remains unapproved for production.
All 11 model-verification tests passed.
Script syntax and output overwrite checks passed.

## Boundary-ASR candidate and synthetic execution

The boundary sampler tested the same `base.en` checksum recorded in the existing caption benchmark.
This experiment does not change the caption-provider decision.
The [pinned conversion model card](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/README.md) identifies MIT licensing.
The [pinned upstream README](https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/README.md#license) explicitly includes model weights under MIT.
The [pinned whisper.cpp license](https://github.com/ggml-org/whisper.cpp/blob/f049fff95a089aa9969deb009cdd4892b3e74916/LICENSE) covers the runtime code.
The inventory records evidence checksums and the pinned Git LFS pointer.
Downloaded model bytes matched both the expected SHA-256 and the 147964211-byte size.

The real boundary adapter recognized all seven words in one synthetic speech window.
The window covered 4539 ms within a 6539 ms synthetic audio fixture.
The adapter retained native subword probabilities and source-time offsets.
The measured adapter process tree used 5644.497775938362 ms wall time and 297275392 peak resident bytes.
Those measurements include Node.js and media tools; they do not measure whisper.cpp alone.
Temporary model files were removed after execution.
The [retained report](../evaluation/p4-boundary-asr-fixture-2026-10-16.json) includes the native adapter evidence.

This fixture does not establish recognition accuracy for real sermon edges.
It does not select window sizes, thresholds, worker capacity, or per-service budgets.
Production approval remains false.

## YuNet public portrait experiment

The pinned YuNet 2023mar weights matched the expected SHA-256 and 232589-byte size.
The experiment rechecked both pinned license documents and the Git LFS pointer.
It used OpenCV 4.11.0.86 and NumPy 2.2.6 in a temporary environment.
The retained report includes downloaded wheel identities.
No production environment or model configuration changed.

The fixture uses the public-domain astronaut portrait documented by [scikit-image](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut).
The script pins its source revision and verifies image and license-evidence checksums.
It places three scaled versions inside separate 854×480 black images.
A fourth image contains only black pixels.
Portrait widths are 480, 128, and 64 pixels; these are not face widths.

At score threshold 0.9, YuNet detected one face in the largest portrait.
It detected no faces in either smaller portrait or the blank control.
The detected box measured 90.42628479003906×109.72215270996094 pixels.
Its native score was 0.942710816860199.
The [OpenCV output contract](https://docs.opencv.org/4.13.0/df/d20/classcv_1_1FaceDetectorYN.html) defines the retained boxes, landmarks, and scores.
The score does not establish calibrated confidence or identify a pastor.

The four inference calls measured 57.95165605377406, 33.333409926854074, 34.22209806740284, and 33.09109411202371 ms.
The complete Python process measured 34940.085108042695 ms wall time and 87883776 peak resident bytes.
Native measurements recorded 0.52 user CPU seconds and 0.23 system CPU seconds.
The process measurement includes imports, model loading, inference, and image output.
It does not establish worker startup time or per-service cost.

The [report](../evaluation/p4-yunet-fixture-2026-10-16.json) retains all detections, misses, input checksums, package identities, and measurements.
The [script](../scripts/evaluate-face-fixture.py) requires a new output directory and the exact evaluation package versions.
It removes temporary model bytes after execution.
The temporary package environment was also removed after this run.
All 11 model-verification tests passed.
Script syntax, output protection, and process success/failure checks passed.

The smaller-image misses require representative small-face testing before selection.
One portrait and one blank control do not establish recall or false-positive rates.
Printed faces, multiple people, changing cameras, and real stage footage remain untested.
Production approval remains false.

## YOLOX public portrait experiment

The pinned YOLOX_s 2022nov weights matched the expected SHA-256 and 35858002-byte size.
The experiment rechecked the pinned license documents and Git LFS pointer.
It used the existing model verifier before loading the weights.
It downloaded the pinned upstream decoder into the temporary model directory and verified its checksum before execution.
The [upstream decoder](https://raw.githubusercontent.com/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/object_detection_yolox/yolox.py) returns boxes, combined scores, and class identifiers.
The experiment retains all detections and counts class 0 as person.

The experiment used the same portrait fixtures as the YuNet evaluation.
It followed the [pinned demo preprocessing](https://raw.githubusercontent.com/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/object_detection_yolox/demo.py): RGB conversion, proportional resize, and 114-valued padding.
The model receives 640×640 pixels.
The report retains native coordinates and coordinates mapped back to each 854×480 fixture.
The script records the exact scaling ratio.

At combined-score threshold 0.5, YOLOX detected one person in the 480-pixel and 128-pixel portraits.
It missed the 64-pixel portrait and produced no detections on the blank control.
The native combined scores were 0.9428168535232544 and 0.8114191889762878.
These portrait sizes are not person bounding-box sizes.
The pinned decoder does not apply its `objThreshold` argument separately.
The report states this behavior explicitly.

The four measured calls took 1238.8045620173216, 925.5556900752708, 920.3395129879937, and 948.4506560256705 ms.
These measurements include image preprocessing, inference, and result validation.
The complete process measured 42482.302612042986 ms wall time and 363274240 peak resident bytes.
Native measurements recorded 4.22 user CPU seconds and 0.43 system CPU seconds.
The complete process includes imports, model loading, inference, and image output.
It does not establish worker startup time or per-service cost.

The [report](../evaluation/p4-yolox-fixture-2026-10-16.json) retains detections, misses, model identity, helper identity, package identities, and resource measurements.
Run the [experiment script](../scripts/evaluate-face-fixture.py) with `--detector person` and a new `--output` directory.
The exact evaluation dependencies remain OpenCV 4.11.0.86 and NumPy 2.2.6.
Temporary model files, decoder code, and the isolated package environment were removed after execution.
Script syntax, output protection, detector selection, and child success/failure checks passed.

The observations support further evaluation, not production selection.
One portrait cannot establish performance on stages, multiple people, or slide images.
A detected person does not establish a pastor, sermon content, or live camera footage.
The smallest-image miss requires representative small-person testing.
Production approval remains false.

## YAMNet identity and blocked inference — 2026-10-16

The weights URL now pins Google Cloud Storage generation `1574101619169609`.
The downloaded bytes matched the provider MD5 and the 15296092-byte size.
Their SHA-256 is `13c3308955bbfaef262f175ac9c40e47b134573a93984f009220dd7cc12a1744`.
That SHA-256 is a local computation, not an upstream published value.
The [object report](../evaluation/p4-yamnet-object-identity-2026-10-16.json) retains the provider metadata.
The [source report](../evaluation/p4-yamnet-source-identity-2026-10-16.json) pins model code, preprocessing, parameters, class names, and upstream tests.

The pinned `yamnet.py` imports `tf_keras`.
The experiment therefore requires `tensorflow==2.15.1`, `tf-keras==2.15.1`, `numpy==1.26.4`, and `h5py==3.10.0`.
PyPI publishes CPython 3.9 macOS x86_64 wheels for each pinned package.
The TensorFlow wheel alone measures 236437643 bytes.

The [experiment script](../scripts/evaluate-audio-event-fixture.py) verifies the README, source files, model checksum, MD5, and byte count.
It runs `verifyLocalModel()` before loading weights.
It rechecks source and model bytes inside the worker before import.
Fixtures repeat the three upstream tests: silence, seeded noise, and a 440 Hz sine wave.
It adds one synthetic speech clip and the same speech over three steady tones.
The report retains top classes, named-class scores, per-frame speech, music, and silence scores, and score-matrix checksums.
It also retains process CPU time, wall time, and peak resident memory.

The first installation attempt stopped because free disk fell to about 2.6 GiB.
The script refused an existing output directory and missing pinned packages.

## YAMNet synthetic experiment — 2026-10-16

The second attempt ran with 7.1 GiB free disk.
The python.org Python 3.9 venv shipped pip 20.2.3.
That pip version produced no matching macOS 26 wheel tags, so the venv upgraded to pip 24.2.
The python.org build also lacked a CA bundle.
The run set `SSL_CERT_FILE` to the venv's `certifi` bundle; TLS verification stayed enabled.
`verifyLocalModel()` accepted the weights for evaluation before loading.

| Fixture | Frames | Top class (clip mean) | Speech | Music | Silence |
|---|---:|---|---:|---:|---:|
| silence | 6 | Silence 1.0 | 0.0 | 0.0 | 1.0 |
| seeded-uniform-noise | 6 | White noise 0.361 | 0.022 | 0.011 | 0.01 |
| sine-440hz | 6 | Telephone 0.996 | 0.001 | 0.0 | 0.0 |
| synthetic-speech | 9 | Speech 0.994 | 0.994 | 0.0 | 0.0 |
| synthetic-speech-over-steady-tones | 9 | Music 0.144 | 0.08 | 0.144 | 0.002 |

All three upstream expectations appeared in the top 10 classes.
`Sine wave` was present but not first for the 440 Hz tone.
Clean synthetic speech scored 0.994 for Speech.
The same speech over three steady tones scored 0.08 for Speech.
Only two of nine frames had Speech as the top class.
This result is a risk signal for speech over worship music, not a measured recall.
Representative speech-over-music audio must be tested before any Speech threshold is chosen.

Model loading took 1287.1824650000008 ms.
Each inference took between 93.8 and 159.9 ms.
The complete process took 86324.58513 ms wall time, 9.14 user CPU seconds, and 1.92 system CPU seconds.
Peak resident memory measured 373616640 bytes.
The process measurement includes TensorFlow import, speech synthesis, model loading, and five inferences.
It does not establish worker startup time or per-service cost.

The [report](../evaluation/p4-yamnet-fixture-2026-10-16.json) retains top classes, named scores, per-frame scores, and checksums.
The venv, weights, source files, and run directories were removed after the experiment.
Production approval remains false.

Run the experiment with Python 3.9 and the pinned packages in a temporary environment:

```bash
python scripts/evaluate-audio-event-fixture.py --output <new-directory>
```

Synthetic fixtures cannot establish speech-over-music recall or church-audio accuracy.
Sound-event labels do not identify sermon, worship, prayer, or announcement regions.
Production approval remains false.
