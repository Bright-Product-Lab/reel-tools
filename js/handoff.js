/* Hand-off: send marks to a companion app (DaVinci Resolve today; more targets later).
   Send to DaVinci Resolve:
   Writes a job file (*.rbjob.lua: a plain Lua table, so Resolve's script reads it with dofile)
   holding the marks, players, look, per-format framing and render settings, then asks the Reel Bin Bridge
   helper (reelbin://) to move it into ~/Movies/Reel Bin Jobs and open Resolve.
   The helper then runs Workspace > Scripts > Reel Bin Import in Resolve, which builds the project. */
(function(){
  const $ = id => document.getElementById(id);
  const KEY = 'rbs_resolve_v1';
  const DEF = {folder: '', out: '', lut: '/Volumes/DeepBag/Load Saver/Video/Ultra_Color_CandyMustache/02_Luts/Broadcast/Broadcast_01.cube', mix: 0.5, fps: '29.97', font: 'Oswald',
    size: 'hd', codec: 'h264', formats: {'16:9': true, '9:16': false, '4:3': false, '1:1': false}, render: {queue: true, start: false},
    opts: {team: true, players: true, markers: true, lut: true, title: true}};
  const OPT_LABEL = {team: 'Team timeline', players: 'Player timelines', markers: 'Markers', lut: 'Look', title: 'Name bug'};
  const FMT_LABEL = {'16:9': 'Wide 16:9', '9:16': 'Vertical 9:16', '4:3': 'Standard 4:3', '1:1': 'Square 1:1'};
  const FMT_AR = {'16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '1:1': 1};
  // Pixel sizes: short side 1080 (HD) or 2160 (4K / UHD), even numbers.
  function dims(key, size){
    const short = size === '4k' ? 2160 : 1080, ar = FMT_AR[key];
    const ev = x => Math.round(x / 2) * 2;
    return ar >= 1 ? {w: ev(short * ar), h: short} : {w: short, h: ev(short / ar)};
  }
  const CODEC = {h264: {label: 'H.264', ext: 'mp4', fmt: 'mp4', match: 'H.264'}, h265: {label: 'H.265', ext: 'mp4', fmt: 'mp4', match: 'H.265'}, prores: {label: 'ProRes 422 HQ', ext: 'mov', fmt: 'mov', match: '422 HQ'}};
  let cfg = Object.assign({}, DEF, RBS.get(KEY, {}) || {});
  cfg.opts = Object.assign({}, DEF.opts, cfg.opts || {});
  cfg.formats = Object.assign({}, DEF.formats, cfg.formats || {});
  cfg.render = Object.assign({}, DEF.render, cfg.render || {});

  // ---------- Lua serializer (strings escaped; keys always bracketed) ----------
  function lstr(s){ return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/[\u0000-\u001f]/g, c => '\\' + c.charCodeAt(0)) + '"'; }
  function toLua(v, ind){
    ind = ind || '';
    if(v === null || v === undefined) return 'nil';
    if(typeof v === 'boolean') return v ? 'true' : 'false';
    if(typeof v === 'number') return isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '0';
    if(typeof v === 'string') return lstr(v);
    if(Array.isArray(v)){
      if(v.every(x => typeof x === 'number')) return '{' + v.map(x => toLua(x)).join(',') + '}';
      return '{\n' + v.map(x => ind + '  ' + toLua(x, ind + '  ')).join(',\n') + '\n' + ind + '}';
    }
    return '{\n' + Object.keys(v).filter(k => v[k] !== undefined).map(k => ind + '  [' + lstr(k) + '] = ' + toLua(v[k], ind + '  ')).join(',\n') + '\n' + ind + '}';
  }

  // ---------- job ----------
  function allMarks(){
    const out = [];
    (RBS.marker ? RBS.marker.clips() : []).forEach(c => c.marks.forEach(m => out.push({c, m})));
    out.sort((a, b) => a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : a.m.start - b.m.start);
    return out;
  }
  // Per-frame crop path for one mark in one output aspect: crop centre (0..1) and height fraction.
  function framing(c, m, fps, ar){
    const V = RBS.vertical;
    const vw = c.vw || 1920, vh = c.vh || 1080;
    let seg = V.segs().find(s => s.fromMark === m.id && s.vw);
    if(!seg){
      const pr = V.presets[m.zoom] || V.presets.Full;
      seg = {vw, vh, kfs: [], base: {cx: pr.cx, cy: .5, z: pr.z}, motion: 'smooth'};
    }
    const sample = t => {
      const st = V.evalCrop(seg, t), r = V.cropRect(seg, st, ar);
      return [(r.x + r.w / 2) / seg.vw, (r.y + r.h / 2) / seg.vh, r.h / seg.vh];
    };
    const step = 1 / fps, f = {step, cx: [], cy: [], hf: []};
    const n = seg.kfs.length ? Math.max(1, Math.round((m.end - m.start) * fps) + 1) : 1;
    for(let i = 0; i < n; i++){
      const s = sample(m.start + i * step);
      f.cx.push(s[0]); f.cy.push(s[1]); f.hf.push(s[2]);
    }
    return {frames: f, src: {w: seg.vw || vw, h: seg.vh || vh}, keyed: seg.kfs.length > 0};
  }
  const chosenFormats = () => Object.keys(FMT_LABEL).filter(k => cfg.formats[k]);
  function buildJob(){
    const list = allMarks();
    const fps = parseFloat(cfg.fps) || 29.97;
    const fmts = chosenFormats();
    let keyed = 0;
    const marks = list.map(({c, m}) => {
      const frames = {};
      let src = {w: c.vw || 1920, h: c.vh || 1080}, k = false;
      fmts.forEach(key => {
        // A format as wide as the clip shows the whole frame; anything narrower gets framed.
        if(Math.abs(FMT_AR[key] - src.w / src.h) < 0.02) return;
        const fr = framing(c, m, fps, FMT_AR[key]);
        frames[key] = fr.frames; src = fr.src; k = k || fr.keyed;
      });
      if(k) keyed++;
      return {id: m.id, clip: c.name, start: m.start, end: m.end, category: m.category || 'Team', team: m.team || '',
        players: (m.players || []).map(p => ({name: p.name, number: p.number || ''})), plays: m.plays || [], directions: m.directions || [],
        notes: m.notes || [], zoom: m.zoom || 'Full', src, frames};
    });
    const codec = CODEC[cfg.codec] || CODEC.h264;
    const out = cfg.out || (cfg.folder.replace(/\/+$/, '') + '/Reel Bin Renders');
    return {job: {version: 2, created: new Date().toISOString(), app: 'reel-bin-studio-web', project: cfg.project, fps: cfg.fps,
      sourceFolder: cfg.folder.replace(/\/+$/, ''), lut: {path: cfg.lut, mix: cfg.mix}, font: cfg.font,
      formats: fmts.map(key => Object.assign({key, label: FMT_LABEL[key]}, dims(key, cfg.size))),
      render: {queue: !!cfg.render.queue, start: !!cfg.render.start, folder: out, format: codec.fmt, codecMatch: codec.match, codecLabel: codec.label},
      options: cfg.opts, marks}, keyed, count: marks.length};
  }

  // ---------- targets ----------
  // Each companion app is one entry. A new app = one more entry with its own settings panel and send().
  const TARGETS = [
    {id: 'resolve', name: 'DaVinci Resolve', blurb: 'Timelines, markers, look, framing, renders', mark: 'DR', color: 'var(--orange)', live: true, bridge: true},
    {id: 'marks', name: 'Marks file', blurb: 'JSON + CSV for any tool or batch render', mark: '{ }', color: 'var(--teal)', live: true, bridge: false},
    {id: 'premiere', name: 'Adobe Premiere Pro', blurb: 'Planned: sequence via Premiere XML', mark: 'Pr', color: 'var(--fuchsia)', live: false,
      plan: 'Planned: a Premiere XML sequence per player with markers and in/out, imported through the same Bridge. Until then, use Marks file with the existing Premiere checklist.'},
    {id: 'finalcut', name: 'Final Cut Pro', blurb: 'Planned: FCPXML library', mark: 'FC', color: 'var(--lime)', live: false,
      plan: 'Planned: an FCPXML event with a project per player and keyworded markers.'},
    {id: 'cartcut', name: 'CartCut', blurb: 'Planned: timeline over its MCP link', mark: 'CC', color: 'var(--ink-3)', live: false,
      plan: 'Planned: build the timeline in CartCut through its MCP server, so Claude can keep editing it.'}
  ];
  let target = RBS.get('rbs_handoff_target', 'resolve') || 'resolve';
  const BKEY = 'rbs_bridge_v1';
  let bridge = Object.assign({downloaded: false, installed: false, access: false, tested: false}, RBS.get(BKEY, {}) || {});
  const bridgeReady = () => bridge.downloaded && bridge.installed && bridge.access && bridge.tested;

  function renderTargets(){
    const el = $('hoTargets'); el.innerHTML = '';
    TARGETS.forEach(t => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'tgt' + (t.id === target ? ' on' : '') + (t.live ? '' : ' planned');
      const chip = !t.live ? '<span class="chip k-grey">Planned</span>' : (t.bridge ? (bridgeReady() ? '<span class="chip k-lime">Ready</span>' : '<span class="chip k-orange">Needs Bridge</span>') : '<span class="chip k-lime">Ready</span>');
      b.innerHTML = `<span class="ti" style="background:${t.color}">${t.mark}</span><span class="tn"><b>${RBS.esc(t.name)}</b><small>${RBS.esc(t.blurb)}</small><span>${chip}</span></span>`;
      b.addEventListener('click', () => { target = t.id; RBS.set('rbs_handoff_target', target); renderAll(); });
      el.appendChild(b);
    });
  }
  function renderBridge(){
    const steps = [
      {k: 'downloaded', t: 'Download the Mac helper', d: 'reel-bin-resolve-bridge.zip', a: '<a class="btn sm teal" href="downloads/reel-bin-resolve-bridge.zip" download data-mark="downloaded">Download</a>'},
      {k: 'installed', t: 'Run the installer', d: 'Unzip, then double-click “Install Reel Bin Bridge.command” (right-click › Open the first time).', a: '<button class="btn sm ghost" data-mark="installed">Done</button>'},
      {k: 'access', t: 'Allow Accessibility', d: 'System Settings › Privacy & Security › Accessibility › add Reel Bin Bridge and switch it on. This is what lets the import start by itself in free Resolve.', a: '<button class="btn sm ghost" data-mark="access">Done</button>'},
      {k: 'tested', t: 'Test the connection', d: 'You should see a “Reel Bin Bridge is connected” notice.', a: '<a class="btn sm teal" href="reelbin://ping" id="hoPing">Test</a><button class="btn sm ghost" data-mark="tested">I saw it</button>'}
    ];
    $('hoBridgeSteps').innerHTML = steps.map((s, i) => `<div class="bstep${bridge[s.k] ? ' done' : ''}"><span class="bn">${bridge[s.k] ? '✓' : i + 1}</span>
      <span class="bt"><b>${s.t}</b><small>${s.d}</small><span class="ba">${s.a}${bridge[s.k] ? `<button class="btn sm ghost" data-unmark="${s.k}">Undo</button>` : ''}</span></span></div>`).join('');
    $('hoBridgeSteps').querySelectorAll('[data-mark]').forEach(el => el.addEventListener('click', () => { bridge[el.dataset.mark] = true; RBS.set(BKEY, bridge); setTimeout(renderAll, el.tagName === 'A' ? 300 : 0); }));
    $('hoBridgeSteps').querySelectorAll('[data-unmark]').forEach(el => el.addEventListener('click', () => { bridge[el.dataset.unmark] = false; RBS.set(BKEY, bridge); renderAll(); }));
    const chip = $('hoBridgeChip');
    const n = ['downloaded', 'installed', 'access', 'tested'].filter(k => bridge[k]).length;
    chip.className = 'chip ' + (n === 4 ? 'k-lime' : n ? 'k-orange' : 'k-grey');
    chip.textContent = n === 4 ? 'Ready' : n ? n + ' of 4 done' : 'Not set up';
  }
  function renderAll(){
    const t = TARGETS.find(x => x.id === target) || TARGETS[0];
    renderTargets(); renderBridge();
    document.querySelectorAll('#view-handoff [data-for]').forEach(el => { el.hidden = !(el.dataset.for === t.id || (el.dataset.for === 'planned' && !t.live)); });
    $('hoPlannedText').textContent = t.plan || '';
    $('hoSettingsTitle').textContent = t.name + ' settings';
    $('hoBridgeCard').hidden = !t.bridge;
    const go = $('rsGo');
    go.disabled = !t.live;
    go.textContent = t.live ? (t.id === 'resolve' ? 'Send to Resolve' : 'Download marks') : 'Coming later';
    $('hoSendHint').hidden = t.id !== 'resolve';
    if(t.id === 'resolve'){ renderOpts(); refreshSummary(); }
    else $('rsSpec').textContent = t.id === 'marks' ? 'highlight_marks.json · highlight_marks.csv' : '';
  }

  // ---------- Resolve settings ----------
  function defaultProject(){
    const t = RBS.marker && RBS.marker.team();
    const d = t && t.gameDate ? new Date(t.gameDate) : new Date();
    const ds = isNaN(d) ? '' : d.toISOString().slice(0, 10);
    return ['Reel Bin', t && t.name, t && t.opponent ? 'vs ' + t.opponent : '', ds].filter(Boolean).join(' · ');
  }
  function chipRow(el, keys, label, isOn, toggle){
    el.innerHTML = '';
    keys.forEach(k => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'cp' + (isOn(k) ? ' on' : '');
      b.textContent = (isOn(k) ? '✓ ' : '') + label[k];
      b.addEventListener('click', () => { toggle(k); renderOpts(); saveCfg(); });
      el.appendChild(b);
    });
  }
  function renderSpec(){
    const fm = chosenFormats(), c = CODEC[$('rsCodec').value] || CODEC.h264, size = $('rsSize').value, fps = $('rsFps').value;
    $('rsSpec').textContent = fm.length ? fm.map(k => { const d = dims(k, size); return `${k} ${d.w}×${d.h}`; }).join(' · ') + ` · ${fps} fps · ${c.label} .${c.ext}` : 'Pick at least one format';
  }
  function renderOpts(){
    chipRow($('rsFormats'), Object.keys(FMT_LABEL), FMT_LABEL, k => cfg.formats[k], k => { cfg.formats[k] = !cfg.formats[k]; });
    chipRow($('rsRender'), ['queue', 'start'], {queue: 'Add render jobs to the queue', start: 'Start rendering when built'}, k => cfg.render[k],
      k => { cfg.render[k] = !cfg.render[k]; if(k === 'start' && cfg.render.start) cfg.render.queue = true; if(k === 'queue' && !cfg.render.queue) cfg.render.start = false; });
    chipRow($('rsOpts'), Object.keys(OPT_LABEL), OPT_LABEL, k => cfg.opts[k], k => { cfg.opts[k] = !cfg.opts[k]; });
    renderSpec();
  }
  function refreshSummary(){
    const list = allMarks(), count = list.length;
    const players = new Set(); list.forEach(({m}) => (m.players || []).forEach(p => players.add(p.name)));
    const keyed = list.filter(({m}) => RBS.vertical.segs().some(s => s.fromMark === m.id && s.kfs.length)).length;
    $('resolveSummary').innerHTML = count ? `<b>${count}</b> marks · <b>${players.size}</b> player${players.size === 1 ? '' : 's'} · <b>${keyed}</b> with keyframes` : 'No marks yet';
  }
  function loadFields(){
    $('rsProject').value = cfg.project && cfg.projectFor === defaultProject() ? cfg.project : defaultProject();
    $('rsFolder').value = cfg.folder; $('rsLut').value = cfg.lut; $('rsMix').value = cfg.mix; $('rsMixRead').textContent = Math.round(cfg.mix * 100) + '%';
    $('rsFps').value = cfg.fps; $('rsFont').value = cfg.font; $('rsSize').value = cfg.size; $('rsCodec').value = cfg.codec; $('rsOut').value = cfg.out || '';
  }
  const clean = v => v.trim().replace(/^['"]|['"]$/g, '');
  function readFields(){
    cfg.project = $('rsProject').value.trim() || defaultProject(); cfg.projectFor = defaultProject();
    cfg.folder = clean($('rsFolder').value); cfg.lut = clean($('rsLut').value); cfg.out = clean($('rsOut').value);
    cfg.mix = parseFloat($('rsMix').value); cfg.fps = $('rsFps').value; cfg.font = $('rsFont').value.trim() || 'Oswald';
    cfg.size = $('rsSize').value; cfg.codec = $('rsCodec').value;
  }
  function saveCfg(){
    RBS.set(KEY, {folder: cfg.folder, out: cfg.out, lut: cfg.lut, mix: cfg.mix, fps: cfg.fps, font: cfg.font, size: cfg.size, codec: cfg.codec,
      formats: cfg.formats, render: cfg.render, opts: cfg.opts});
  }
  $('rsMix').addEventListener('input', e => { $('rsMixRead').textContent = Math.round(e.target.value * 100) + '%'; });
  ['rsSize', 'rsCodec', 'rsFps'].forEach(id => $(id).addEventListener('change', renderSpec));
  ['rsFolder', 'rsLut', 'rsMix', 'rsFps', 'rsFont', 'rsSize', 'rsCodec', 'rsOut'].forEach(id => $(id).addEventListener('change', () => { readFields(); saveCfg(); }));

  // ---------- send ----------
  function sendResolve(){
    readFields();
    if(!allMarks().length){ RBS.toast('Add some marks first', 'orange'); return; }
    if(!cfg.folder.startsWith('/')){ RBS.toast('Paste the full source folder path from Finder (it starts with /)', 'orange'); $('rsFolder').focus(); return; }
    if(!chosenFormats().length){ RBS.toast('Pick at least one format', 'orange'); return; }
    saveCfg();
    const {job, count} = buildJob();
    const d = new Date(), pad = x => String(x).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const name = `reelbin_${stamp}.rbjob.lua`;
    RBS.saveFile(name, '-- Reel Bin job for DaVinci Resolve. Run: Workspace > Scripts > Reel Bin Import\nreturn ' + toLua(job) + '\n', 'text/plain');
    const link = $('rsOpen');
    link.href = 'reelbin://open?target=resolve&job=' + encodeURIComponent(name);
    link.hidden = false;
    setTimeout(() => link.click(), 400);    // hands the job to Reel Bin Bridge (browser asks the first time)
    RBS.toast(bridgeReady() ? `Job with ${count} marks sent. Resolve is opening…` : `Job downloaded. Finish the Bridge setup so Resolve opens by itself.`, bridgeReady() ? 'lime' : 'orange');
    RBS.emit('step-done', {step: 'handoff', next: null});
  }
  $('rsGo').addEventListener('click', () => {
    if(target === 'resolve') sendResolve();
    else if(target === 'marks'){
      if(!allMarks().length){ RBS.toast('Add some marks first', 'orange'); return; }
      document.getElementById('exportJsonBtn').click();
      setTimeout(() => document.getElementById('exportCsvBtn').click(), 300);
    }
  });
  function openHandoff(fromVertical){
    target = 'resolve';
    if(fromVertical){ const vk = RBS.vertical.format().key; if(FMT_LABEL[vk]) cfg.formats[vk] = true; }
    RBS.go('handoff');
  }
  $('sendToResolveBtn').addEventListener('click', () => openHandoff(false));
  $('vSendToResolveBtn').addEventListener('click', () => openHandoff(true));
  RBS.on('view', id => { if(id === 'handoff'){ loadFields(); renderAll(); } });
  RBS.on('marks-changed', () => { if(RBS.currentView() === 'handoff') refreshSummary(); });
  RBS.on('status', () => {});
  loadFields(); renderAll();
  RBS.handoff = {buildJob, toLua, targets: TARGETS};
})();
