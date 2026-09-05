#!/usr/bin/env bash
# Settles whether renaming the first family of a caption preset changes the rendered file.
#
# `clean`, `karaoke` and `quiet` ask for `Inter`; `bold-serif` asks for `Georgia`. Neither family
# is shipped, so libass substitutes. The question is whether naming the bundled family instead
# produces a byte-identical frame — if it does, the head of each stack can be renamed and no
# approved clip moves.
#
# The comparison has to happen inside the built worker image. On a developer machine libass reads
# the system fontconfig and substitutes a macOS face, which proves nothing about production.
#
# Only the ASS `Fontname` differs between the two runs. For these four presets nothing else in the
# pipeline reads the first family: `activeWordHighlight` is false, so `render-plan.ts` never calls
# `createCaptionMeasurer`, and the whole-run caption path emits the same geometry either way.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-sermon-clipper-worker:caption-face-probe}"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/tmp/caption-face-probe}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop and run this again." >&2
  exit 1
fi

echo "==> Building the worker image (${IMAGE_TAG})"
docker build -f "${REPO_ROOT}/Dockerfile.worker" -t "${IMAGE_TAG}" "${REPO_ROOT}"

mkdir -p "${OUT_DIR}"
rm -f "${OUT_DIR}"/*.png "${OUT_DIR}"/*.md5 "${OUT_DIR}"/*.ass "${OUT_DIR}"/fc-match.txt 2>/dev/null || true

echo "==> Rendering inside the image"
docker run --rm --entrypoint /bin/sh -v "${OUT_DIR}:/out" "${IMAGE_TAG}" -s <<'PROBE'
set -eu

# The caption line the frames carry. Mixed case and a descender, so a serif substitution shows.
TEXT='Peace is not the absence of the storm.'
WIDTH=1080
HEIGHT=1920
SIZE=44

# Header copied from src/lib/export/ass-generator.ts. Only $1, the Fontname, varies between runs.
write_ass() {
  cat > "/tmp/$2.ass" <<ASS
[Script Info]
ScriptType: v4.00+
PlayResX: ${WIDTH}
PlayResY: ${HEIGHT}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,$1,${SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,54,54,220,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,${TEXT}
ASS
}

render() { # $1 = Fontname, $2 = slug
  write_ass "$1" "$2"
  # No video codec in the path: the burn goes straight to raw RGB frame hashes, so a difference
  # in the hash is a difference in the drawn pixels and nothing else.
  ffmpeg -nostdin -v error -y \
    -f lavfi -i "color=c=0x111827:s=${WIDTH}x${HEIGHT}:r=30:d=1" \
    -vf "subtitles=/tmp/$2.ass" -pix_fmt rgb24 -f framemd5 "/out/$2.md5"
  ffmpeg -nostdin -v error -y \
    -f lavfi -i "color=c=0x111827:s=${WIDTH}x${HEIGHT}:r=30:d=1" \
    -vf "subtitles=/tmp/$2.ass" -frames:v 1 "/out/$2.png"
  cp "/tmp/$2.ass" "/out/$2.ass"
}

# What fontconfig actually resolves each name to, which explains whatever the frames show.
{
  for family in "Inter" "DejaVu Sans" "Georgia" "DejaVu Serif"; do
    printf '%-14s -> %s  [%s]\n' "$family" \
      "$(fc-match "$family" --format '%{family}')" \
      "$(fc-match "$family" --format '%{file}')"
  done
} | tee /out/fc-match.txt

render "Inter" "inter"
render "DejaVu Sans" "dejavu-sans"
render "Georgia" "georgia"
render "DejaVu Serif" "dejavu-serif"

echo
compare() { # $1 = named family, $2 = bundled family, $3/$4 = slugs, $5 = which presets
  if cmp -s "/out/$3.md5" "/out/$4.md5"; then
    echo "IDENTICAL   $1 == $2   ($5 may be renamed)"
  else
    echo "DIFFERENT   $1 != $2   ($5 stay frozen)"
  fi
}
compare "Inter" "DejaVu Sans" "inter" "dejavu-sans" "clean, karaoke, quiet"
compare "Georgia" "DejaVu Serif" "georgia" "dejavu-serif" "bold-serif"
PROBE

echo
echo "==> Frames and hashes are in ${OUT_DIR}"
ls -1 "${OUT_DIR}"
