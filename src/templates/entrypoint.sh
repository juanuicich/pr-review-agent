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
> "$ERRORS_FILE"

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

mkdir -p /workspace/ci-logs
gh run view "$RUN_ID" --log > /workspace/ci-logs/run.log 2>>"$ERRORS_FILE" || true
gh run view "$RUN_ID" --json jobs \
  --jq '.jobs[] | {name, conclusion, steps: [.steps[] | {name, conclusion}]}' \
  > /workspace/ci-logs/summary.json 2>>"$ERRORS_FILE" || true

if [ -f "$REVIEW_DIR/.linear.toml" ]; then
  cp "$REVIEW_DIR/.linear.toml" /workspace/.linear.toml
fi

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
OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS=true \
opencode run "$(cat /workspace/review-prompt.md)" --dir "$WORKSPACE" \
  2>&1 | tee /workspace/review-output.log || true

curl -sf -X POST "${REVIEW_WORKER_URL}/logs?owner=${OWNER}&repo=${REPO}&pr_number=${PR_NUMBER}" \
  -H "Authorization: Bearer ${REVIEW_WORKER_TOKEN}" \
  -H "Content-Type: text/plain" \
  --data-binary @/workspace/review-output.log || true

curl -sf -X POST "${REVIEW_WORKER_URL}/cleanup" \
  -H "Authorization: Bearer ${REVIEW_WORKER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"owner\": \"${OWNER}\", \"repo\": \"${REPO}\", \"pr_number\": ${PR_NUMBER}, \"sha\": \"${SHA}\"}" \
  || true

echo "Review agent complete."
exit 0
