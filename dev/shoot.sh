#!/bin/zsh
# Retakes the screenshots in docs/ from the browser harness, so they always show
# the same fixture and never a real controller's job names.
#
#   ./dev/shoot.sh
#
# Serves the repo itself, drives the harness through dev/shots.js URL params, and
# shoots each view with headless Chrome. Chrome does not exit on its own after
# --screenshot, so each run is killed once the file is written.

set -e
cd "$(dirname "$0")/.."
root="$PWD"
port=8731
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x "$chrome" ]] || { echo "Google Chrome not found at $chrome"; exit 1; }

python3 -m http.server "$port" --directory "$root" >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1

# A killed-not-quit Chrome can leave its SingletonLock behind, so the next shot
# reuses a profile that thinks it's already running and never loads the page.
# Wiped up front rather than after, so a run that dies mid-way still leaves a
# clean slate for the next one.
rm -rf /tmp/jenkins-launcher-shots

shoot() {
  local out="docs/$1.png" url="http://localhost:$port/dev/$2" w="${3:-400}" h="${4:-640}"
  # --screenshot fires on the page's load event, which beats both the async
  # fetch-and-inject in options-preview.html and shots.js's until() polling for
  # search results or an opened panel. --virtual-time-budget makes Chrome run
  # its virtual clock forward that far before capturing, so timers and pending
  # promises actually settle first instead of racing the shot.
  "$chrome" --headless=new --disable-gpu --no-sandbox \
    --user-data-dir=/tmp/jenkins-launcher-shots --hide-scrollbars \
    --window-size="$w,$h" --virtual-time-budget=8000 \
    --screenshot="$root/$out" "$url" >/dev/null 2>&1 &
  local pid=$!
  sleep 12
  kill $pid 2>/dev/null || true
  echo "  $out"
}

echo "writing:"
shoot browse        'preview.html?fresh'
shoot search        'preview.html?fresh&q=e'
shoot parameters    'preview.html?fresh&open=0'
shoot subscriptions 'preview.html?fresh&subs'
shoot settings      'options-preview.html?fresh' 700 1700
