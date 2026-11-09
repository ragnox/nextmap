#!/bin/sh
# Builds StatsBar into ~/Applications and starts it now and at every login; also installs the weekly stats note:
# every Monday 08:00, `node scripts/stats.js week --markdown` into cache/stats/<year>-W<week>.md (a year of history,
# since Web Analytics itself keeps little).
set -e
cd "$(dirname "$0")"
REPO="$(cd ../.. && pwd)"
mkdir -p ~/Applications "$REPO/cache/stats"
swiftc -O StatsBar.swift -o ~/Applications/nextmap-statsbar
PLIST=~/Library/LaunchAgents/dev.nextmap.statsbar.plist
cat > "$PLIST" <<EOP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.nextmap.statsbar</string>
  <key>ProgramArguments</key><array><string>$HOME/Applications/nextmap-statsbar</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
EOP
launchctl bootout gui/$(id -u)/dev.nextmap.statsbar 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"

WEEKLY=~/Library/LaunchAgents/dev.nextmap.stats-weekly.plist
cat > "$WEEKLY" <<EOP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.nextmap.stats-weekly</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd "$REPO" &amp;&amp; node scripts/stats.js week --markdown > "cache/stats/\$(date +%G-W%V).md"</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>$REPO/cache/stats/weekly.log</string>
</dict></plist>
EOP
launchctl bootout gui/$(id -u)/dev.nextmap.stats-weekly 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$WEEKLY"
echo "StatsBar running and the weekly note scheduled (Mondays 08:00 into cache/stats/)."
echo "Remove with: launchctl bootout gui/$(id -u)/dev.nextmap.statsbar; launchctl bootout gui/$(id -u)/dev.nextmap.stats-weekly; rm $PLIST $WEEKLY"
