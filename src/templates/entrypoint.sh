#!/bin/bash
set -euo pipefail

OWNER="$1"
REPO="$2"
FULL_REPO="$3"
PR_NUMBER="$4"
SHA="$5"
RUN_ID="$6"
BASE_BRANCH="$7"
HEAD_BRANCH="$8"

export PATH="/root/.opencode/bin:/root/.local/bin:$PATH"

WORKSPACE="/workspace"
REVIEW_DIR="/workspace/review"
ERRORS_FILE="/workspace/errors.log"
LOG_FILE="/workspace/review-output.log"
> "$ERRORS_FILE"
: > "$LOG_FILE"

START_TIME=$(date +%s)

# Timestamped logger: writes "[HH:MM:SS +12.3s] [entrypoint] <msg>" to both
# console and the review log so that even an early crash produces a useful
# uploaded log. The elapsed offset makes it easy to see how long each phase
# takes.
log() {
  local now elapsed
  now=$(date +%s)
  elapsed=$(awk "BEGIN { printf \"%.1f\", ${now} - ${START_TIME} }")
  printf '[%s +%ss] [entrypoint] %s\n' "$(date -u +%H:%M:%S)" "$elapsed" "$*" | tee -a "$LOG_FILE"
}

# Prefix every line of stdin with a wall-clock timestamp. Used to timestamp
# the opencode output stream without disturbing its ANSI colour formatting.
ts_lines() {
  local line
  while IFS= read -r line; do
    printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$line"
  done
  [[ -n "${line:-}" ]] && printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$line"
}

# Always upload whatever logs we have and trigger cleanup, even on failure.
# This runs on every exit (normal or aborted via set -e).
on_exit() {
  local ec=$?
  if [ -s "$ERRORS_FILE" ]; then
    echo -e "\n--- errors.log ---" >> "$LOG_FILE"
    cat "$ERRORS_FILE" >> "$LOG_FILE" || true
  fi
  if [ "$ec" -ne 0 ]; then
    echo -e "\n[entrypoint] Aborted with exit code $ec." >> "$LOG_FILE"
  fi
  curl -sf -X POST "${REVIEW_WORKER_URL}/logs?owner=${OWNER}&repo=${REPO}&pr_number=${PR_NUMBER}&exit=${ec}" \
    -H "Authorization: Bearer ${REVIEW_WORKER_TOKEN}" \
    -H "Content-Type: text/plain" \
    --data-binary @"$LOG_FILE" >/dev/null 2>&1 || true
  curl -sf -X POST "${REVIEW_WORKER_URL}/cleanup" \
    -H "Authorization: Bearer ${REVIEW_WORKER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"owner\": \"${OWNER}\", \"repo\": \"${REPO}\", \"pr_number\": ${PR_NUMBER}, \"sha\": \"${SHA}\"}" \
    >/dev/null 2>&1 || true
}
trap on_exit EXIT

log "Starting review of ${FULL_REPO}#${PR_NUMBER} (sha ${SHA})"

log "Cloning repository"
if [ -d "$REVIEW_DIR/.git" ]; then
  cd "$REVIEW_DIR"
  git fetch origin "$BASE_BRANCH" --depth 1 2>/dev/null || git fetch origin 2>/dev/null || true
else
  mkdir -p "$REVIEW_DIR"
  # Shallow + single-branch clone: avoids fetching every remote branch (many
  # repos have dozens). We only need the base branch (for diffing) and the
  # PR ref (fetched below), so --depth 1 --single-branch is sufficient and
  # dramatically faster than a full clone.
  gh repo clone "$FULL_REPO" "$REVIEW_DIR" -- --depth 1 --single-branch
  cd "$REVIEW_DIR"
fi

gh auth setup-git 2>/dev/null || true

# Fetch the PR ref at depth 1; fall back to full fetch for robustness.
git fetch origin "pull/$PR_NUMBER/head:pr-$PR_NUMBER" --depth 1 2>/dev/null \
  || git fetch origin "pull/$PR_NUMBER/head:pr-$PR_NUMBER" 2>/dev/null || true
git checkout "pr-$PR_NUMBER" 2>/dev/null || true

if [ -f "$REVIEW_DIR/.linear.toml" ]; then
  cp "$REVIEW_DIR/.linear.toml" /workspace/.linear.toml
fi

# Gather CI logs and PR context in parallel — these are independent network
# calls that together account for several seconds of wall time when run
# sequentially.
log "Gathering CI logs and PR context"
mkdir -p /workspace/ci-logs

gh run view "$RUN_ID" --log > /workspace/ci-logs/run.log 2>>"$ERRORS_FILE" &
gh run view "$RUN_ID" --json jobs \
  --jq '.jobs[] | {name, conclusion, steps: [.steps[] | {name, conclusion}]}' \
  > /workspace/ci-logs/summary.json 2>>"$ERRORS_FILE" &
gh pr view "$PR_NUMBER" --json \
  title,body,author,comments,reviews,labels,additions,deletions,changedFiles,baseRefName,headRefName \
  > /workspace/pr-context.json 2>>"$ERRORS_FILE" &
gh pr diff "$PR_NUMBER" > /workspace/pr.diff 2>>"$ERRORS_FILE" &
wait || true

if [ ! -s /workspace/pr.diff ]; then
  echo "Error: pr.diff is empty — gh pr diff may have failed (check /workspace/errors.log)" >> "$ERRORS_FILE"
fi

# Extract the Linear issue ID from the PR context we already fetched (avoids
# a second `gh pr view` round-trip). The capture returns {"n":"96"}, so we
# pull .n to get the bare number.
LINEAR_ISSUE_ID=$(jq -r '
  (((.body // "") | capture("LIN-(?<n>[0-9]+)") | .n) // null) //
  (((.labels // [])[].name | capture("linear/(?<n>[0-9]+)") | .n) // null) //
  ""
' /workspace/pr-context.json 2>/dev/null || echo "")

if [ -n "$LINEAR_ISSUE_ID" ]; then
  log "Fetching Linear issue LIN-$LINEAR_ISSUE_ID"
  linear issue view "LIN-$LINEAR_ISSUE_ID" --json > /workspace/linear-context.json 2>>"$ERRORS_FILE" || true
fi

cat > /workspace/review-prompt.md <<PROMPT
Review PR #${PR_NUMBER} on ${FULL_REPO}.

Base: ${BASE_BRANCH} → Head: ${HEAD_BRANCH}
Commit: ${SHA}

Context files available in /workspace (pre-gathered — read these instead of
calling \`gh\` again):
- pr-context.json — PR title, body, comments, reviews, labels, stats
- pr.diff         — Full diff of all changes
- ci-logs/        — CI run log and per-job summary
- linear-context.json — Associated Linear issue (if any)
- errors.log      — Any errors encountered while gathering context

The repo is cloned at ${REVIEW_DIR}. \`jq\` is available for JSON parsing;
\`python3\` is NOT installed. \`ripgrep\` (\`rg\`) is available for search.

Read /workspace/REVIEW_AGENT.md for your instructions.
PROMPT

if [ -f .review-agent/prompt.md ]; then
  cp .review-agent/prompt.md /workspace/REVIEW_AGENT.md
fi

cd "$WORKSPACE"
OPENCODE_START=$(date +%s)
log "Running opencode review"
OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS=true \
opencode run "$(cat /workspace/review-prompt.md)" --dir "$WORKSPACE" \
  --variant "${OPENCODE_VARIANT:-max}" \
  2>&1 | ts_lines | tee -a "$LOG_FILE" || true

OPENCODE_END=$(date +%s)
OPENCODE_SECS=$((OPENCODE_END - OPENCODE_START))
TOTAL_SECS=$((OPENCODE_END - START_TIME))
log "Review agent complete (opencode: ${OPENCODE_SECS}s, total: ${TOTAL_SECS}s)."
