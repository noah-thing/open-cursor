#!/bin/sh
# Stand-in for curl in the installer smoke tests. install.sh is run unchanged; this answers the
# GitHub API call with $MOCK_RELEASE_JSON and serves downloads from $MOCK_ASSET_DIR.
out=""; url=""
while [ $# -gt 0 ]; do
	case "$1" in
		-o) out="$2"; shift ;;
		-H) shift ;;
		http*) url="$1" ;;
	esac
	shift
done
case "$url" in
	https://api.github.com/*) cat "$MOCK_RELEASE_JSON" ;;
	https://mock.invalid/*)
		f="$MOCK_ASSET_DIR/$(basename "$url")"
		[ -f "$f" ] || { echo "mock: no such asset $f" >&2; exit 22; }
		if [ -n "$out" ]; then cp "$f" "$out"; else cat "$f"; fi ;;
	*) echo "mock: unexpected url $url" >&2; exit 1 ;;
esac
