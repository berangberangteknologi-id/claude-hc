#!/usr/bin/env bash
# Plays the Hermes side of the contract against real Claude:
# launch in the background, wait, parse the last line, answer with -r.
# Skipped unless CLAUDE_HC_E2E=1 (needs a logged-in Claude Code install and jq).
set -euo pipefail

if [ "${CLAUDE_HC_E2E:-}" != "1" ]; then
  echo "hermes-sim: skipped (set CLAUDE_HC_E2E=1 to run against real Claude)"
  exit 0
fi
command -v jq >/dev/null || { echo "hermes-sim: jq is required" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="node $ROOT/dist/claude-hc.js"
WORK="$(mktemp -d)"
export CLAUDE_HC_HOME="$WORK/home"
mkdir -p "$WORK/repo/.claude-hc"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "hermes-sim: FAIL: $*" >&2; exit 1; }

# Turn 1: force a clarifying question.
cat > "$WORK/repo/.claude-hc/prompt.txt" <<'EOF'
Before doing anything else, ask me exactly one clarifying question with the
AskUserQuestion tool: which color I prefer, with the options "Red" and "Blue".
Do not answer on my behalf and do not do anything else.
EOF

$BIN --json --cwd "$WORK/repo" --allowed-tools Read < "$WORK/repo/.claude-hc/prompt.txt" > "$WORK/out1.txt" 2> "$WORK/err1.txt" &
PID=$!
wait "$PID" && CODE=0 || CODE=$?
LINE="$(tail -n 1 "$WORK/out1.txt")"
echo "turn 1: exit=$CODE line=$LINE"
[ "$CODE" = "0" ] || fail "turn 1 exit code $CODE"
[ "$(echo "$LINE" | jq -r .status)" = "needs_input" ] || fail "turn 1 status"
[ "$(echo "$LINE" | jq '.questions | length')" -ge 1 ] || fail "turn 1 has no questions"
SESSION="$(echo "$LINE" | jq -r .session_id)"
RESULT_FILE="$(echo "$LINE" | jq -r .result_file)"
[ -f "$RESULT_FILE" ] || fail "result file missing: $RESULT_FILE"
[ "$(jq -r .status "$CLAUDE_HC_HOME/sessions/$SESSION/latest.json")" = "needs_input" ] || fail "latest.json status"
[ "$(echo "$LINE" | jq -c 'keys_unsorted')" = '["claude_hc","status","turn","summary","questions","result_subtype","exit_code","error","session_id","result_file"]' ] || fail "key order"

# status: nothing in flight between turns.
STATUS="$($BIN status "$SESSION")"
[ "$(echo "$STATUS" | jq -r .in_flight)" = "false" ] || fail "status in_flight"

# Turn 2: answer.
HEADER="$(echo "$LINE" | jq -r '.questions[0].header')"
QUESTION="$(echo "$LINE" | jq -r '.questions[0].question')"
cat > "$WORK/repo/.claude-hc/prompt.txt" <<EOF
Answers from the user:
[$HEADER] $QUESTION -> Red
Now reply with exactly the sentence: You chose Red.
EOF

$BIN --json --cwd "$WORK/repo" --allowed-tools Read -r "$SESSION" < "$WORK/repo/.claude-hc/prompt.txt" > "$WORK/out2.txt" 2> "$WORK/err2.txt" &
PID=$!
wait "$PID" && CODE=0 || CODE=$?
LINE2="$(tail -n 1 "$WORK/out2.txt")"
echo "turn 2: exit=$CODE line=$LINE2"
[ "$CODE" = "0" ] || fail "turn 2 exit code $CODE"
[ "$(echo "$LINE2" | jq -r .status)" = "done" ] || fail "turn 2 status"
[ "$(echo "$LINE2" | jq -r .turn)" = "2" ] || fail "turn 2 number"
[ "$(echo "$LINE2" | jq -r .session_id)" = "$SESSION" ] || fail "turn 2 session id"
[ -f "$CLAUDE_HC_HOME/sessions/$SESSION/turn-0002.json" ] || fail "turn-0002.json missing"
[ ! -f "$CLAUDE_HC_HOME/sessions/$SESSION/lock" ] || fail "lock left behind"

echo "hermes-sim: PASS (session $SESSION)"
