#!/usr/bin/env bash
# Launch, check, drive, and stop one isolated local Cardex Worker.
# Evidence files are never deleted.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SKILL_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
ROOT=$(cd "$SKILL_DIR/../../.." && pwd)
RUNS="$SKILL_DIR/runs"
EVIDENCE_ROOT="$SKILL_DIR/evidence"

usage() {
  echo "usage: verify.sh launch|doctor|drive|cleanup" >&2
  exit 2
}

latest_run() {
  if [[ -n "${CARDEX_VERIFY_RUN_ID:-}" ]]; then
    echo "$CARDEX_VERIFY_RUN_ID"
    return
  fi
  find "$RUNS" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | sort | tail -1
}

run_dir() {
  local id
  id=$(latest_run)
  if [[ -z "$id" || ! -d "$RUNS/$id" ]]; then
    echo "no verification run; launch one first" >&2
    exit 2
  fi
  echo "$RUNS/$id"
}

meta_get() {
  node -e "const m=require(process.argv[1]); process.stdout.write(String(m[process.argv[2]]))" "$1" "$2"
}

kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

wait_ready() {
  local url="$1" log="$2" i
  for i in $(seq 1 90); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "worker did not answer $url" >&2
  tail -n 40 "$log" >&2 || true
  return 1
}

cmd_launch() {
  local run_id port state evidence log pid url
  run_id=${CARDEX_VERIFY_RUN_ID:-$(date +%Y%m%d%H%M%S)}
  port=${CARDEX_VERIFY_PORT:-8791}
  if curl -fsS "http://127.0.0.1:${port}/" -o /dev/null 2>/dev/null; then
    echo "port ${port} is already in use; refuse to drive a server this run did not start" >&2
    exit 1
  fi
  state="$RUNS/$run_id/state"
  evidence="$EVIDENCE_ROOT/$run_id"
  log="$RUNS/$run_id/wrangler.log"
  mkdir -p "$state" "$evidence"
  if [[ "$state" == *"/.wrangler/state"* ]]; then
    echo "refuse to share the repo .wrangler state" >&2
    exit 1
  fi

  pnpm --dir "$ROOT" build:site
  pnpm --dir "$ROOT/packages/mcp-worker" exec wrangler d1 migrations apply cardex-db --local --persist-to "$state"
  pnpm --dir "$ROOT/packages/mcp-worker" exec wrangler d1 execute cardex-db --local --persist-to "$state" --file ../../seed/seed.sql

  pid=$(
    node --input-type=module -e '
      import { spawn } from "node:child_process";
      import { openSync } from "node:fs";
      const log = openSync(process.argv[1], "a");
      const child = spawn(
        "pnpm",
        [
          "exec", "wrangler", "dev",
          "--port", process.argv[2],
          "--ip", "127.0.0.1",
          "--persist-to", process.argv[3],
          "--inspector-port", process.argv[4],
          "--show-interactive-dev-session=false",
        ],
        {
          cwd: process.argv[5],
          detached: true,
          stdio: ["ignore", log, log],
          env: { ...process.env, CI: "1" },
        },
      );
      child.unref();
      process.stdout.write(String(child.pid));
    ' "$log" "$port" "$state" "$((port + 1))" "$ROOT/packages/mcp-worker"
  )
  echo "$pid" >"$RUNS/$run_id/pid"
  url="http://127.0.0.1:${port}"
  cat >"$RUNS/$run_id/meta.json" <<EOF
{
  "runId": "$run_id",
  "port": $port,
  "url": "$url",
  "mcp": "${url}/mcp",
  "pid": $pid,
  "state": "$state",
  "evidence": "$evidence",
  "log": "$log"
}
EOF
  if ! wait_ready "$url/" "$log"; then
    kill_tree "$pid"
    exit 1
  fi
  echo "$run_id"
}

cmd_doctor() {
  local dir url pid state evidence body
  dir=$(run_dir)
  url=$(meta_get "$dir/meta.json" url)
  pid=$(meta_get "$dir/meta.json" pid)
  state=$(meta_get "$dir/meta.json" state)
  evidence=$(meta_get "$dir/meta.json" evidence)
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "pid $pid is not running" >&2
    exit 1
  fi
  case "$state" in
    "$RUNS"/*) ;;
    *) echo "state $state is outside this run; refuse" >&2; exit 1 ;;
  esac
  body=$(curl -fsS "$url/")
  if ! grep -q "碌邊張卡" <<<"$body"; then
    echo "homepage is missing the zh-HK hero" >&2
    exit 1
  fi
  if ! grep -q "複製" <<<"$body"; then
    echo "homepage is missing the copy button label" >&2
    exit 1
  fi
  curl -sS -o /dev/null -w "%{http_code}" "$url/mcp" >/dev/null
  mkdir -p "$evidence"
  cat >"$evidence/doctor.json" <<EOF
{"url":"$url","pid":$pid,"state":"$state","homepage":"zh-HK hero and 複製 present"}
EOF
  echo "$evidence/doctor.json"
}

cmd_drive() {
  local dir evidence
  dir=$(run_dir)
  evidence=$(meta_get "$dir/meta.json" evidence)
  CARDEX_VERIFY_URL=$(meta_get "$dir/meta.json" mcp) \
  CARDEX_VERIFY_EVIDENCE="$evidence" \
    pnpm --dir "$ROOT/packages/mcp-worker" exec tsx "$SCRIPT_DIR/drive.ts"
}

cmd_cleanup() {
  local dir pid state
  dir=$(run_dir)
  pid=$(meta_get "$dir/meta.json" pid)
  state=$(meta_get "$dir/meta.json" state)
  kill_tree "$pid"
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  if [[ "$state" == "$RUNS"/* ]]; then
    rm -rf "$state"
  fi
  echo "stopped $pid; evidence kept at $(meta_get "$dir/meta.json" evidence)"
}

[[ $# -eq 1 ]] || usage
case "$1" in
  launch) cmd_launch ;;
  doctor) cmd_doctor ;;
  drive) cmd_drive ;;
  cleanup) cmd_cleanup ;;
  *) usage ;;
esac
