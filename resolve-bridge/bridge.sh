#!/bin/bash
# Reel Bin Bridge: called by the helper app for reelbin://open?job=<file> links.
# Moves the newest Reel Bin job out of Downloads, marks it pending, and opens DaVinci Resolve.
URL="$1"
JOBS="$HOME/Movies/Reel Bin Jobs"
mkdir -p "$JOBS"
case "$URL" in
  reelbin://ping*) osascript -e 'display notification "Reel Bin Bridge is connected." with title "Reel Bin Bridge" sound name "Glass"'; exit 0 ;;
esac
TARGET=$(printf '%s' "$URL" | sed -n 's/.*[?&]target=\([^&]*\).*/\1/p')
[ -z "$TARGET" ] && TARGET="resolve"
if [ "$TARGET" != "resolve" ]; then
  osascript -e "display notification \"No handler for $TARGET yet.\" with title \"Reel Bin Bridge\""; exit 1
fi
NAME=$(printf '%s' "$URL" | sed -n 's/.*[?&]job=\([^&]*\).*/\1/p' | sed 's/%20/ /g')
SRC=""
[ -n "$NAME" ] && [ -f "$HOME/Downloads/$NAME" ] && SRC="$HOME/Downloads/$NAME"
if [ -z "$SRC" ]; then
  # newest job downloaded in the last 15 minutes (browsers rename duplicates to "name (1).rbjob.lua")
  SRC=$(find "$HOME/Downloads" -maxdepth 1 -name '*.rbjob.lua' -mmin -15 -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)
fi
if [ -z "$SRC" ]; then
  osascript -e 'display notification "No new Reel Bin job found in Downloads. Click Send to Resolve again." with title "Reel Bin Bridge"'
  exit 1
fi
DEST="$JOBS/$(basename "$SRC" | sed 's/ ([0-9]*)\.rbjob\.lua$/.rbjob.lua/')"
mv -f "$SRC" "$DEST"
printf '%s' "$DEST" > "$JOBS/pending.txt"
BUNDLE=$(cat "$HOME/Library/Application Support/ReelBin/resolve_bundle_id" 2>/dev/null)
[ -z "$BUNDLE" ] && BUNDLE="com.blackmagic-design.DaVinciResolveLite"
open -b "$BUNDLE" 2>/dev/null || open -a "DaVinci Resolve"
osascript -e 'display notification "Opening Resolve. The import starts by itself once a project is open." with title "Reel Bin job ready"'
# Run the import by clicking Workspace > Scripts > Reel Bin Import (free Resolve has no outside scripting).
HERE="$(cd "$(dirname "$0")" && pwd)"
RESULT=$(osascript "$HERE/run_import.applescript" "$BUNDLE" 2>&1)
case "$RESULT" in
  ok) osascript -e 'display notification "Building timelines in Resolve…" with title "Reel Bin"' ;;
  noaccess) osascript -e 'display dialog "Reel Bin Bridge needs Accessibility permission to start the import for you.\n\nSystem Settings › Privacy & Security › Accessibility › turn on Reel Bin Bridge.\n\nFor now, choose Workspace › Scripts › Reel Bin Import in Resolve." buttons {"Open Settings", "OK"} default button 1 with title "Reel Bin Bridge"' -e 'if button returned of result is "Open Settings" then do shell script "open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"' ;;
  *) osascript -e 'display notification "Could not reach the Scripts menu. In Resolve choose Workspace › Scripts › Reel Bin Import." with title "Reel Bin"' ;;
esac
