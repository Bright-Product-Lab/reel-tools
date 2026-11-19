# Reel Bin → DaVinci Resolve (companion)

Reel Bin handles the fast part (marking plays, tagging players, 9:16 framing).
DaVinci Resolve handles the timeline, color, transitions, titles and final export.

## One-time setup (2 minutes)
1. Unzip this folder anywhere.
2. Double-click **Install Reel Bin Bridge.command**. If macOS blocks it, right-click it → **Open** → **Open**.
   It finds Resolve (free or Studio, on any drive), installs the **Reel Bin Import** script,
   copies the Oswald font if it finds it on DeepBag, and builds **~/Applications/Reel Bin Bridge.app**.
3. **Turn on Accessibility for the helper (once).** System Settings › Privacy & Security › Accessibility: click **+**, add **Reel Bin Bridge** (in the Applications folder inside your home folder), and switch it on. The installer opens both windows for you. This lets the helper click **Workspace › Scripts › Reel Bin Import** for you, because free Resolve doesn't allow outside scripting.
4. If Resolve was open, quit and reopen it so the script appears in the menu.

## Every job
1. In Reel Bin, open **Marks → Send to Resolve ›** (or **Vertical Maker → Export → Send to Resolve ›**).
2. Paste the source clips folder (Finder: right-click the folder, hold **Option**, choose **Copy "…" as Pathname**).
3. Click **Download job & open Resolve**. The first time, allow your browser to open **Reel Bin Bridge**, and allow the helper to read **Downloads**.
4. Resolve opens and **builds the project by itself**. If Resolve opens to the Project Manager with no project loaded, open any project and the import starts within a few seconds. The helper waits up to 10 minutes.

## What the script builds
| Timeline | Contents |
|---|---|
| Team · all marks | Every mark in clip order, trimmed to its in/out (first chosen format) |
| Player · format | One per player per chosen format (Wide 16:9, Vertical 9:16, Standard 4:3, Square 1:1), with the name/number bug |

**File settings** (set in the Send to Resolve dialog, applied to every timeline and render job):
| Format | HD | 4K / UHD |
|---|---|---|
| Wide 16:9 | 1920×1080 | 3840×2160 |
| Vertical 9:16 | 1080×1920 | 2160×3840 |
| Standard 4:3 | 1440×1080 | 2880×2160 |
| Square 1:1 | 1080×1080 | 2160×2160 |

- **Codec:** H.264 (.mp4) for posting, H.265/HEVC (.mp4) for smaller files at the same quality, or ProRes 422 HQ (.mov) as a master.
- **Frame rate:** 23.976–60. One rate for the whole project; 59.94 clips play at half rate in a 29.97 timeline.
- **Rendering:** jobs are added to the Deliver queue, one file per timeline. Turn on **Start rendering** to export without touching Resolve.
- **Free edition limit:** renders cap at UHD and 60 fps.

- **Markers** on each clip: Cyan = Team, Sand = B-roll, Fuchsia = has editing directions. The play type is the marker name. Players, directions, notes and the Zoom tag are in the marker note.
- **Look:** a Fusion **FileLUT** node with your Broadcast LUT at the job's mix (50% default). It's applied before the name bug, so the bug keeps its colors. Color page nodes stay free for your own grade.
- **Framing** (any format narrower than the clip): a Fusion **Merge** over a background at the timeline size, with **Center** and **Size** keyframed from the Vertical Maker. You can edit the curves in the Fusion page (Spline view). Marks with no Vertical Maker keyframes use their Zoom tag as fixed framing.
- **Name bug:** a Text+ node (Oswald Bold, bottom-left). Edit the text, size or position in the Fusion page.

## Still done by hand in Resolve
- Transitions such as Noise 18. Resolve's script API can't add transitions.
- Music and sound effects, then Deliver.
- Speed changes from the Vertical Maker aren't carried over. Retime in Resolve.

## Troubleshooting
- **The import didn't start by itself:** Accessibility isn't on for Reel Bin Bridge (the helper shows a dialog with a button to the setting). Choose **Workspace › Scripts › Reel Bin Import** by hand meanwhile.
- **No "Reel Bin Import" in Workspace › Scripts:** restart Resolve. Check that `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/Reel Bin Import.lua` exists.
- **The script says a clip is missing:** the folder path in Send to Resolve is wrong, or the clip has a different name.
- **The browser didn't open Resolve:** run the installer again, then click **Open Resolve again** in the dialog. Or move the downloaded `.rbjob.lua` into `~/Movies/Reel Bin Jobs` and run the script; it picks up the newest job.
- **Messages from the script** appear in **Workspace › Console** (Lua tab).
