#!/bin/sh
# Builds StatsBar into ~/Applications and starts it now and at every login; also installs the weekly stats note:
# every Monday 08:00, `node scripts/stats.js week --markdown` into cache/stats/<year>-W<week>.md (a year of history,
# since Web Analytics itself keeps little).
set -e
cd "$(dirname "$0")"
REPO="$(cd ../.. && pwd)"
# Launch agents start with a bare PATH and `zsh -lc` skips ~/.zshrc, where nvm and the like put node: give both agents
# the node of this shell (StatsBar renews wrangler's login with npx). After switching node versions, run this again.
NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
AGENT_PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p ~/Applications "$REPO/cache/stats"
# (re)load a launch agent; bootout returns before the old job has gone, and bootstrap fails (error 5) until it has
load() {
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl bootstrap "gui/$(id -u)" "$2" 2>/dev/null && return; sleep 0.5; done
  launchctl bootstrap "gui/$(id -u)" "$2"
}
swiftc -O StatsBar.swift -o ~/Applications/nextmap-statsbar
PLIST=~/Library/LaunchAgents/dev.nextmap.statsbar.plist
cat > "$PLIST" <<EOP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.nextmap.statsbar</string>
  <key>ProgramArguments</key><array><string>$HOME/Applications/nextmap-statsbar</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$AGENT_PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
EOP
load dev.nextmap.statsbar "$PLIST"

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
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$AGENT_PATH</string></dict>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>$REPO/cache/stats/weekly.log</string>
</dict></plist>
EOP
load dev.nextmap.stats-weekly "$WEEKLY"
echo "StatsBar running and the weekly note scheduled (Mondays 08:00 into cache/stats/)."
echo "Remove with: launchctl bootout gui/$(id -u)/dev.nextmap.statsbar; launchctl bootout gui/$(id -u)/dev.nextmap.stats-weekly; rm $PLIST $WEEKLY"
