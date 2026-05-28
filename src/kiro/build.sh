#!/bin/bash
# src/kiro/build.sh — Build the Kiro distribution from src/.
#
# Output: dist/kiro/.kiro/  (works for both Kiro IDE and Kiro CLI)
#
# Sources:
#   src/kiro/agents/           → dist/kiro/.kiro/agents/
#   src/kiro/aidlc-common/     → dist/kiro/.kiro/aidlc-common/
#   src/skills/                → dist/kiro/.kiro/skills/
#   src/kiro/hooks/            → dist/kiro/.kiro/hooks/
#
# Source content uses repo-anchored paths (e.g. `aidlc-common/protocols/...`).
# When materialised under .kiro/, those paths resolve correctly because the
# install root for Kiro IS .kiro/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$ROOT/src"
KIRO_SRC="$SRC/kiro"
OUT="$ROOT/dist/kiro/.kiro"

echo "Building dist/kiro/ ..."

# Wipe and recreate the output directory.
rm -rf "$ROOT/dist/kiro"
mkdir -p "$OUT"

# 1. Copy kiro-specific agents and aidlc-common.
cp -R "$KIRO_SRC/agents"        "$OUT/agents"
cp -R "$KIRO_SRC/aidlc-common"  "$OUT/aidlc-common"

# 2. Copy shared skills.
cp -R "$SRC/skills"             "$OUT/skills"

# 3. Copy Kiro-specific hooks.
mkdir -p "$OUT/hooks"
cp "$KIRO_SRC/hooks/"* "$OUT/hooks/"

# 4. Validate the output.
echo "Validating ..."

# 4a. Every JSON file must parse.
while IFS= read -r json; do
  if ! node -e "JSON.parse(require('fs').readFileSync('$json','utf8'))" >/dev/null 2>&1; then
    echo "  FAIL: invalid JSON: $json" >&2
    exit 1
  fi
done < <(find "$OUT" -name '*.json' -type f)

# 4b. Every SKILL.md must have frontmatter with name. Skills that appear in
# workflow.md (everything except aidlc-orchestrator) must additionally have
# phase and stage. The orchestrator skill is a meta-skill — it dispatches to
# others and never appears in workflow.md.
missing=0
while IFS= read -r skill; do
  fields="name"
  case "$skill" in
    */aidlc-orchestrator/SKILL.md) ;;
    *) fields="name phase stage" ;;
  esac
  for field in $fields; do
    if ! grep -qE "^\s*${field}:" "$skill"; then
      echo "  FAIL: $skill missing frontmatter field '$field'" >&2
      missing=$((missing+1))
    fi
  done
done < <(find "$OUT/skills" -name 'SKILL.md' -type f)
[ "$missing" -eq 0 ] || exit 1

# 4c. The process-checker script must syntax-check.
node --check "$OUT/aidlc-common/scripts/aidlc-process-checker.js"

echo "  → dist/kiro/.kiro/  (use for both Kiro IDE and Kiro CLI)"
