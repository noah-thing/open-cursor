#!/bin/sh
# Writes a GitHub release JSON for the files in a directory, pointing at https://mock.invalid/<name>.
# Usage: mock-release.sh <dir> [grep -E pattern of file names to leave out]
DIR="$1"; SKIP="${2:-^$}"
printf '{"tag_name": "v0.1.0", "assets": ['
first=1
for f in "$DIR"/*; do
	n=$(basename "$f")
	printf '%s' "$n" | grep -Eq "$SKIP" && continue
	[ $first = 1 ] || printf ','
	first=0
	printf '{"name": "%s", "browser_download_url": "https://mock.invalid/%s"}' "$n" "$n"
done
printf ']}\n'
