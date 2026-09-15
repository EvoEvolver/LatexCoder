#!/bin/sh
set -eu

version="0.17.0"
state_dir="${LATEXCODER_STATE_DIR:-${PAPER_STATE_DIR:-$PWD/.latexcoder}}"
bin_dir="$state_dir/bin"
target="$bin_dir/tectonic"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    platform="x86_64-unknown-linux-musl"
    checksum="8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7"
    ;;
  Linux-aarch64)
    platform="aarch64-unknown-linux-musl"
    checksum="b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8"
    ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

archive="tectonic-$version-$platform.tar.gz"
url="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40$version/$archive"
temporary_dir=$(mktemp -d)
trap 'rm -rf "$temporary_dir"' EXIT

mkdir -p "$bin_dir"
curl -fL "$url" -o "$temporary_dir/$archive"
printf '%s  %s\n' "$checksum" "$temporary_dir/$archive" | sha256sum -c -
tar --no-same-owner -xzf "$temporary_dir/$archive" -C "$temporary_dir"
install -m 0755 "$temporary_dir/tectonic" "$target"
"$target" --help >/dev/null
printf 'Installed Tectonic %s at %s\n' "$version" "$target"
