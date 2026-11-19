#!/usr/bin/env python3
"""
tapecut.py - Tape Man auto-cutter.

Turns a tap log from the Tape Man Tap Logger page + your camera files into:
  clips/clean/     full-quality 15-30 s clips (for paid downloads)
  clips/preview/   small watermarked previews (for the gallery)
  clips/manifest.csv / manifest.json   one row per clip

How syncing works
  Every time you start a recording you hold the phone to the lens and tap SYNC.
  The page flashes white/black/white/black/white (400 ms each) and logs the
  phone time of the first white. This script finds that flash in the video,
  so phone time -> video time is exact for that recording.
  Camera files with no flash (e.g. the XA20 splitting one long recording
  every 4 GB) are treated as a straight continuation of the previous file.

Usage
  python3 tapecut.py taplog.json CAM1.MP4 CAM2.MP4 ...   (files in recording order)

Useful options
  --pre 12 --post 6        seconds kept before / after each tap (default 12 / 6)
  --hw                     use the Mac's hardware encoder (much faster on Apple Silicon)
  --dry-run                only detect syncs and print the clip plan, no cutting
  --sync FILE=SECONDS      manual override: the first white flash is at SECONDS in FILE
                           (use if auto-detect misses; scrub to the flash in QuickTime)
  --scan 300               how many seconds at the start of each file to search for a flash
"""
import argparse, csv, json, os, shutil, subprocess, sys
from datetime import datetime

def die(msg):
    print("ERROR: " + msg, file=sys.stderr); sys.exit(1)

def need(tool):
    if not shutil.which(tool):
        die(f"{tool} not found. Install with: brew install ffmpeg")

def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", path], capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        die(f"Could not read duration of {path}")

def luma_series(path, scan_s, fps=25):
    """Average brightness per frame for the first scan_s seconds (downscaled, fast)."""
    cmd = ["ffmpeg", "-v", "error", "-t", str(scan_s), "-i", path,
           "-vf", f"fps={fps},scale=64:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
           "-an", "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    times, ys, t = [], [], None
    for line in out.splitlines():
        if line.startswith("frame:"):
            for part in line.split():
                if part.startswith("pts_time:"):
                    t = float(part.split(":", 1)[1])
        elif "YAVG=" in line and t is not None:
            times.append(t); ys.append(float(line.split("=", 1)[1]))
    return times, ys

def find_flash(path, scan_s):
    """Find the W-B-W-B-W pattern: three bright rises ~0.8 s apart. Returns time of first rise or None."""
    times, ys = luma_series(path, scan_s)
    if len(ys) < 10:
        return None
    # 2-frame difference tolerates camera auto-exposure smearing an edge over a couple of frames
    d = [0.0, 0.0] + [ys[i] - ys[i - 2] for i in range(2, len(ys))]
    absd = sorted(abs(x) for x in d[2:])
    mad = absd[len(absd) // 2]
    thr = max(6.0, 10 * mad)
    # edges = local peaks of |d| above threshold, at most one per 0.2 s
    edges = []  # (time, +1 rise / -1 fall, strength)
    for i in range(2, len(d)):
        if abs(d[i]) < thr:
            continue
        if i + 1 < len(d) and abs(d[i + 1]) > abs(d[i]) and (d[i + 1] > 0) == (d[i] > 0):
            continue  # not the peak yet
        t = times[i - 1]  # first changed frame
        if edges and t - edges[-1][0] < 0.2 and edges[-1][1] == (1 if d[i] > 0 else -1):
            continue
        edges.append((t, 1 if d[i] > 0 else -1, abs(d[i])))
    expected = [(0.0, 1), (0.4, -1), (0.8, 1), (1.2, -1), (1.6, 1), (2.0, -1)]
    tol = 0.13
    def score(a):
        hit = 0
        for off, sign in expected:
            if any(abs(t - (a + off)) <= tol and s == sign for t, s, _ in edges):
                hit += 1
        return hit
    # anchors: every rise, plus rises shifted back in case the first white edge was weak/missed
    anchors = sorted({round(t - k, 3) for t, s, _ in edges if s == 1 for k in (0.0, 0.8, 1.6)})
    for a in anchors:
        if a < 0:
            continue
        if score(a) >= 5:
            exact = [t for t, s, _ in edges if s == 1 and abs(t - a) <= tol]
            return exact[0] if exact else a
    return None

def font_file():
    for f in ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
              "/System/Library/Fonts/Supplemental/Arial.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"]:
        if os.path.exists(f):
            return f
    return None

def encoder_args(hw, quality):
    if hw:
        return ["-c:v", "h264_videotoolbox", "-b:v", "10M" if quality == "clean" else "1200k"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20" if quality == "clean" else "30"]

def main():
    ap = argparse.ArgumentParser(description="Cut Tape Man clips from a tap log.")
    ap.add_argument("log"); ap.add_argument("files", nargs="+")
    ap.add_argument("--pre", type=float, default=12); ap.add_argument("--post", type=float, default=6)
    ap.add_argument("--out", default="clips"); ap.add_argument("--scan", type=float, default=300)
    ap.add_argument("--hw", action="store_true"); ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--sync", action="append", default=[], help="FILE=SECONDS manual flash time")
    ap.add_argument("--no-preview", action="store_true")
    a = ap.parse_args()
    need("ffmpeg"); need("ffprobe")

    log = json.load(open(a.log))
    syncs = sorted([e for e in log["events"] if e["type"] == "sync"], key=lambda e: e["t"])
    marks = sorted([e for e in log["events"] if e["type"] == "mark"], key=lambda e: e["t"])
    if not syncs: die("The log has no SYNC events.")
    manual = {}
    for s in a.sync:
        f, v = s.rsplit("=", 1); manual[os.path.basename(f)] = float(v)

    # Build a timeline: for each file, the phone time (ms) at video t=0
    segs, si, prev = [], 0, None
    print("\nSYNC CHECK")
    for path in a.files:
        if not os.path.exists(path): die(f"Missing file {path}")
        dur = duration(path); base = os.path.basename(path)
        flash = manual.get(base)
        how = "manual"
        if flash is None:
            flash = find_flash(path, min(a.scan, dur)); how = "auto"
        if flash is not None:
            if si >= len(syncs):
                die(f"{base}: found a flash at {flash:.2f}s but the log has no more SYNC taps.")
            start_ms = syncs[si]["t"] - flash * 1000
            print(f"  {base:28s} flash at {flash:7.2f}s ({how}) -> SYNC #{syncs[si]['n']}  dur {dur/60:5.1f} min")
            si += 1
        else:
            if prev is None:
                die(f"{base}: no flash found in the first {a.scan:.0f}s. "
                    f"Scrub to the first white flash and rerun with --sync {base}=SECONDS")
            start_ms = prev["start_ms"] + prev["dur"] * 1000
            print(f"  {base:28s} no flash -> continuation of {prev['name']}  dur {dur/60:5.1f} min")
        seg = {"path": path, "name": base, "dur": dur, "start_ms": start_ms}
        segs.append(seg); prev = seg
    if si < len(syncs):
        print(f"  WARNING: {len(syncs)-si} SYNC tap(s) in the log were not matched to a flash.")

    # Map marks to clips
    plan, skipped = [], 0
    for i, m in enumerate(marks, 1):
        seg = next((s for s in segs if s["start_ms"] <= m["t"] < s["start_ms"] + s["dur"] * 1000), None)
        if not seg:
            skipped += 1; continue
        vt = (m["t"] - seg["start_ms"]) / 1000
        st, en = max(0.0, vt - a.pre), min(seg["dur"], vt + a.post)
        plan.append({"clip_id": f"c{i:03d}", "quarter": m.get("q", ""), "jersey": m.get("jersey", ""),
                     "tap_local": datetime.fromtimestamp(m["t"] / 1000).strftime("%H:%M:%S"),
                     "file": seg["name"], "src": seg["path"], "tap_s": round(vt, 2),
                     "start_s": round(st, 2), "end_s": round(en, 2), "len_s": round(en - st, 1)})
    print(f"\nCLIP PLAN  {len(plan)} clips" + (f", {skipped} taps fell outside any recording" if skipped else ""))
    for c in plan:
        print(f"  {c['clip_id']}  {c['quarter']:3s}  #{c['jersey'] or '-':6s} {c['file']:24s} "
              f"{c['start_s']:8.1f}-{c['end_s']:8.1f}s  ({c['len_s']}s)")
    if a.dry_run:
        return

    clean_dir = os.path.join(a.out, "clean"); prev_dir = os.path.join(a.out, "preview")
    os.makedirs(clean_dir, exist_ok=True)
    if not a.no_preview: os.makedirs(prev_dir, exist_ok=True)
    game = (log.get("game") or "game").strip()
    slug = "".join(ch if ch.isalnum() else "-" for ch in game).strip("-").lower() or "game"
    ff = font_file()
    wm = "TAPE MAN PREVIEW"
    for n, c in enumerate(plan, 1):
        tag = c["quarter"] + (("_" + c["jersey"].replace(" ", "-")) if c["jersey"] else "")
        stem = f"{slug}_{c['clip_id']}_{tag}"
        clean = os.path.join(clean_dir, stem + ".mp4")
        cmd = ["ffmpeg", "-v", "error", "-y", "-ss", str(c["start_s"]), "-i", c["src"], "-t", str(c["end_s"] - c["start_s"]),
               *encoder_args(a.hw, "clean"), "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", clean]
        subprocess.run(cmd, check=True)
        c["clean"] = clean
        if not a.no_preview:
            prev = os.path.join(prev_dir, stem + "_preview.mp4")
            vf = "scale=-2:'min(480,ih)'"
            if ff:
                vf += (f",drawtext=fontfile='{ff}':text='{wm}':fontcolor=white@0.35:fontsize=h/9:"
                       f"x=(w-text_w)/2:y=(h-text_h)/2:borderw=2:bordercolor=black@0.25")
            else:
                vf += ",drawbox=x=0:y=ih/2-30:w=iw:h=60:color=red@0.35:t=fill"
            cmd = ["ffmpeg", "-v", "error", "-y", "-ss", str(c["start_s"]), "-i", c["src"], "-t", str(c["end_s"] - c["start_s"]),
                   "-vf", vf, *encoder_args(a.hw, "preview"), "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", prev]
            subprocess.run(cmd, check=True)
            c["preview"] = prev
        print(f"  [{n}/{len(plan)}] {stem}")

    fields = ["clip_id", "quarter", "jersey", "tap_local", "file", "tap_s", "start_s", "end_s", "len_s", "clean", "preview"]
    with open(os.path.join(a.out, "manifest.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore"); w.writeheader(); w.writerows(plan)
    json.dump({"game": game, "clips": plan}, open(os.path.join(a.out, "manifest.json"), "w"), indent=2)
    print(f"\nDone. {len(plan)} clips in {a.out}/  (manifest.csv lists them all)")

if __name__ == "__main__":
    main()
