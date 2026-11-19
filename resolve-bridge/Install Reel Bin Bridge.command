#!/bin/bash
# Installs the Reel Bin companion for DaVinci Resolve. Safe to run again to update.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "== Reel Bin Bridge installer =="

# 1) Find DaVinci Resolve (free or Studio, any drive)
APP=""; BUNDLE=""
for id in com.blackmagic-design.DaVinciResolve com.blackmagic-design.DaVinciResolveLite; do
  p=$(mdfind "kMDItemCFBundleIdentifier == '$id'" 2>/dev/null | head -1)
  if [ -n "$p" ]; then APP="$p"; BUNDLE="$id"; break; fi
done
if [ -z "$APP" ]; then
  p=$(mdfind "kMDItemFSName == 'DaVinci Resolve.app'" 2>/dev/null | head -1)
  [ -n "$p" ] && APP="$p" && BUNDLE=$(defaults read "$p/Contents/Info" CFBundleIdentifier 2>/dev/null)
fi
if [ -z "$APP" ]; then
  echo "!! DaVinci Resolve was not found. Install it (free: blackmagicdesign.com/products/davinciresolve), then run this again."
else
  echo "Found Resolve: $APP ($BUNDLE)"
fi
mkdir -p "$HOME/Library/Application Support/ReelBin" "$HOME/Movies/Reel Bin Jobs"
printf '%s' "$BUNDLE" > "$HOME/Library/Application Support/ReelBin/resolve_bundle_id"

# 2) Install the Resolve script (Workspace > Scripts > Reel Bin Import)
LUA_SRC="$HERE/Reel Bin Import.lua"
TARGETS=("$HOME/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility")
# Mac App Store build keeps its support files inside its container
for c in "$HOME/Library/Containers/com.blackmagic-design.DaVinciResolveLite" "$HOME/Library/Containers/com.blackmagic-design.DaVinciResolve"; do
  [ -d "$c" ] && TARGETS+=("$c/Data/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility")
done
for t in "${TARGETS[@]}"; do
  mkdir -p "$t" && sed "s#__HOME__#$HOME#g" "$LUA_SRC" > "$t/Reel Bin Import.lua" && echo "Script installed: $t"
done

# 3) Oswald font for the name bug (copied if found on your drive)
for f in "/Volumes/DeepBag/2026 Basketball Video testrun/working/batch2_premiere/_tools/Oswald-Variable.ttf" "$HERE/Oswald-Variable.ttf"; do
  if [ -f "$f" ] && [ ! -f "$HOME/Library/Fonts/Oswald-Variable.ttf" ]; then cp "$f" "$HOME/Library/Fonts/" && echo "Installed font: Oswald"; fi
done

# 4) Build the helper app that answers reelbin:// links
APPDIR="$HOME/Applications/Reel Bin Bridge.app"
mkdir -p "$HOME/Applications"
rm -rf "$APPDIR"
osacompile -o "$APPDIR" "$HERE/ReelBinBridge.applescript" || { echo "!! Could not build the helper app"; exit 1; }
cp "$HERE/bridge.sh" "$APPDIR/Contents/Resources/bridge.sh"
cp "$HERE/run_import.applescript" "$APPDIR/Contents/Resources/run_import.applescript"
PL="$APPDIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.brightclew.reelbin.bridge" "$PL" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.brightclew.reelbin.bridge" "$PL"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PL" 2>/dev/null
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PL"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string Reel Bin job" "$PL"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PL"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string reelbin" "$PL"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PL" 2>/dev/null
codesign --force --deep --sign - "$APPDIR" 2>/dev/null
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APPDIR"
echo "Helper installed: $APPDIR"
echo
echo "One-time permission so the import runs by itself:"
echo "  System Settings > Privacy & Security > Accessibility > + > add 'Reel Bin Bridge' from your Applications folder (in your home folder) and turn it on."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null
open -R "$APPDIR" 2>/dev/null
echo
echo "Done. In Reel Bin, click Send to Resolve. The first time, your browser asks to open Reel Bin Bridge and macOS asks"
echo "to let it read Downloads: allow both. Resolve opens and builds the project on its own."
echo "(If Resolve was open, restart it once so the new script shows in its menu.)"
read -n 1 -s -r -p "Press any key to close."
