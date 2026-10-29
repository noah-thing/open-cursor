#!/bin/zsh
# Runs every scenario against the real app. Scenarios that only click through the UI run several
# at a time, each with its own copy of the test profile; the ones that wait on a model run one at a
# time so they do not queue behind each other on the local model.
# Usage: scripts/open-cursor/test-all.sh [parallel jobs, default 3]
cd "${0:A:h}/../.."
source ~/oc-env.sh 2>/dev/null
jobs_max=${1:-3}
model=(agent checkpoint cmdk tab terminal help-flow)
ui=()
for f in scripts/open-cursor/scenarios/*.mjs; do
	s=${f:t:r}
	[[ $s == (holo|scroll-free) ]] && continue
	(( ${model[(Ie)$s]} )) || ui+=$s
done
run() {
	local s=$1 ud=~/.oc-test/run-$1
	rm -rf $ud ~/oc-shots/pass-$s; cp -R ~/.oc-test/user-data $ud
	local out; out=$(OC_USER_DATA=$ud OC_SHOTS=~/oc-shots/pass-$s node scripts/open-cursor/drive.mjs scripts/open-cursor/scenarios/$s.mjs 2>&1)
	if print -r -- "$out" | grep -q "scenario failed"; then
		print "FAIL $s: $(print -r -- "$out" | grep -A1 "scenario failed" | head -2 | tr "\n" " " | cut -c1-180)"
	else
		print "ok   $s  console errors: $(grep -c "^\[error\]" ~/oc-shots/pass-$s/console.log 2>/dev/null || print 0)"
	fi
	rm -rf $ud
}
start=$SECONDS
for s in $ui; do
	while (( $(jobs -r | wc -l) >= jobs_max )); do sleep 0.3; done
	run $s &
done
for s in $model; do run $s; done
wait
print "done in $(( SECONDS - start ))s"
