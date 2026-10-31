# Sourced by mongo-backup.sh, mongo-restore.sh and restore-drill.sh: which compose project the
# commands talk to. Expects DEPLOY_DIR and COMPOSE to be set.
#
# compose names a project after the first file's directory unless told otherwise, so a plain
# `docker compose -f deploy/docker-compose.yml` stack is `deploy`, while verify-stack names its
# stack `navfleet`. Without `-p` these tools only ever reached the first, and against the second
# failed with "service mongo is not running". Order: NAVFLEET_PROJECT (verify-stack's variable),
# then COMPOSE_PROJECT_NAME, then the one running project started from this deploy/ directory.
# Two running at once is refused rather than guessed: a restore aimed at the wrong one is not
# undoable.
resolve_compose_project() {
  local project="${NAVFLEET_PROJECT:-${COMPOSE_PROJECT_NAME:-}}"
  if [[ -z "$project" ]]; then
    local running
    running="$(docker ps \
      --filter "label=com.docker.compose.service=mongo" \
      --filter "label=com.docker.compose.project.working_dir=$DEPLOY_DIR" \
      --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | sort -u)"
    if [[ "$(printf '%s\n' "$running" | grep -c .)" -gt 1 ]]; then
      echo "有多个从 deploy/ 起的 compose 项目在跑 mongo：$(echo "$running" | tr '\n' ' ')" >&2
      echo "用 NAVFLEET_PROJECT=<项目名> 指定要操作的那一个。" >&2
      exit 1
    fi
    project="$running"
  fi
  if [[ -n "$project" ]]; then
    COMPOSE="$COMPOSE -p $project"
    echo "compose 项目：${project}"
  fi
}
