#!/usr/bin/env bash
# PreToolUse hook: auto-approve every tool call (no in-chat permission prompts),
# except a short denylist of destructive shell commands.
# Input: hook JSON on stdin. Output: PreToolUse permission decision JSON.

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

decide() {
  jq -cn --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  exit 0
}

if [ "$tool" = "Bash" ] && [ -n "$cmd" ]; then
  # Any push that targets main with force, force-with-lease, a +refspec, or a delete.
  if printf '%s' "$cmd" | grep -Eq '\bgit\b[^;&|]*\bpush\b[^;&|]*(--force|--force-with-lease|[[:space:]]-[a-zA-Z]*f|--delete|[[:space:]]-d\b|[[:space:]]\+|[[:space:]]:)' \
     && printf '%s' "$cmd" | grep -Eq '\bgit\b[^;&|]*\bpush\b[^;&|]*\bmain\b'; then
    decide deny "Blocked by .claude/hooks/auto-approve.sh: force/delete push targeting main"
  fi
  # Plain --force / -f push anywhere (--force-with-lease on non-main branches is allowed).
  if printf '%s' "$cmd" | grep -Eq '\bgit\b[^;&|]*\bpush\b[^;&|]*(--force([[:space:]]|$|=)|[[:space:]]-[a-zA-Z]*f([[:space:]]|$))'; then
    decide deny "Blocked by .claude/hooks/auto-approve.sh: git push --force (use --force-with-lease on a non-main branch)"
  fi
  # Recursive rm of filesystem root or home directory.
  if printf '%s' "$cmd" | grep -Eq '\brm[[:space:]]+(-[a-zA-Z-]+[[:space:]]+)*-[a-zA-Z]*[rR][a-zA-Z]*([[:space:]]+-[a-zA-Z-]+)*[[:space:]]+["'"'"']?(/|~|\$HOME|\$\{HOME\})/?\*?["'"'"']?([[:space:]]|;|&|\||$)'; then
    decide deny "Blocked by .claude/hooks/auto-approve.sh: recursive rm of / or home"
  fi
fi

decide allow "easycloud-oci auto-approve hook"
