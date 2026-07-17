#!/bin/sh
# Ensures the whisper.cpp ggml model exists at WHISPER_MODEL_PATH (expected on a mounted
# volume, so it survives redeploys) before handing off to the worker command:
#   - downloads it once, with up to 3 attempts and backoff
#   - verifies SHA-256 (built-in checksum for the default model; set WHISPER_MODEL_SHA256
#     when overriding WHISPER_MODEL_URL)
#   - re-verifies an existing on-disk copy on every boot and re-downloads if corrupted
# See docs/DEPLOYMENT.md ("Railway Service Configuration" / "Worker Operations").
set -eu

DEFAULT_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
# SHA-256 of the pinned upstream ggml-base.en.bin (computed from the file itself).
DEFAULT_MODEL_SHA256="a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"

verify_model() {
  # $1 = file path. Succeeds when no checksum is enforced or the checksum matches.
  if [ -z "$expected_sha" ]; then
    return 0
  fi
  actual_sha=$(sha256sum "$1" | awk '{print $1}')
  if [ "$actual_sha" = "$expected_sha" ]; then
    return 0
  fi
  echo "checksum mismatch for $1: expected $expected_sha, got $actual_sha" >&2
  return 1
}

if [ -n "${WHISPER_MODEL_PATH:-}" ]; then
  model_url="${WHISPER_MODEL_URL:-$DEFAULT_MODEL_URL}"
  if [ "$model_url" = "$DEFAULT_MODEL_URL" ]; then
    expected_sha="${WHISPER_MODEL_SHA256:-$DEFAULT_MODEL_SHA256}"
  else
    expected_sha="${WHISPER_MODEL_SHA256:-}"
    if [ -z "$expected_sha" ]; then
      echo "WARNING: custom WHISPER_MODEL_URL without WHISPER_MODEL_SHA256 — the download cannot be integrity-checked" >&2
    fi
  fi

  if [ -f "$WHISPER_MODEL_PATH" ] && ! verify_model "$WHISPER_MODEL_PATH"; then
    echo "existing model at $WHISPER_MODEL_PATH is corrupted — deleting and re-downloading" >&2
    rm -f "$WHISPER_MODEL_PATH"
  fi

  if [ ! -f "$WHISPER_MODEL_PATH" ]; then
    mkdir -p "$(dirname "$WHISPER_MODEL_PATH")"
    attempt=1
    while :; do
      echo "whisper model missing at $WHISPER_MODEL_PATH — downloading (attempt $attempt/3) from $model_url"
      if curl -fL --retry 2 --connect-timeout 30 "$model_url" -o "$WHISPER_MODEL_PATH.tmp" \
        && verify_model "$WHISPER_MODEL_PATH.tmp"; then
        mv "$WHISPER_MODEL_PATH.tmp" "$WHISPER_MODEL_PATH"
        echo "whisper model ready at $WHISPER_MODEL_PATH"
        break
      fi
      rm -f "$WHISPER_MODEL_PATH.tmp"
      if [ "$attempt" -ge 3 ]; then
        echo "ERROR: failed to download a valid whisper model after 3 attempts" >&2
        exit 1
      fi
      attempt=$((attempt + 1))
      sleep $((attempt * 5))
    done
  fi
fi

exec "$@"
