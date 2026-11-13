#!/usr/bin/env bash
# Install a current ffmpeg (7 or newer) on Linux into /usr/local/bin.
# Ubuntu 24.04's own package is ffmpeg 6, which the video skill refuses. This fetches a static build from the
# FFmpeg-Builds project on GitHub (the builds linked from ffmpeg.org) and leaves the system package alone;
# /usr/local/bin comes first on the PATH, so the new one is used.
#
#   bash scripts/install-ffmpeg-linux.sh
set -euo pipefail

have=$(ffmpeg -version 2>/dev/null | sed -n '1s/^ffmpeg version n\{0,1\}\([0-9][0-9]*\)\..*/\1/p' || true)
if [ -n "$have" ] && [ "$have" -ge 7 ]; then echo "ffmpeg $have is already installed: $(command -v ffmpeg)"; exit 0; fi

case "$(uname -m)" in
  x86_64) arch=linux64 ;;
  aarch64|arm64) arch=linuxarm64 ;;
  *) echo "Unsupported processor: $(uname -m)" >&2; exit 1 ;;
esac

echo "==> Finding a current ffmpeg build for $arch"
# Release branches change over time (8.1, 9.0, …), so ask GitHub what exists and take the oldest stable branch that is 7 or newer.
url=$(curl -fsSL https://api.github.com/repos/FFmpeg-Builds/FFmpeg-Builds/releases/tags/latest | ARCH="$arch" python3 -c '
import json, os, re, sys
arch = os.environ["ARCH"]
found = []
for a in json.load(sys.stdin).get("assets", []):
    m = re.fullmatch(r"ffmpeg-n(\d+)\.(\d+)-latest-%s-gpl-[\d.]+\.tar\.xz" % arch, a["name"])
    if m and int(m.group(1)) >= 7: found.append(((int(m.group(1)), int(m.group(2))), a["browser_download_url"]))
print(sorted(found)[0][1] if found else "")')
[ -n "$url" ] || { echo "Could not find an ffmpeg build to download. See https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "==> Downloading $url"
curl -fL --progress-bar "$url" -o "$tmp/ffmpeg.tar.xz"
tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp"
bin=$(find "$tmp" -type d -name bin | head -1)
[ -x "$bin/ffmpeg" ] || { echo "The download did not contain ffmpeg." >&2; exit 1; }
sudo install -m 755 "$bin/ffmpeg" "$bin/ffprobe" /usr/local/bin/

hash -r
echo "==> Installed: $(/usr/local/bin/ffmpeg -version | head -1)"
echo "Restart the app so it picks this up:  sudo systemctl restart video-autopilot"
