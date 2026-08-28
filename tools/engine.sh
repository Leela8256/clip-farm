#!/bin/zsh
# Run the RocketRide engine for this app as a background service, with the repo as
# node path so the custom podcast_* nodes load next to the stock ones.
#
#   tools/engine.sh start | restart | stop | status | logs
#
# Reads the engine's secrets from the repo's .env (never printed):
#   ROCKETRIDE_APIKEY          any value; the frontend sends the same one
#   ROCKETRIDE_ANTHROPIC_KEY   used by the stock llm_anthropic node (substituted by the engine)
#   RR_SIGNING_KEY             enables signed URLs for previews/exports/source video
# Optional: ROCKETRIDE_SERVER_DIR (engine build dir), ROCKETRIDE_ENGINE_PORT (default 5567).
set -e
REPO=${0:A:h:h}
ENV_FILE="$REPO/.env"
# The engine build: by default the rocketride-server clone next to this repo
# (git clone … rocketride-server && ./builder server:build), see README.
SERVER_DIR=${ROCKETRIDE_SERVER_DIR:-"$REPO/../rocketride-server/dist/server"}
PORT=${ROCKETRIDE_ENGINE_PORT:-5567}
LOG="$REPO/.rocketride/engine.log"

envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- ; }
listener() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 ; }

start() {
  if [ -n "$(listener)" ]; then echo "engine already listening on $PORT (pid $(listener))"; return; fi
  [ -x "$SERVER_DIR/engine" ] || { echo "engine not found at $SERVER_DIR (set ROCKETRIDE_SERVER_DIR)"; exit 1; }
  local apikey="$(envval ROCKETRIDE_APIKEY)"; local anthropic="$(envval ROCKETRIDE_ANTHROPIC_KEY)"; local sign="$(envval RR_SIGNING_KEY)"
  [ -n "$anthropic" ] || echo "warning: ROCKETRIDE_ANTHROPIC_KEY missing in .env — llm_anthropic will fail"
  [ -n "$sign" ] || echo "warning: RR_SIGNING_KEY missing in .env — the UI cannot play files through signed URLs"
  mkdir -p "$(dirname "$LOG")"
  ( cd "$SERVER_DIR" && ROCKETRIDE_APIKEY="${apikey:-MYAPIKEY}" ROCKETRIDE_ANTHROPIC_KEY="$anthropic" RR_SIGNING_KEY="$sign" \
      nohup ./engine ai/eaas.py --host=127.0.0.1 --port="$PORT" --node_path="$REPO" >> "$LOG" 2>&1 & )
  for i in $(seq 1 60); do nc -z -G 1 127.0.0.1 "$PORT" 2>/dev/null && break; sleep 1; done
  echo "engine started on http://127.0.0.1:$PORT (${i}s) with --node_path=$REPO — log: $LOG"
}

stop() {
  local pid="$(listener)"
  [ -n "$pid" ] || { echo "no engine on $PORT"; return; }
  kill "$pid"
  for i in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  # a stale parent process sometimes survives the listener; clear it too
  pgrep -f "eaas.py --host=127.0.0.1 --port=$PORT" | xargs -r kill 2>/dev/null || true
  echo "engine stopped"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status)
    if [ -n "$(listener)" ]; then ps -o pid,etime,command -p "$(listener)" | tail -1 | cut -c1-160; else echo "engine not running on $PORT"; fi ;;
  logs) tail -n 40 "$LOG" ;;
  *) echo "usage: tools/engine.sh start|restart|stop|status|logs"; exit 1 ;;
esac
