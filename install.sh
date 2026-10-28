#!/bin/sh
# OpenCursor installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/noah-thing/open-cursor/main/install.sh | sh
#
# Options (environment variables):
#   OPENCURSOR_VERSION   install a specific release tag, e.g. v0.1.0 (default: latest)
#   OPENCURSOR_DIR       where the macOS app goes (default: /Applications, or ~/Applications)

set -eu

REPO="noah-thing/open-cursor"

say() { printf '%s\n' "$*"; }
step() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"

case "$(uname -s)" in
	Darwin) OS=macos ;;
	Linux) OS=linux ;;
	*) fail "this script is for macOS and Linux; on Windows run install.ps1" ;;
esac

case "$(uname -m)" in
	arm64 | aarch64) ARCH=arm64 ;;
	x86_64 | amd64) ARCH=x64 ;;
	*) fail "unsupported processor: $(uname -m)" ;;
esac

if [ -n "${OPENCURSOR_VERSION:-}" ]; then
	API="https://api.github.com/repos/$REPO/releases/tags/$OPENCURSOR_VERSION"
else
	API="https://api.github.com/repos/$REPO/releases/latest"
fi

step "Finding the latest OpenCursor release"
RELEASE=$(curl -fsSL -H "Accept: application/vnd.github+json" "$API") || fail "could not reach GitHub"
TAG=$(printf '%s' "$RELEASE" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')

# The download URL of the first asset whose name ends in $1.
asset() {
	printf '%s' "$RELEASE" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"$/\1/' | grep -- "$1\$" | head -1
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

download() {
	say "Downloading $(basename "$1")"
	curl -fL --progress-bar -o "$TMP/$2" "$1" || fail "download failed"
}

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

if [ "$OS" = macos ]; then
	URL=$(asset "-macos-$ARCH.dmg")
	[ -n "$URL" ] || fail "release $TAG has no build for macOS ($ARCH)"
	download "$URL" OpenCursor.dmg

	step "Installing"
	DEST="${OPENCURSOR_DIR:-/Applications}"
	if [ ! -w "$DEST" ] && [ -z "${OPENCURSOR_DIR:-}" ]; then DEST="$HOME/Applications"; fi
	mkdir -p "$DEST"
	MOUNT=$(hdiutil attach -nobrowse -readonly "$TMP/OpenCursor.dmg" | awk -F'\t' '/\/Volumes\//{print $NF}')
	[ -d "$MOUNT/OpenCursor.app" ] || { hdiutil detach -quiet "$MOUNT" 2>/dev/null; fail "the disk image has no OpenCursor.app"; }
	rm -rf "$DEST/OpenCursor.app"
	ditto "$MOUNT/OpenCursor.app" "$DEST/OpenCursor.app"
	hdiutil detach -quiet "$MOUNT"

	say ""
	say "OpenCursor $TAG is installed in $DEST."
	say "Open it from Launchpad or run: open -a OpenCursor"
	exit 0
fi

# Linux: a native package where the system has a package manager for it, otherwise a portable copy.
if command -v apt-get >/dev/null 2>&1 && URL=$(asset "-linux-$ARCH.deb") && [ -n "$URL" ]; then
	download "$URL" opencursor.deb
	step "Installing with apt (you may be asked for your password)"
	$SUDO apt-get install -y "$TMP/opencursor.deb"
	WHERE="the applications menu, or run: open-cursor"
elif { command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; } && URL=$(asset "-linux-$ARCH.rpm") && [ -n "$URL" ]; then
	download "$URL" opencursor.rpm
	step "Installing the package (you may be asked for your password)"
	if command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y "$TMP/opencursor.rpm"; else $SUDO zypper --non-interactive install --allow-unsigned-rpm "$TMP/opencursor.rpm"; fi
	WHERE="the applications menu, or run: open-cursor"
else
	URL=$(asset "-linux-$ARCH.tar.gz")
	[ -n "$URL" ] || fail "release $TAG has no build for Linux ($ARCH)"
	download "$URL" opencursor.tar.gz
	step "Installing to ~/.local/share/opencursor"
	ROOT="$HOME/.local/share/opencursor"
	rm -rf "$ROOT" && mkdir -p "$ROOT" "$HOME/.local/bin"
	tar -xzf "$TMP/opencursor.tar.gz" -C "$ROOT" --strip-components=1
	ln -sf "$ROOT/bin/open-cursor" "$HOME/.local/bin/open-cursor"
	WHERE="a terminal: open-cursor (make sure ~/.local/bin is on your PATH)"
fi

say ""
say "OpenCursor $TAG is installed. Start it from $WHERE"
