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

# Append a progress marker to both the console and the review log so that even
# an early crash produces a useful uploaded log.
log() {
  echo "[entrypoint] $*" | tee -a "$LOG_FILE"
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
  git fetch origin 2>/dev/null || true
else
  mkdir -p "$REVIEW_DIR"
  gh repo clone "$FULL_REPO" "$REVIEW_DIR"
  cd "$REVIEW_DIR"
fi

gh auth setup-git 2>/dev/null || true

git fetch origin "pull/$PR_NUMBER/head:pr-$PR_NUMBER" 2>/dev/null || true
git checkout "pr-$PR_NUMBER" 2>/dev/null || true

log "Gathering CI logs"
mkdir -p /workspace/ci-logs
gh run view "$RUN_ID" --log > /workspace/ci-logs/run.log 2>>"$ERRORS_FILE" || true
gh run view "$RUN_ID" --json jobs \
  --jq '.jobs[] | {name, conclusion, steps: [.steps[] | {name, conclusion}]}' \
  > /workspace/ci-logs/summary.json 2>>"$ERRORS_FILE" || true

if [ -f "$REVIEW_DIR/.linear.toml" ]; then
  cp "$REVIEW_DIR/.linear.toml" /workspace/.linear.toml
fi

log "Gathering PR context"
LINEAR_ISSUE_ID=$(gh pr view "$PR_NUMBER" --json body,labels --jq '
  ((.body // "") | capture("LIN-(?<n>[0-9]+)") // null) //
  ((.labels // [])[].name | capture("linear/(?<n>[0-9]+)") // null)
' 2>/dev/null || echo "")

if [ -n "$LINEAR_ISSUE_ID" ]; then
  linear issue view "LIN-$LINEAR_ISSUE_ID" --json > /workspace/linear-context.json 2>>"$ERRORS_FILE" || true
fi

gh pr view "$PR_NUMBER" --json \
  title,body,author,comments,reviews,labels,additions,deletions,changedFiles,baseRefName,headRefName \
  > /workspace/pr-context.json 2>>"$ERRORS_FILE" || true

gh pr diff "$PR_NUMBER" > /workspace/pr.diff 2>>"$ERRORS_FILE" || true

if [ ! -s /workspace/pr.diff ]; then
  echo "Error: pr.diff is empty — gh pr diff may have failed (check /workspace/errors.log)" >> "$ERRORS_FILE"
fi

cat > /workspace/review-prompt.md <<PROMPT
Review PR #${PR_NUMBER} on ${FULL_REPO}.

Base: ${BASE_BRANCH} → Head: ${HEAD_BRANCH}
Commit: ${SHA}

Context files available in /workspace:
- pr-context.json — PR title, body, comments, reviews, labels, stats
- pr.diff         — Full diff of all changes
- ci-logs/        — CI run log and per-job summary
- linear-context.json — Associated Linear issue (if any)
- errors.log      — Any errors encountered while gathering context

The repo is cloned at ${REVIEW_DIR}.

Read /workspace/REVIEW_AGENT.md for your instructions.
PROMPT

if [ -f .review-agent/prompt.md ]; then
  cp .review-agent/prompt.md /workspace/REVIEW_AGENT.md
fi

cd "$WORKSPACE"
log "Running opencode review"
OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS=true \
opencode run "$(cat /workspace/review-prompt.md)" --dir "$WORKSPACE" \
  --variant "${OPENCODE_VARIANT:-max}" \
  2>&1 | tee -a "$LOG_FILE" || true

log "Review agent complete."
