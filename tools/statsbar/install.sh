#!/bin/sh
# Builds StatsBar into ~/Applications and starts it now and at every login.
set -e
cd "$(dirname "$0")"
mkdir -p ~/Applications
swiftc -O StatsBar.swift -o ~/Applications/nextmap-statsbar
PLIST=~/Library/LaunchAgents/dev.nextmap.statsbar.plist
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.nextmap.statsbar</string>
  <key>ProgramArguments</key><array><string>$HOME/Applications/nextmap-statsbar</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
EOF
launchctl bootout gui/$(id -u)/dev.nextmap.statsbar 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
echo "StatsBar running; remove with: launchctl bootout gui/$(id -u)/dev.nextmap.statsbar && rm $PLIST"
