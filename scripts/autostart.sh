#!/bin/sh
# Start Video Autopilot automatically when you log in to this Mac (and restart it if it stops).
#   sh scripts/autostart.sh install     build the dashboard, then install and start the login agent
#   sh scripts/autostart.sh uninstall   stop it and remove the login agent
#   sh scripts/autostart.sh status
set -e
LABEL=com.videoautopilot
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
LOG="$ROOT/data/autopilot.log"

case "$1" in
  install)
    [ -n "$NODE" ] || { echo "Node.js not found"; exit 1; }
    (cd "$ROOT" && npm run build >/dev/null)
    mkdir -p "$ROOT/data" "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$ROOT/node_modules/tsx/dist/cli.mjs</string><string>$ROOT/server/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "✓ Video Autopilot starts at login. Dashboard: http://localhost:4317  (log: $LOG)"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ Removed. It no longer starts at login."
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid" || echo "not installed"
    ;;
  *) echo "usage: sh scripts/autostart.sh install|uninstall|status"; exit 1 ;;
esac
