--[[
  Reel Bin Import for DaVinci Resolve (free and Studio)
  Run from Resolve:  Workspace > Scripts > Reel Bin Import

  Reads the newest job sent from Reel Bin (a *.rbjob.lua file in ~/Movies/Reel Bin Jobs)
  and builds a project:
    - Team timeline (every mark, in order) and one timeline per player
    - color-coded markers on every clip (play, direction, notes)
    - Broadcast LUT at the job's strength, via a Fusion FileLUT node
    - name / number bug (Text+) per player
    - one set of timelines per chosen format (16:9, 9:16, 4:3, 1:1); formats narrower than
      the clip are framed by the Vertical Maker keyframes (or Zoom tag) as an editable
      Merge transform (Center + Size keyframes) in each clip's Fusion comp
    - render jobs per timeline with the job's resolution, frame rate and codec (optional auto-start)

  Installed by install.command, which replaces __HOME__ with your home folder.
]]

local HOME = "__HOME__"
local JOBS = HOME .. "/Movies/Reel Bin Jobs"

local function say(fmt, ...) print("[Reel Bin] " .. string.format(fmt, ...)) end
local function trim(s) return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", "")) end
local function readfile(p) local f = io.open(p, "r"); if not f then return nil end local s = f:read("*a"); f:close(); return s end
local function writefile(p, s) local f = io.open(p, "w"); if not f then return false end f:write(s); f:close(); return true end
local function exists(p) local f = io.open(p, "rb"); if f then f:close(); return true end return false end
local function set(tool, input, value) local ok = pcall(function() tool[input] = value end); return ok end

resolve = resolve or (Resolve and Resolve())
if not resolve then print("[Reel Bin] Open DaVinci Resolve and run this from Workspace > Scripts.") return end

------------------------------------------------------------------ find the job
local function listDir(pattern)
  local out = {}
  if bmd and bmd.readdir then
    local d = bmd.readdir(pattern)
    if d then for _, e in ipairs(d) do out[#out + 1] = e end end
  end
  return out
end

local jobPath = trim(readfile(JOBS .. "/pending.txt"))
if jobPath == "" or not exists(jobPath) then
  jobPath = nil
  local newest
  for _, e in ipairs(listDir(JOBS .. "/*.rbjob.lua")) do
    if not e.IsDir and (not newest or e.Name > newest) then newest = e.Name end
  end
  if newest then jobPath = JOBS .. "/" .. newest end
end
if not jobPath then
  say("No job found in %s. In Reel Bin, click Send to Resolve first.", JOBS)
  return
end
local okJob, job = pcall(dofile, jobPath)
if not okJob or type(job) ~= "table" then say("Could not read job %s: %s", jobPath, tostring(job)) return end
say("Job: %s (%d marks)", jobPath, #job.marks)

------------------------------------------------------------------ project
local pm = resolve:GetProjectManager()
local base = job.project or "Reel Bin"
local project, name = nil, base
for i = 1, 30 do
  project = pm:CreateProject(name)
  if project then break end
  name = base .. " (" .. (i + 1) .. ")"
end
if not project then say("Could not create a project named %s", base) return end
say("Project: %s", name)
project:SetSetting("timelineFrameRate", tostring(job.fps or "29.97"))
project:SetSetting("timelinePlaybackFrameRate", tostring(job.fps or "29.97"))
project:SetSetting("timelineResolutionWidth", "1920")
project:SetSetting("timelineResolutionHeight", "1080")

------------------------------------------------------------------ media
local EXTS = {"", ".mp4", ".MP4", ".mov", ".MOV", ".m4v", ".M4V", ".mts", ".MTS"}
local folders = {job.sourceFolder}
for _, e in ipairs(listDir(job.sourceFolder .. "/*")) do
  if e.IsDir and e.Name ~= "." and e.Name ~= ".." then folders[#folders + 1] = job.sourceFolder .. "/" .. e.Name end
end
local function findClip(clip)
  for _, dir in ipairs(folders) do
    for _, ext in ipairs(EXTS) do
      local p = dir .. "/" .. clip .. ext
      if exists(p) then return p end
    end
  end
  return nil
end

local mp = project:GetMediaPool()
local bin = mp:AddSubFolder(mp:GetRootFolder(), "Reel Bin clips")
if bin then mp:SetCurrentFolder(bin) end
local paths, pathByClip, missing = {}, {}, {}
for _, m in ipairs(job.marks) do
  if not pathByClip[m.clip] then
    local p = findClip(m.clip)
    if p then pathByClip[m.clip] = p; paths[#paths + 1] = p else missing[m.clip] = true end
  end
end
local itemByClip = {}
if #paths > 0 then
  local items = mp:ImportMedia(paths) or {}
  for _, it in ipairs(items) do
    local fname = it:GetName() or ""
    local stem = fname:gsub("%.[^%.]+$", "")
    itemByClip[stem] = it; itemByClip[fname] = it
  end
end
for clip in pairs(missing) do say("Missing source clip: %s (looked in %s and its subfolders)", clip, job.sourceFolder) end

------------------------------------------------------------------ helpers
local COLORS = {Team = "Cyan", ["B-roll"] = "Sand", direction = "Fuchsia"}
local function markerFor(m)
  local color = COLORS[m.category] or "Cyan"
  if m.directions and #m.directions > 0 then color = COLORS.direction end
  local who = {}
  for _, p in ipairs(m.players or {}) do who[#who + 1] = p.name .. ((p.number and p.number ~= "") and (" #" .. p.number) or "") end
  local title = (#(m.plays or {}) > 0) and table.concat(m.plays, ", ") or (m.category or "Team")
  local note = table.concat({
    "Players: " .. (#who > 0 and table.concat(who, ", ") or "-"),
    "Direction: " .. table.concat(m.directions or {}, ", "),
    "Notes: " .. table.concat(m.notes or {}, " | "),
    "Zoom tag: " .. tostring(m.zoom or "Full")
  }, "\n")
  return color, title, note
end

local function clipFps(item)
  local f = tonumber(item:GetClipProperty("FPS") or "") or tonumber(job.fps) or 29.97
  return f
end

local lutOK = job.options.lut and job.lut and job.lut.path and exists(job.lut.path)
if job.options.lut and not lutOK then say("LUT not found: %s (skipping the look)", tostring(job.lut and job.lut.path)) end

-- Build the Fusion chain for one timeline clip:
--   MediaIn -> [FileLUT @ mix] -> [Merge onto 9:16 Background, keyframed] -> [Merge Text+ bug] -> MediaOut
local function buildComp(ti, m, W, H, fr, bugText)
  local vertical = fr ~= nil
  if not (lutOK or vertical or bugText) then return end
  local comp = ti:AddFusionComp()
  if not comp then comp = ti:GetFusionCompByIndex(1) end
  if not comp then say("Could not open a Fusion comp for %s", m.clip) return end
  comp:Lock()
  local mi, mo = comp:FindTool("MediaIn1"), comp:FindTool("MediaOut1")
  if not (mi and mo) then comp:Unlock(); say("Fusion comp for %s has no MediaIn/MediaOut", m.clip) return end
  local last = mi
  if lutOK then
    local l = comp:AddTool("FileLUT", -32768, -32768)
    set(l, "LUTFile", job.lut.path); set(l, "Blend", job.lut.mix or 0.5)
    l.Input = last.Output; last = l
  end
  if vertical then
    local bg = comp:AddTool("Background", -32768, -32768)
    set(bg, "UseFrameFormatSettings", 0); set(bg, "Width", W); set(bg, "Height", H)
    set(bg, "TopLeftRed", 0); set(bg, "TopLeftGreen", 0); set(bg, "TopLeftBlue", 0); set(bg, "TopLeftAlpha", 1)
    local mg = comp:AddTool("Merge", -32768, -32768)
    mg.Background = bg.Output; mg.Foreground = last.Output
    set(mg, "PerformDepthMerge", 0)
    -- Source size as Fusion sees it (falls back to the size the browser measured).
    local fgW, fgH = m.src.w, m.src.h
    pcall(function()
      local img = mi.Output[comp.CurrentTime]
      if img and img.Width and img.Width > 0 then fgW, fgH = img.Width, img.Height end
    end)
    local attrs = comp:GetAttrs() or {}
    local start = attrs.COMPN_RenderStart or attrs.COMPN_GlobalStart or 0
    local stop = attrs.COMPN_RenderEnd or (start + math.floor((m["end"] - m.start) * 29.97))
    local rate = tonumber(job.fps) or 29.97
    pcall(function() rate = comp:GetPrefs("Comp.FrameFormat.Rate") or rate end)
    local n = #fr.cx
    local function sampleAt(sec)
      local i = math.floor(sec / fr.step + 0.5) + 1
      if i < 1 then i = 1 elseif i > n then i = n end
      return fr.cx[i], fr.cy[i], fr.hf[i]
    end
    local function place(sec)
      local cx, cy, hf = sampleAt(sec)
      local h = hf * fgH
      local s = H / h
      local dx, dy = cx * fgW - fgW / 2, cy * fgH - fgH / 2
      return {0.5 - s * dx / W, 0.5 + s * dy / H}, s
    end
    if n <= 1 then
      local c, s = place(0)
      set(mg, "Center", c); set(mg, "Size", s)
    else
      mg.Center = comp:XYPath(); mg.Size = comp:BezierSpline()
      local prevC, prevS
      for f = start, stop do
        local c, s = place((f - start) / rate)
        -- only key frames that change, so the curves stay editable
        if not prevC or math.abs(c[1] - prevC[1]) > 1e-4 or math.abs(c[2] - prevC[2]) > 1e-4 or math.abs(s - prevS) > 1e-4 or f == stop then
          mg.Center[f] = c; mg.Size[f] = s
          prevC, prevS = c, s
        end
      end
    end
    last = mg
  end
  if bugText then
    local t = comp:AddTool("TextPlus", -32768, -32768)
    set(t, "UseFrameFormatSettings", 0); set(t, "Width", W); set(t, "Height", H)
    set(t, "StyledText", bugText); set(t, "Font", job.font or "Oswald"); set(t, "Style", "Bold")
    local tall = H > W
    set(t, "Size", tall and 0.05 or 0.06)
    set(t, "HorizontalJustificationNew", 0)          -- left
    set(t, "Center", tall and {0.30, 0.13} or {0.22, 0.10})
    local mt = comp:AddTool("Merge", -32768, -32768)
    mt.Background = last.Output; mt.Foreground = t.Output
    last = mt
  end
  mo.Input = last.Output
  comp:Unlock()
end

local BUILT = {}
local function buildTimeline(tlName, marks, fmt, bugText)
  local infos, used = {}, {}
  for _, m in ipairs(marks) do
    local it = itemByClip[m.clip]
    if it then
      local fps = clipFps(it)
      local sf = math.floor(m.start * fps + 0.5)
      local ef = math.max(sf + 1, math.floor(m["end"] * fps + 0.5) - 1)
      infos[#infos + 1] = {mediaPoolItem = it, startFrame = sf, endFrame = ef}
      used[#used + 1] = m
    end
  end
  if #infos == 0 then say("Skipped %s: none of its clips were found", tlName) return end
  local tl = mp:CreateEmptyTimeline(tlName)
  if not tl then say("Could not create timeline %s", tlName) return end
  project:SetCurrentTimeline(tl)
  local W, H = fmt.w, fmt.h
  tl:SetSetting("useCustomSettings", "1")
  tl:SetSetting("timelineResolutionWidth", tostring(W))
  tl:SetSetting("timelineResolutionHeight", tostring(H))
  tl:SetSetting("timelineFrameRate", tostring(job.fps or "29.97"))
  mp:AppendToTimeline(infos)
  -- Video track 1 holds exactly the clips just appended, in mark order.
  local videoItems = tl:GetItemListInTrack("video", 1) or {}
  local tlStart = tl:GetStartFrame()
  for i, ti in ipairs(videoItems) do
    local m = used[i]
    if not m then break end
    if job.options.markers then
      local color, title, note = markerFor(m)
      pcall(function() tl:AddMarker(ti:GetStart() - tlStart, color, title, note, 1, m.id or "") end)
    end
    local fr = m.frames and m.frames[fmt.key] or nil
    local ok, err = pcall(buildComp, ti, m, W, H, fr, bugText)
    if not ok then say("Fusion setup failed on %s: %s", m.clip, tostring(err)) end
  end
  say("Timeline %s: %d clips", tlName, #videoItems)
  BUILT[#BUILT + 1] = {tl = tl, name = tlName, fmt = fmt}
end

------------------------------------------------------------------ timelines
local byPlayer, order = {}, {}
for _, m in ipairs(job.marks) do
  for _, p in ipairs(m.players or {}) do
    if not byPlayer[p.name] then byPlayer[p.name] = {player = p, marks = {}}; order[#order + 1] = p.name end
    table.insert(byPlayer[p.name].marks, m)
  end
end
local function bugFor(p)
  if not job.options.title then return nil end
  return string.upper(p.name) .. ((p.number and p.number ~= "") and ("  #" .. p.number) or "")
end

local formats = job.formats or {{key = "16:9", w = 1920, h = 1080}}
local multi = #formats > 1
local function tlName(base, fmt) return multi and (base .. " · " .. fmt.key) or base end
if job.options.team then buildTimeline(tlName("Team · all marks", formats[1]), job.marks, formats[1], nil) end
if job.options.players then
  for _, fmt in ipairs(formats) do
    for _, nm in ipairs(order) do buildTimeline(tlName(nm, fmt), byPlayer[nm].marks, fmt, bugFor(byPlayer[nm].player)) end
  end
end

------------------------------------------------------------------ render jobs
local r = job.render
if r and r.queue and #BUILT > 0 then
  local codec
  pcall(function()
    for desc, key in pairs(project:GetRenderCodecs(r.format) or {}) do
      if string.find(desc, r.codecMatch, 1, true) then codec = key end
    end
  end)
  if not codec then codec = ({["H.264"] = "H264", ["H.265"] = "H265", ["422 HQ"] = "ProRes422HQ"})[r.codecMatch] end
  os.execute('mkdir -p "' .. r.folder .. '"')
  local queued = 0
  for _, b in ipairs(BUILT) do
    project:SetCurrentTimeline(b.tl)
    local okFmt = project:SetCurrentRenderFormatAndCodec(r.format, codec)
    if not okFmt then say("Resolve refused %s / %s for %s (check the codec is available in this edition)", r.format, tostring(codec), b.name) end
    project:SetRenderSettings({
      SelectAllFrames = true, TargetDir = r.folder, CustomName = (b.name:gsub("[/:]", "-")),
      FormatWidth = b.fmt.w, FormatHeight = b.fmt.h, FrameRate = tonumber(job.fps) or 29.97,
      ExportVideo = true, ExportAudio = true
    })
    if project:AddRenderJob() then queued = queued + 1 end
  end
  say("Queued %d render jobs (%s, %s fps) to %s", queued, r.codecLabel or codec, tostring(job.fps), r.folder)
  if r.start and queued > 0 then
    pcall(function() resolve:OpenPage("deliver") end)
    project:StartRendering()
    say("Rendering started")
  end
end
if BUILT[1] then project:SetCurrentTimeline(BUILT[1].tl) end

writefile(JOBS .. "/pending.txt", "")
pm:SaveProject()
say("Done. Project \"%s\" is ready. Timelines are in the Media Pool.", name)
