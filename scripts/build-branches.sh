#!/usr/bin/env bash
# Generates the testbed's scenario branches from main plus scenarios/<id>.patch.
#
#   scripts/build-branches.sh [--push] [<id>...]
#
# Ids: `vanilla`, and every scenarios/<id>.patch on main. With no id, all of them.
# Branch names: fault-<rest> -> fault/<rest>, scenario-<rest> -> scenario/<rest>, vanilla -> vanilla.
# Each branch is ONE orphan commit (message `scenario <id>`, fixed author and dates), so the same
# main and patch always give the same commit id. A branch tree never holds scenarios/ or this script,
# so an agent working on a branch cannot read the other scenarios. Only .omc-project/ is dropped from vanilla.
# --push force-pushes the generated branches to origin; main is never pushed.
#
# Everything is plumbing on a temporary index: the working tree, index and HEAD of the caller are not touched.
set -euo pipefail

BASE=main
push=0
ids=()
for arg in "$@"; do
  case "$arg" in
    --push) push=1 ;;
    -*) echo "build-branches: unknown option: $arg" >&2; exit 2 ;;
    *) ids+=("$arg") ;;
  esac
done

git rev-parse --verify --quiet "refs/heads/$BASE" >/dev/null || { echo "build-branches: no branch $BASE here" >&2; exit 2; }

available=()
while IFS= read -r file; do
  name=${file##*/}
  available+=("${name%.patch}")
done < <(git ls-tree --name-only "$BASE" scenarios/ | grep '\.patch$' || true)

if [ ${#ids[@]} -eq 0 ]; then
  ids=(vanilla ${available[@]+"${available[@]}"})
fi

branch_of() {
  case "$1" in
    vanilla) echo vanilla ;;
    fault-*) echo "fault/${1#fault-}" ;;
    scenario-*) echo "scenario/${1#scenario-}" ;;
    *) echo "scenario/$1" ;;
  esac
}

for id in "${ids[@]}"; do
  if [ "$id" != vanilla ] && ! printf '%s\n' ${available[@]+"${available[@]}"} | grep -qx -- "$id"; then
    echo "build-branches: unknown scenario id: $id (known: vanilla ${available[*]:-})" >&2
    exit 1
  fi
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME='tally testbed' GIT_AUTHOR_EMAIL='testbed@example.invalid' GIT_AUTHOR_DATE='2026-01-01T00:00:00Z'
export GIT_COMMITTER_NAME='tally testbed' GIT_COMMITTER_EMAIL='testbed@example.invalid' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'

branches=()
for id in "${ids[@]}"; do
  branch=$(branch_of "$id")
  export GIT_INDEX_FILE="$work/index-$$-${#branches[@]}"
  git read-tree "$BASE"
  if [ "$id" = vanilla ]; then
    git rm -r --cached -q --ignore-unmatch -- .omc-project
  else
    git show "$BASE:scenarios/$id.patch" >"$work/patch"
    git apply --cached --whitespace=nowarn "$work/patch"
  fi
  git rm -r --cached -q --ignore-unmatch -- scenarios scripts/build-branches.sh
  tree=$(git write-tree)
  commit=$(git commit-tree "$tree" -m "scenario $id")
  git update-ref "refs/heads/$branch" "$commit"
  unset GIT_INDEX_FILE
  branches+=("$branch")
  echo "$branch $commit"
done

if [ "$push" -eq 1 ]; then
  for branch in "${branches[@]}"; do
    git push --force origin "refs/heads/$branch:refs/heads/$branch"
  done
fi
