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
	# the latest published release; never a prerelease or a draft
	API="https://api.github.com/repos/$REPO/releases/latest"
fi

step "Finding the latest OpenCursor release"
RELEASE=$(curl -fsSL -H "Accept: application/vnd.github+json" "$API") || fail "could not reach GitHub"
TAG=$(printf '%s' "$RELEASE" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
tag_of() { case "$1" in */download/*/*) printf '%s' "$1" | sed 's|.*/download/\([^/]*\)/.*|\1|' ;; *) printf '%s' "$TAG" ;; esac; }

# The download URL of the first asset whose name ends in $1.
asset() {
	printf '%s' "$RELEASE" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"$/\1/' | grep -- "$1\$" | head -1
}

TMP=$(mktemp -d)
MOUNT=""
# also runs when a step fails: never leave the disk image mounted or the download behind
cleanup() {
	[ -z "$MOUNT" ] || hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || true
	rm -rf "$TMP"
}
trap cleanup EXIT

# The sha256 GitHub computed for the asset at URL $1, if the API gave one. In the API's asset
# objects the digest comes before the download URL; no braces sit between them.
digest_of() {
	printf '%s' "$RELEASE" | tr -d '\n' | grep -o "\"digest\": *\"sha256:[0-9a-fA-F]*\"[^{}]*\"browser_download_url\": *\"$1\"" | head -1 | sed 's/.*sha256:\([0-9a-fA-F]*\)".*/\1/'
}

sha_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

download() {
	TAG=$(tag_of "$1")
	say "Downloading $(basename "$1")"
	curl -fL --progress-bar -o "$TMP/$2" "$1" || fail "download failed"
	WANT=$(digest_of "$1" | tr 'A-F' 'a-f')
	if [ -n "$WANT" ]; then
		[ "$(sha_of "$TMP/$2" | tr 'A-F' 'a-f')" = "$WANT" ] || fail "the download does not match the checksum GitHub published"
	fi
}

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

if [ "$OS" = macos ]; then
	URL=$(asset "-macos-$ARCH.dmg")
	[ -n "$URL" ] || fail "no OpenCursor release has a build for macOS ($ARCH) yet"
	download "$URL" OpenCursor.dmg

	step "Installing"
	DEST="${OPENCURSOR_DIR:-/Applications}"
	if [ ! -w "$DEST" ] && [ -z "${OPENCURSOR_DIR:-}" ]; then DEST="$HOME/Applications"; fi
	mkdir -p "$DEST"
	# attach into our own folder, so the mount point is known even when hdiutil prints several /Volumes lines
	MOUNT="$TMP/mount"
	mkdir -p "$MOUNT"
	hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MOUNT" "$TMP/OpenCursor.dmg" >/dev/null || { MOUNT=""; fail "could not open the disk image"; }
	[ -d "$MOUNT/OpenCursor.app" ] || fail "the disk image has no OpenCursor.app"
	# copy first, swap after: a failed copy leaves the app that is already installed untouched
	rm -rf "$DEST/OpenCursor.app.new"
	ditto "$MOUNT/OpenCursor.app" "$DEST/OpenCursor.app.new" || { rm -rf "$DEST/OpenCursor.app.new"; fail "could not copy the app to $DEST"; }
	rm -rf "$DEST/OpenCursor.app"
	mv "$DEST/OpenCursor.app.new" "$DEST/OpenCursor.app" || fail "could not move the app into place"
	hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 && MOUNT=""

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
	[ -n "$URL" ] || fail "no OpenCursor release has a build for Linux ($ARCH) yet"
	download "$URL" opencursor.tar.gz
	step "Installing to ~/.local/share/opencursor"
	ROOT="$HOME/.local/share/opencursor"
	mkdir -p "$HOME/.local/share" "$HOME/.local/bin"
	rm -rf "$ROOT.new" && mkdir -p "$ROOT.new"
	tar -xzf "$TMP/opencursor.tar.gz" -C "$ROOT.new" --strip-components=1 || { rm -rf "$ROOT.new"; fail "could not unpack the download"; }
	[ -x "$ROOT.new/bin/open-cursor" ] || { rm -rf "$ROOT.new"; fail "the download has no bin/open-cursor"; }
	rm -rf "$ROOT" && mv "$ROOT.new" "$ROOT"
	ln -sf "$ROOT/bin/open-cursor" "$HOME/.local/bin/open-cursor"
	WHERE="a terminal: open-cursor (make sure ~/.local/bin is on your PATH)"
fi

say ""
say "OpenCursor $TAG is installed. Start it from $WHERE"
