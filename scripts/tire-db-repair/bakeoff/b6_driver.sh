#!/bin/bash
# Task B6 overnight driver: sequential Codex batches with apply + log between each.
# Usage: b6_driver.sh <firstBatch> <lastBatch>
# Stops dispatching new batches after the cutoff time (06:10 local) to leave margin
# before the 06:30 hard stop; every completed batch is applied and logged independently.
set -u
FIRST=$1
LAST=$2
CUTOFF_HHMM="0610"
REPO="C:/Users/djsan/inventory"
B6DIR="$REPO/backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/bakeoff/b6"
LOG="$REPO/.superpowers/sdd/2026-07-28-tire-db-repair-enrichment-bakeoff/b6-batches.log"
COMPANION="C:/Users/djsan/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs"

cd "$REPO"

for N in $(seq "$FIRST" "$LAST"); do
  NOW=$(date +"%H%M")
  if [ "$NOW" -ge "$CUTOFF_HHMM" ] && [ "$NOW" -lt "2000" ]; then
    echo "CUTOFF reached at $(date +%H:%M) - not dispatching batch $N" | tee -a "$LOG"
    break
  fi
  if [ ! -f "$B6DIR/batch_${N}_input.json" ]; then
    echo "batch $N input missing - stopping" | tee -a "$LOG"
    break
  fi
  START_TS=$(date +%s)
  START_HM=$(date +"%H:%M")
  echo "=== dispatching batch $N at $START_HM ==="
  PROMPT=$(/c/tmp/b6_make_prompt.sh "$N")
  node "$COMPANION" task --write "$PROMPT" > "/c/tmp/b6_batch${N}_codex_output.log" 2>&1
  CODEX_EXIT=$?
  END_TS=$(date +%s)
  DUR_MIN=$(( (END_TS - START_TS) / 60 ))
  if [ ! -f "$B6DIR/batch_${N}_results.json" ]; then
    echo "batch $N | dispatch FAILED (codex exit $CODEX_EXIT, no results file) | ${DUR_MIN} min | see /c/tmp/b6_batch${N}_codex_output.log" >> "$LOG"
    # One retry for transient failures, then stop the driver for manual triage.
    echo "retrying batch $N once..."
    node "$COMPANION" task --write "$PROMPT" > "/c/tmp/b6_batch${N}_codex_retry.log" 2>&1
    if [ ! -f "$B6DIR/batch_${N}_results.json" ]; then
      echo "batch $N | retry FAILED - driver stopping for manual triage" >> "$LOG"
      break
    fi
  fi
  APPLY_OUT=$(node scripts/tire-db-repair/bakeoff/b6_apply_enrichment.mjs \
    --batch "$B6DIR/batch_${N}_results.json" \
    --input "$B6DIR/batch_${N}_input.json" 2>&1)
  ROWS_IN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$B6DIR/batch_${N}_input.json','utf8')).length)")
  APPLIED=$(echo "$APPLY_OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.appliedCount+' fills ('+Object.entries(j.perFieldFillCount).filter(([k,v])=>v>0).map(([k,v])=>v+' '+k).join(', ')+') | review '+j.reviewCount)}catch(e){console.log('apply-parse-error')}})")
  echo "batch $N | $ROWS_IN rows in | $APPLIED | ${DUR_MIN} min ($START_HM-$(date +%H:%M))" >> "$LOG"
  echo "=== batch $N done: $APPLIED ==="
done
echo "driver finished at $(date +%H:%M)"
