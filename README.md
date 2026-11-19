# Reel Bin Studio (web)

Mark basketball highlights by player, then turn wide clips into vertical 9:16 reels.
The app is a static PWA with no build step, no server, and no accounts. Video files never leave the device.

- **Reel Marker**: every feature from Reel bin v8, rebuilt in the Reel Bin Studio shell.
- **Vertical Maker**: a wide-to-vertical reframer modeled on the Cropper workflow, with an original design.
- **Mac-app steps** (Library, Import and link, Platform, Inspire, Decision brief, Preview, Export + recipe) appear in the rail as locked entries. They need bundled ffmpeg and Gemini, which a web page can't run.

## Deploy to Vercel (about 5 minutes)

1. Create a new GitHub repo, for example `reel-bin-studio`, and upload everything in this folder to the repo root. `index.html` must sit at the top level.
2. In Vercel, choose **Add New → Project**, import the repo, and use these settings:
   - Framework preset: **Other**
   - Build command: *(leave empty)*
   - Output directory: *(leave empty, which means the repo root)*
3. Click **Deploy**. `vercel.json` already sets the service-worker and manifest headers.
4. On iPhone, open the URL in Safari, tap **Share → Add to Home Screen**, and it installs like an app.

**When you ship an update**, bump `VERSION` in `sw.js` (for example `rbs-v1.0.1`) so installed copies pick up the new files.

### Run locally
```bash
cd reel-bin-studio-web
python3 -m http.server 8080   # then open http://localhost:8080
```
Opening `index.html` directly as a file works too, but the offline cache only turns on over http(s).

## Where data lives

| Data | Where | Survives reload | Moves between devices |
|---|---|---|---|
| Teams, rosters, tag libraries, marks | This browser (localStorage) | Yes | Use **Back up** on one device and **Restore** on the other |
| Video files | Never stored | No; add them again | No |

- **Marks re-attach by file name.** After a reload, clips with saved marks show **no file**. Add the same files again and the marks come back.
- **Back up** downloads one JSON file containing teams, tag libraries and marks.
- **Restore** merges that file into the current data. It also accepts a v8 `highlight_marks.json` or a marks CSV.
- **Clearing Safari or Chrome site data erases local data.** Back up after each game.

## Reel Marker: v8 feature parity

| v8 feature | Status |
|---|---|
| Multi-team setup: name, school, opponent, game date/time, sport, home and away jersey colors | ✓ Volleyball added |
| Roster: name and number, add player | ✓ Remove player added |
| Team drawer collapse, remembered | ✓ |
| Clip queue: add files, drag-drop anywhere, remove clip, marks count | ✓ |
| hints.json scene ticks, fps, jersey flags | ✓ |
| Hide clips under 3 s, with count | ✓ |
| Game date auto-filled from the first clip's file date | ✓ |
| Scrub bar, timecodes, play/pause, frame step, speed 0.25–2× | ✓ Drag-scrub, existing-mark ranges, pending in/out range added |
| In/out: set in, set out, in at 0:00, out at end | ✓ Length readout added |
| Multi-player chips, category (Team / B-roll), zoom tag (Full, Zoom L/C/R, Tight) | ✓ |
| Play-type library per sport and direction library, type to add | ✓ |
| One-off notes, auto-flushed on Add mark | ✓ |
| Marks table: 6 filters, text search, sortable columns, delete | ✓ Click a row to jump to that mark |
| Export JSON (same shape as v8, plus `id`) and CSV; import JSON or CSV, updating in place | ✓ |
| Keyboard: Space, I, O, ←/→, ↑/↓, 1–9 | ✓ N/P, F, T, C and Enter added |
| Fullscreen edit with HUD, tag tray, auto-hide | ✓ See below |
| Cloud sync through the Claude artifact database | **Replaced** by local-first storage plus Back up / Restore. The artifact database doesn't exist on Vercel. |

### Fullscreen edit: moving between clips without leaving
- Large **‹ PREV / NEXT ›** buttons sit on the left and right edges. The bottom bar also has **‹ Clip / Clip ›**.
- Keyboard: **↑/↓**, **P/N** or **PageUp/PageDown**. On phones and tablets, **swipe left or right**.
- **Clips ▾** opens a strip of every clip, so you can jump straight to one. A **2 / 17** counter and a toast show where you are.
- If a clip is playing, the next one starts playing too. **Auto-play** makes it always start.
- Each clip keeps its own unfinished in/out points, so stepping back and forth doesn't lose them.
- Clips whose video file isn't loaded are skipped. The fix: v8 left the previous clip's video on screen under the new clip's name.
- The stage moves to the top of the page while it's maximized. This fixes the glass panels trapping a fixed overlay.

## Vertical Maker (Cropper-style workflow)

| Cropper feature | Here |
|---|---|
| Frame by dragging; pinch to zoom | Drag anywhere on the picture. Zoom with scroll wheel, pinch, the corner dot or the slider. |
| Keyframes (pins); previous/next; edit a pin | Any framing change while paused drops a ◆. **K** adds one, **[ ]** jumps between them, **Delete** removes the selected one, **Reset** clears all. **Drag a ◆ to retime it.** |
| Hand: live tracking, then a second pass | Drag while the clip plays to paint a path (a sample about every 0.3 s). Replay and zoom (scroll, pinch, slider or corner dot) for a second pass: zoom is recorded over time and **your pan is kept**. |
| Transitions per pin: Movie / Sport / Smooth | Same meanings as Cropper. **Smooth** glides into the pin; **Sport** holds, then snap-pans in (0.35 s); **Movie** holds, then cuts. Set a default, or select a ◆ and change just that one. The ffmpeg script follows the same transitions. |
| Trim from the full clip | Drag the teal handles on the track, or **Set at playhead**. |
| Join clips and reorder | Clip list with ▲▼. Each clip keeps its own trim, keyframes and speed. |
| Speed 0.25–2× | Per clip, with pitch-corrected audio. |
| Logo: position, size, opacity | Logo tab. Baked into the export. |
| Output format 9:16 / 1:1 / 16:9 | **Format** chips in the Frame tab. |
| Export MP4: source size or max quality | **Render vertical video**: 1080×1920 or source size, 30 or 60 fps. |
| Watermark on free exports | None. |
| Not in V1 | Captions (speech-to-text, which Cropper does with Whisper on-device), Enhance (Light/Auto/Manual), Dual View (top/bottom split), Track (AI subject lock). The first three are planned for V1.1. Auto-tracking drifted on your real footage, so framing is manual by design. |

**Reel Marker integration:** **To Vertical ›** in Marks, or **Load marks from Reel Marker** in the Vertical Maker, turns each mark into a trimmed clip. Each clip starts framed by its Zoom tag:

| Zoom tag | Zoom | Upscale to 1080×1920 |
|---|---|---|
| Full | 1.0× | 1.78× |
| Zoom L / C / R | 1.33× | 2.37× |
| Tight | 2.0× | 3.56× |

You can filter by player. The **sharpness readout** turns orange at 1.9× upscale and red above 2.4×.

### Two ways to export
1. **In the browser.** Renders in real time (a 20 s reel takes about 20 s), so keep the tab in front. Recent Chrome and Safari save H.264 MP4. Some browsers can only save WebM, or VP9 inside MP4. If Instagram rejects a file, use option 2.
2. **On your Mac, full quality.** Download **ffmpeg script (.sh)** and put it next to the source clips (plus `logo.png` if you used a logo). Then run:
   ```bash
   bash vertical_reframe.sh
   ```
   The script renders each clip at 1080×1920 H.264 with BT.709 color tags, using the same keyframes, easing and animated zoom, then joins the clips into `vertical_reel.mp4`. It needs ffmpeg 5 or later (`brew install ffmpeg`).
   **Keyframes JSON** carries the same data for your own pipeline: per-keyframe center, zoom and crop rectangle in source pixels.

## Send to DaVinci Resolve (companion editor)
Reel Bin does the fast part. Resolve does the timeline, color, transitions, titles and export.

1. **One time:** download the Mac helper from the Send to Resolve dialog (`downloads/reel-bin-resolve-bridge.zip`). Double-click **Install Reel Bin Bridge.command**, then turn on **Accessibility** for Reel Bin Bridge in System Settings.
2. **Each job:** click **Marks → Send to Resolve ›**, check the source folder, and pick:
   - **Formats:** Wide 16:9, Vertical 9:16, Standard 4:3, Square 1:1
   - **Resolution:** HD or 4K
   - **Codec:** H.264, H.265 or ProRes 422 HQ
   - **Frame rate**
   - **Render:** queue only, or queue and start rendering
3. Resolve opens and builds the project by itself:
   - a Team timeline, plus player timelines for each format
   - color-coded markers
   - your look at 50%
   - the Oswald name bug
   - framing keyframes as editable Fusion transforms
   - render jobs

Details and troubleshooting are in `resolve-bridge/README.md`. Transitions such as Noise 18 are still added by hand, because Resolve's script API can't place transitions.

## Files
```
index.html              app shell and both tools
css/studio.css          RDX tokens, rail/drawer, glass, layouts
js/store.js             local storage, event bus, helpers
js/shell.js             icon rail + spring drawer
js/marker.js            Reel Marker
js/vertical.js          Vertical Maker + ffmpeg script builder
js/resolve.js           Send to Resolve: job file (.rbjob.lua) + dialog
resolve-bridge/         Mac helper (reelbin:// links), installer, Resolve import script
downloads/              the helper kit as a zip, linked from the app
sw.js                   offline cache (bump VERSION on release)
manifest.webmanifest    PWA install
vercel.json             headers
icons/                  app icons
```

## Color code (from the Studio design)
- **Lime**: automated or done
- **Teal**: your action
- **Orange**: costs money or time
- **Red**: blocked or missing
- **Fuchsia**: ambiguous, you decide

## Tested
- Chromium 1600×1000 and 390×844 (iPhone width).
- Clip load, marking, tags, notes, export/import, reload persistence and relinking by file name.
- Fullscreen next/previous with buttons and keys, staying in fullscreen.
- Drawer opening after export.
- Vertical keyframes and zoom, the in-browser render (1080×1920, both clips, 0.5× speed), and the ffmpeg script run end to end.
- Comparing frames from the two exports at 4 timestamps showed matching framing and zoom.
- Not yet tested on a real iPhone or in Safari.
