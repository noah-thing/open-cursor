#!/bin/sh
# Attaches files to a release, draft or published, replacing any file with the same name.
# Usage: upload-draft.sh <tag> <file>...   (needs GH_TOKEN and GITHUB_REPOSITORY)
set -e
TAG="$1"; shift
REL="$(gh api "repos/$GITHUB_REPOSITORY/releases" --paginate --jq ".[] | select(.tag_name==\"$TAG\") | [.id, .draft] | @tsv" | head -1)"
ID="$(echo "$REL" | cut -f1)"; DRAFT="$(echo "$REL" | cut -f2)"
[ -n "$ID" ] || { echo "no release for $TAG"; exit 1; }
# a published release takes files too: its Mac build can go out first, the others join as they finish
for f in "$@"; do
	name="$(basename "$f")"
	old="$(gh api "repos/$GITHUB_REPOSITORY/releases/$ID/assets" --paginate --jq ".[] | select(.name==\"$name\") | .id")"
	[ -z "$old" ] || gh api -X DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$old"
	curl -fsS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/octet-stream" \
		--data-binary "@$f" "https://uploads.github.com/repos/$GITHUB_REPOSITORY/releases/$ID/assets?name=$name" >/dev/null
	echo "attached $name"
done
