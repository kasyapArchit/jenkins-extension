#!/bin/zsh
# Retakes the screenshots in docs/ from the browser harness, so they always show
# the same fixture and never a real controller's job names.
#
#   ./dev/shoot.sh
#
# Serves the repo itself and drives each view through dev/shoot.mjs, which talks
# to headless Chrome over the DevTools protocol so it can force
# prefers-color-scheme and wait for the page's own shotReady flag instead of
# guessing with a timer.

set -e
cd "$(dirname "$0")/.."
root="$PWD"
port=8731
node="$(command -v node)"
[[ -n "$node" ]] || { echo "node not found on PATH"; exit 1; }

python3 -m http.server "$port" --directory "$root" >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1

shoot() {
  local out="docs/$1.png" url="http://localhost:$port/dev/$2" w="${3:-400}" h="${4:-640}" scheme="${5:-dark}"
  "$node" dev/shoot.mjs "$url" "$root/$out" "$w" "$h" "$scheme"
  echo "  $out ($scheme)"
}

echo "writing:"
shoot browse        'preview.html?fresh'
shoot browse-light   'preview.html?fresh'                400 640  light
shoot search        'preview.html?fresh&q=e'
shoot parameters    'preview.html?fresh&open=0'
shoot subscriptions 'preview.html?fresh&subs'
shoot settings      'options-preview.html?fresh'         700 1700
