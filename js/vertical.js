/* Vertical Maker — wide clips to 9:16 (or 1:1 / 16:9) for Reels / TikTok / Shorts.
   Workflow modeled on the Cropper app (frame by dragging, pinch/scroll zoom,
   keyframes with motion styles, trim, join, speed, logo, 9:16 export),
   with an original design. No timeline: you frame the shot directly.
   Two outputs: an in-browser render (real time, MediaRecorder) and a
   keyframes JSON + ffmpeg script for full quality on the Mac. */
(function(){
  const $ = id => document.getElementById(id);
  const esc = RBS.esc, fmt = RBS.fmt;
  const FORMATS = {'9:16': {w: 1080, h: 1920, prev: [360, 640]}, '1:1': {w: 1080, h: 1080, prev: [480, 480]}, '4:3': {w: 1440, h: 1080, prev: [560, 420]}, '16:9': {w: 1920, h: 1080, prev: [640, 360]}};
  let fmtKey = '9:16';
  const OUT = () => FORMATS[fmtKey];
  const outAR = () => OUT().w / OUT().h;
  // How the crop arrives at a keyframe (set per keyframe, like Cropper's pins).
  const MOTION = {
    smooth: {label: 'Smooth', hint: 'Smooth: glides from the last keyframe into this one. Natural motion; good default for game footage.'},
    sport: {label: 'Sport', hint: 'Sport: holds, then snaps with a fast pan into this keyframe. For fast breaks and steals.'},
    movie: {label: 'Movie', hint: 'Movie: holds the last framing, then cuts straight to this one, like an edit.'}
  };
  const SNAP = 0.35;            // seconds a Sport snap-pan takes
  const cubic = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  const PRESETS = {'Full': {z: 1, cx: .5}, 'Zoom L': {z: 1.333, cx: .3}, 'Zoom C': {z: 1.333, cx: .5}, 'Zoom R': {z: 1.333, cx: .7}, 'Tight': {z: 2, cx: .5}};
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2];
  const LOGO_POS = ['Top L', 'Top', 'Top R', 'Bottom L', 'Bottom', 'Bottom R'];

  let segs = [], activeId = null, selKf = null;
  let motionDefault = 'smooth';
  let quality = 'max', outFps = 30;
  const logo = {img: null, name: '', pos: 'Top R', size: 0.22, opacity: 0.9};
  let live = null;            // crop override while the user is dragging / pinching
  let rendering = false;

  const v = $('vVideo'), stageEl = $('vStage'), box = $('cropBox'), prev = $('vPreview'), pctx = prev.getContext('2d');
  const seg = () => segs.find(s => s.id === activeId);
  const segUid = () => 's' + Math.random().toString(36).slice(2, 9);
  // Progress (0..1) of the move from keyframe a into keyframe b at time t.
  function arrive(tr, t, a, b){
    const span = Math.max(1e-6, b.t - a.t);
    if(tr === 'movie') return t >= b.t ? 1 : 0;
    if(tr === 'sport'){ const d = Math.min(SNAP, span), p = (t - (b.t - d)) / d; return p <= 0 ? 0 : p >= 1 ? 1 : cubic(p); }
    const p = Math.min(1, Math.max(0, (t - a.t) / span));
    if(tr === 'path') return p;                       // painted path: straight between samples
    return (1 - Math.cos(Math.PI * p)) / 2;           // smooth
  }

  /* ------------------------------ geometry ------------------------------ */
  // Crop box in source pixels for a {cx, cy, z} state. z=1 is the tallest 9:16 box that fits.
  function cropRect(s, st, ar){
    const AR = ar || outAR();
    const vw = s.vw || 1920, vh = s.vh || 1080;
    const h0 = Math.min(vh, vw / AR);
    const h = h0 / Math.max(1, st.z), w = h * AR;
    const cx = Math.min(vw - w / 2, Math.max(w / 2, st.cx * vw));
    const cy = Math.min(vh - h / 2, Math.max(h / 2, st.cy * vh));
    return {x: cx - w / 2, y: cy - h / 2, w, h};
  }
  function clampState(s, st){
    const r = cropRect(s, st);
    return {cx: (r.x + r.w / 2) / (s.vw || 1920), cy: (r.y + r.h / 2) / (s.vh || 1080), z: Math.min(4, Math.max(1, st.z))};
  }
  function evalCrop(s, t){
    const k = s.kfs;
    if(!k.length) return s.base;
    if(t <= k[0].t) return k[0];
    const last = k[k.length - 1];
    if(t >= last.t) return last;
    for(let i = 0; i < k.length - 1; i++){
      const a = k[i], b = k[i + 1];
      if(t >= a.t && t <= b.t){
        const p = arrive(b.tr || s.motion || 'smooth', t, a, b);
        return {cx: a.cx + (b.cx - a.cx) * p, cy: a.cy + (b.cy - a.cy) * p, z: a.z + (b.z - a.z) * p};
      }
    }
    return last;
  }
  const curState = () => { const s = seg(); return s ? (live || evalCrop(s, v.currentTime || s.tIn)) : null; };
  function videoRect(){
    const r = stageEl.getBoundingClientRect(), s = seg();
    const va = s && s.vw ? s.vw / s.vh : 16 / 9, sa = r.width / r.height;
    let dw, dh;
    if(va > sa){ dw = r.width; dh = r.width / va; } else { dh = r.height; dw = r.height * va; }
    return {dx: (r.width - dw) / 2, dy: (r.height - dh) / 2, dw, dh, r};
  }

  /* ------------------------------ segments ------------------------------ */
  function addSegment(o){
    const s = Object.assign({id: segUid(), name: 'clip', fileName: '', file: null, url: null, vw: 0, vh: 0, duration: 0,
      tIn: 0, tOut: 0, speed: 1, motion: motionDefault, base: {cx: .5, cy: .5, z: 1}, kfs: [], label: ''}, o);
    segs.push(s);
    if(!s.vw || !s.duration){
      const p = document.createElement('video');
      p.preload = 'metadata'; p.muted = true; p.src = s.url;
      p.addEventListener('loadedmetadata', () => {
        s.vw = p.videoWidth; s.vh = p.videoHeight; s.duration = p.duration;
        if(!s.tOut || s.tOut > s.duration) s.tOut = s.duration;
        s.base = clampState(s, s.base); s.kfs = s.kfs.map(k => Object.assign(k, clampState(s, k)));
        renderSegs(); if(s.id === activeId) syncAll();
      }, {once: true});
    }
    return s;
  }
  function addFiles(files){
    let n = 0;
    Array.from(files).forEach(f => {
      if(!(f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name))) return;
      addSegment({name: f.name.replace(/\.[^.]+$/, ''), fileName: f.name, file: f, url: URL.createObjectURL(f)});
      n++;
    });
    if(n){ if(!activeId) select(segs[0].id); renderSegs(); RBS.toast(n + ' clip' + (n === 1 ? '' : 's') + ' added', 'lime'); }
  }
  $('vFileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  RBS.on('vertical-files', addFiles);

  function fromMarks(){
    if(!RBS.marker){ return; }
    const who = $('vMarkPlayer').value;
    let made = 0, missing = 0;
    const mClips = RBS.marker.clips();
    mClips.forEach(c => c.marks.forEach(m => {
      if(who && !(m.players || []).some(p => p.name === who)) return;
      let url = c.url, file = c.file;
      if(!url){ const own = segs.find(s => s.name === c.name && s.url); if(own){ url = own.url; file = own.file; } }
      if(!url){ missing++; return; }
      const pr = PRESETS[m.zoom] || PRESETS.Full;
      const label = [(m.plays || [])[0], (m.players || []).map(p => p.name.split(' ')[0]).join('+')].filter(Boolean).join(' · ');
      const s = addSegment({name: c.name, fileName: file ? file.name : c.name, file, url, vw: c.vw || 0, vh: c.vh || 0, duration: c.duration || 0,
        tIn: m.start, tOut: m.end, base: {cx: pr.cx, cy: .5, z: pr.z}, label: label || (m.category || ''), fromMark: m.id});
      if(s.vw){ s.base = clampState(s, s.base); }
      made++;
    }));
    renderSegs();
    if(made && !seg()) select(segs[segs.length - made].id);
    if(made) RBS.toast(made + ' marks loaded, framed by their Zoom tag' + (missing ? ' · ' + missing + ' skipped (file not loaded)' : ''), missing ? 'orange' : 'lime');
    else RBS.toast(missing ? 'Those marks have no loaded file. Add the clips in Reel Marker or here first.' : 'No marks match', 'orange');
  }
  $('vFromMarksBtn').addEventListener('click', fromMarks);
  RBS.on('marks-to-vertical', () => { if(!segs.some(s => s.fromMark)) fromMarks(); });
  function refreshPlayerFilter(){
    const sel = $('vMarkPlayer'), cur = sel.value, names = new Set();
    if(RBS.marker) RBS.marker.clips().forEach(c => c.marks.forEach(m => (m.players || []).forEach(p => p.name && names.add(p.name))));
    sel.innerHTML = '<option value="">All players\' marks</option>' + Array.from(names).sort().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    sel.value = cur;
  }
  RBS.on('marks-changed', refreshPlayerFilter);
  RBS.on('view', id => { if(id === 'vertical'){ refreshPlayerFilter(); requestAnimationFrame(syncAll); } });

  function renderSegs(){
    const list = $('vSegList');
    list.innerHTML = '';
    $('vSegCount').textContent = segs.length;
    RBS.emit('status', {step: 'vertical', text: segs.length ? segs.length + ' CLIP' + (segs.length === 1 ? '' : 'S') : 'FRAME 9:16'});
    if(!segs.length){ list.innerHTML = '<p class="hint" style="padding:8px 4px">No clips yet</p>'; return; }
    segs.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'seg' + (s.id === activeId ? ' on' : '');
      const len = Math.max(0, (s.tOut - s.tIn) / s.speed);
      row.innerHTML = `<span class="ix">${i + 1}</span><span class="nm"><b>${esc(s.name)}${s.label ? ' · ' + esc(s.label) : ''}</b>
        <small>${fmt(s.tIn)}–${fmt(s.tOut)} · ${len.toFixed(1)}s${s.speed !== 1 ? ' · ' + s.speed + '×' : ''} · ${s.kfs.length}◆</small></span>
        <span class="mv"><button data-a="up" title="Move up" aria-label="Move up">▲</button><button data-a="dn" title="Move down" aria-label="Move down">▼</button></span>
        <button class="x" data-a="del" title="Remove" aria-label="Remove clip">×</button>`;
      row.addEventListener('click', e => {
        const a = e.target.dataset && e.target.dataset.a;
        if(a === 'up' && i > 0){ [segs[i - 1], segs[i]] = [segs[i], segs[i - 1]]; renderSegs(); return; }
        if(a === 'dn' && i < segs.length - 1){ [segs[i + 1], segs[i]] = [segs[i], segs[i + 1]]; renderSegs(); return; }
        if(a === 'del'){ segs.splice(i, 1); if(activeId === s.id){ activeId = null; if(segs.length) select(segs[Math.min(i, segs.length - 1)].id); else clearStage(); } renderSegs(); return; }
        if(a) return;
        select(s.id);
      });
      list.appendChild(row);
    });
    updateCmd();
  }
  function clearStage(){ v.removeAttribute('src'); v.load(); box.hidden = true; $('vTitle').innerHTML = '<b>No clip</b><small>Add a wide clip to frame it for 9:16</small>'; pctx.clearRect(0, 0, prev.width, prev.height); updateCmd(); }
  function select(id){
    activeId = id; selKf = null;
    const s = seg(); if(!s) return;
    const go = () => { v.currentTime = s.tIn; v.playbackRate = s.speed; syncAll(); };
    if(v.src !== s.url){ v.src = s.url; v.addEventListener('loadedmetadata', go, {once: true}); } else go();
    $('vTitle').innerHTML = `<b>${esc(s.name)}</b>${s.label ? `<small>${esc(s.label)}</small>` : ''}<small class="mono">${s.vw ? s.vw + '×' + s.vh : ''}</small>`;
    renderSegs(); syncAll();
  }

  /* ------------------------------ keyframes ------------------------------ */
  function setKf(st, t){
    const s = seg(); if(!s) return;
    st = clampState(s, st);
    const tol = 1 / 30;
    let k = s.kfs.find(x => Math.abs(x.t - t) < tol);
    if(k) Object.assign(k, st); else { k = Object.assign({t, tr: motionDefault}, st); s.kfs.push(k); s.kfs.sort((a, b) => a.t - b.t); }
    if(selKf && !s.kfs.includes(selKf)) selKf = null;
    renderSegs(); syncAll();
  }
  function commitLive(){ if(!live) return; const st = live; live = null; setKf(st, v.currentTime); }
  $('vAddKf').addEventListener('click', () => { const st = curState(); if(st) setKf(st, v.currentTime); });
  $('vDelKf').addEventListener('click', delKf);
  function delKf(){ const s = seg(); if(!s || !selKf) { RBS.toast('Click a ◆ on the track to select it first', 'orange'); return; } s.kfs = s.kfs.filter(k => k !== selKf); selKf = null; renderSegs(); syncAll(); }
  $('vResetKf').addEventListener('click', () => { const s = seg(); if(!s) return; if(s.kfs.length && !confirm('Clear all ' + s.kfs.length + ' keyframes for this clip?')) return; s.kfs = []; selKf = null; renderSegs(); syncAll(); });
  function jumpKf(dir){
    const s = seg(); if(!s || !s.kfs.length) return;
    const t = v.currentTime;
    const k = dir > 0 ? s.kfs.find(x => x.t > t + 0.01) : s.kfs.slice().reverse().find(x => x.t < t - 0.01);
    if(k){ v.pause(); v.currentTime = k.t; selKf = k; syncAll(); }
  }
  $('vPrevKf').addEventListener('click', () => jumpKf(-1));
  $('vNextKf').addEventListener('click', () => jumpKf(1));

  /* ------------------------------ framing gestures ------------------------------ */
  const pointers = new Map();
  let drag = null, lastPathT = -1;
  stageEl.addEventListener('pointerdown', e => {
    const s = seg(); if(!s || !s.vw) return;
    stageEl.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    const st = curState();
    const isZoom = e.target === $('cropZoomHandle');
    if(pointers.size === 2){
      const [a, b] = Array.from(pointers.values());
      drag = {mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), st0: st};
    } else drag = {mode: isZoom ? 'zoom' : 'pan', x0: e.clientX, y0: e.clientY, st0: st};
    box.classList.add('drag'); box.classList.remove('anim');
    lastPathT = v.currentTime;
  });
  // Two-pass framing like Cropper: while the clip plays, a pan drag records only x/y and
  // keeps the zoom already on the path; a zoom gesture records only zoom and keeps the pan.
  let wheelEdit = null;          // {z} while a scroll / slider zoom is in progress
  function applyDrag(){
    const s = seg(); if(!s) return;
    if(drag && drag.cur){
      const base = v.paused ? drag.st0 : evalCrop(s, v.currentTime);
      live = clampState(s, Object.assign({}, base, drag.cur));
    } else if(wheelEdit && !v.paused){
      live = clampState(s, Object.assign({}, evalCrop(s, v.currentTime), wheelEdit));
    }
  }
  function recordIfPlaying(){
    if(!v.paused && live && Math.abs(v.currentTime - lastPathT) >= 0.3){ setKfQuiet(live, v.currentTime); lastPathT = v.currentTime; renderTrack(); }
  }
  stageEl.addEventListener('pointermove', e => {
    if(!drag || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    const s = seg(), vr = videoRect(), scale = (s.vw || 1920) / vr.dw;
    if(drag.mode === 'pinch' && pointers.size >= 2){
      const [a, b] = Array.from(pointers.values());
      drag.cur = {z: drag.st0.z * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, drag.d0)};
    } else if(drag.mode === 'zoom'){
      drag.cur = {z: drag.st0.z * Math.pow(0.992, e.clientY - drag.y0)};
    } else if(drag.mode === 'pan'){
      const dx = (e.clientX - drag.x0) * scale, dy = (e.clientY - drag.y0) * scale;
      drag.cur = {cx: drag.st0.cx + dx / s.vw, cy: drag.st0.cy + dy / s.vh};
    }
    applyDrag(); recordIfPlaying(); paint();
  });
  function setKfQuiet(st, t){
    const s = seg(); const k = s.kfs.find(x => Math.abs(x.t - t) < 1 / 30);
    if(k) Object.assign(k, st); else { s.kfs.push(Object.assign({t, tr: 'path'}, st)); s.kfs.sort((a, b) => a.t - b.t); }
  }
  function endLive(){
    if(!live) return;
    if(!v.paused){ applyDrag(); setKfQuiet(live, v.currentTime); live = null; wheelEdit = null; renderSegs(); syncAll(); }
    else commitLive();
  }
  function endPointer(e){
    pointers.delete(e.pointerId);
    if(pointers.size) return;
    box.classList.remove('drag');
    if(drag){ drag = null; endLive(); }
  }
  stageEl.addEventListener('pointerup', endPointer);
  stageEl.addEventListener('pointercancel', endPointer);
  let wheelT = null, wheelZ = null;
  function zoomTo(z){
    const s = seg(); if(!s || !s.vw) return;
    const base = v.paused ? (live || evalCrop(s, v.currentTime)) : evalCrop(s, v.currentTime);
    wheelEdit = {z};
    live = clampState(s, Object.assign({}, base, {z}));
    recordIfPlaying(); paint();
  }
  stageEl.addEventListener('wheel', e => {
    const s = seg(); if(!s || !s.vw) return;
    e.preventDefault();
    if(wheelZ == null) wheelZ = curState().z;
    wheelZ = Math.min(4, Math.max(1, wheelZ * Math.pow(0.998, e.deltaY)));
    zoomTo(wheelZ);
    clearTimeout(wheelT); wheelT = setTimeout(() => { wheelZ = null; endLive(); wheelEdit = null; }, 260);
  }, {passive: false});
  $('vZoom').addEventListener('input', e => zoomTo(+e.target.value));
  $('vZoom').addEventListener('change', () => { endLive(); wheelEdit = null; });

  /* ------------------------------ panels ------------------------------ */
  function chips(el, list, isOn, onPick, cls){
    el.innerHTML = '';
    list.forEach(item => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'cp ' + (cls || '') + (isOn(item) ? ' on' : '');
      b.textContent = typeof item === 'number' ? item + '×' : (MOTION[item] ? MOTION[item].label : item);
      b.addEventListener('click', () => { onPick(item); chips(el, list, isOn, onPick, cls); });
      el.appendChild(b);
    });
  }
  function setFormat(f){
    fmtKey = f;
    const [pw, ph] = OUT().prev;
    prev.width = pw; prev.height = ph; prev.style.aspectRatio = pw + '/' + ph;
    $('vPrevLbl').textContent = f + ' PREVIEW';
    $('cropLbl').textContent = f;
    syncAll();
  }
  function renderPanels(){
    const s = seg();
    chips($('vPresetChips'), Object.keys(PRESETS), () => false, name => {
      const s2 = seg(); if(!s2) return;
      const p = PRESETS[name]; const st = curState() || s2.base;
      box.classList.add('anim'); setTimeout(() => box.classList.remove('anim'), 500);
      setKf({cx: p.cx, cy: st.cy, z: p.z}, v.currentTime);
    }, 'zoom');
    const curTr = selKf ? (MOTION[selKf.tr] ? selKf.tr : null) : motionDefault;
    chips($('vMotionChips'), Object.keys(MOTION), m => curTr === m, m => {
      if(selKf){ selKf.tr = m; } else motionDefault = m;
      renderPanels(); renderTrack(); updateCmd();
    });
    $('vMotionHint').textContent = (selKf ? (selKf.tr === 'path' ? 'This ◆ is part of a painted path (straight moves between samples). Pick a transition to change it. ' : 'Applies to the selected ◆. ') : 'Default for new ◆ keyframes. Select a ◆ to change just that one. ') + MOTION[curTr || 'smooth'].hint;
    chips($('vFormatChips'), Object.keys(FORMATS), f => fmtKey === f, f => setFormat(f));
    chips($('vSpeedChips'), SPEEDS, sp => s && s.speed === sp, sp => { const s2 = seg(); if(!s2) return; s2.speed = sp; v.playbackRate = sp; renderSegs(); });
    chips($('vLogoPos'), LOGO_POS, p => logo.pos === p, p => { logo.pos = p; updateCmd(); });
    chips($('vQualChips'), [`Max (${OUT().w}×${OUT().h})`, 'Source size'], q => (q.startsWith('Max') ? 'max' : 'source') === quality, q => { quality = q.startsWith('Max') ? 'max' : 'source'; });
    chips($('vFpsChips'), ['30 fps', '60 fps'], f => parseInt(f) === outFps, f => { outFps = parseInt(f); updateCmd(); });
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
    document.querySelectorAll('.tpane').forEach(p => p.classList.toggle('on', p.dataset.pane === t.dataset.tab));
  }));
  $('vSetIn').addEventListener('click', () => { const s = seg(); if(!s) return; s.tIn = Math.min(v.currentTime, s.tOut - 0.1); renderSegs(); syncAll(); });
  $('vSetOut').addEventListener('click', () => { const s = seg(); if(!s) return; s.tOut = Math.max(v.currentTime, s.tIn + 0.1); renderSegs(); syncAll(); });
  $('vLogoInput').addEventListener('change', e => {
    const f = e.target.files[0]; e.target.value = ''; if(!f) return;
    const img = new Image(); img.onload = () => { logo.img = img; logo.name = f.name; updateCmd(); RBS.toast('Logo added', 'lime'); }; img.src = URL.createObjectURL(f);
  });
  $('vLogoClear').addEventListener('click', () => { logo.img = null; logo.name = ''; updateCmd(); });
  $('vLogoSize').addEventListener('input', e => { logo.size = +e.target.value; updateCmd(); });
  $('vLogoOpacity').addEventListener('input', e => { logo.opacity = +e.target.value; updateCmd(); });

  /* ------------------------------ track (trim + keyframes) ------------------------------ */
  const track = $('kTrack');
  let trackDrag = null;
  track.addEventListener('pointerdown', e => {
    const s = seg(); if(!s || !s.duration) return;
    track.setPointerCapture(e.pointerId);
    if(e.target.classList.contains('kf')){ const k = s.kfs[+e.target.dataset.i]; v.pause(); v.currentTime = k.t; selKf = k; trackDrag = 'kf'; syncAll(); return; }
    trackDrag = e.target.id === 'kTrimIn' ? 'in' : e.target.id === 'kTrimOut' ? 'out' : 'seek';
    trackMove(e);
  });
  track.addEventListener('pointermove', e => { if(trackDrag) trackMove(e); });
  track.addEventListener('pointerup', () => { if(trackDrag && trackDrag !== 'seek') renderSegs(); trackDrag = null; });
  function trackMove(e){
    const s = seg(), r = track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * s.duration;
    if(trackDrag === 'kf' && selKf){
      const i = s.kfs.indexOf(selKf), lo = i > 0 ? s.kfs[i - 1].t + 0.04 : 0, hi = i < s.kfs.length - 1 ? s.kfs[i + 1].t - 0.04 : s.duration;
      selKf.t = Math.min(hi, Math.max(lo, t)); v.currentTime = selKf.t;
    }
    else if(trackDrag === 'in'){ s.tIn = Math.min(t, s.tOut - 0.1); v.currentTime = s.tIn; }
    else if(trackDrag === 'out'){ s.tOut = Math.max(t, s.tIn + 0.1); v.currentTime = s.tOut; }
    else { selKf = null; v.currentTime = t; }
    syncAll();
  }
  function renderTrack(){
    const s = seg();
    const dots = $('kDots'); dots.innerHTML = '';
    if(!s || !s.duration){ $('kTrim').style.cssText = 'left:0;width:0'; return; }
    const pc = t => (t / s.duration * 100) + '%';
    $('kTrim').style.left = pc(s.tIn); $('kTrim').style.width = ((s.tOut - s.tIn) / s.duration * 100) + '%';
    $('kTrimIn').style.left = pc(s.tIn); $('kTrimOut').style.left = pc(s.tOut);
    s.kfs.forEach((k, i) => { const d = document.createElement('div'); d.className = 'kf ' + (k.tr || 'smooth') + (k === selKf ? ' sel' : ''); d.dataset.i = i; d.style.left = pc(k.t); d.title = '◆ ' + fmt(k.t) + ' · ' + k.z.toFixed(2) + '× · ' + (k.tr === 'path' ? 'painted path' : (MOTION[k.tr] || MOTION.smooth).label) + ' (drag to retime)'; dots.appendChild(d); });
    $('vTrimIn').textContent = fmt(s.tIn); $('vTrimOut').textContent = fmt(s.tOut);
    $('vTrimRead').textContent = 'trim ' + fmt(s.tIn) + ' – ' + fmt(s.tOut) + ' (' + ((s.tOut - s.tIn) / s.speed).toFixed(1) + 's)';
    $('vDur').textContent = fmt(s.duration);
  }

  /* ------------------------------ playback ------------------------------ */
  function togglePlay(){
    const s = seg(); if(!s || !v.src) return;
    if(v.paused){
      v.muted = false;
      if(v.currentTime < s.tIn - 0.05 || v.currentTime >= s.tOut - 0.05) v.currentTime = s.tIn;
      v.playbackRate = s.speed; v.play().catch(() => {});
    } else v.pause();
  }
  $('vPlayBtn').addEventListener('click', togglePlay);
  v.addEventListener('play', () => $('vPlayBtn').textContent = '❚❚');
  v.addEventListener('pause', () => $('vPlayBtn').textContent = '▶');
  const step = d => { v.pause(); v.currentTime = Math.max(0, v.currentTime + d / 30); };
  $('vBackBtn').addEventListener('click', () => step(-1));
  $('vFwdBtn').addEventListener('click', () => step(1));

  /* ------------------------------ drawing ------------------------------ */
  function drawFrame(ctx, W, H, video, s, st){
    const r = cropRect(s, st);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    try{ ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, W, H); }catch(e){}
    if(logo.img){
      const lw = W * logo.size, lh = lw * logo.img.height / logo.img.width, m = W * 0.045;
      const x = logo.pos.endsWith('L') ? m : logo.pos.endsWith('R') ? W - lw - m : (W - lw) / 2;
      const y = logo.pos.startsWith('Top') ? m * 1.6 : H - lh - m * 2.6;
      ctx.globalAlpha = logo.opacity; ctx.drawImage(logo.img, x, y, lw, lh); ctx.globalAlpha = 1;
    }
  }
  function paint(){
    const s = seg();
    if(!s || !s.vw){ box.hidden = true; return; }
    const st = curState(), r = cropRect(s, st), vr = videoRect(), k = vr.dw / s.vw;
    box.hidden = false;
    box.style.left = (vr.dx + r.x * k) + 'px'; box.style.top = (vr.dy + r.y * k) + 'px';
    box.style.width = (r.w * k) + 'px'; box.style.height = (r.h * k) + 'px';
    $('cropLbl').textContent = st.z.toFixed(2) + '×';
    $('vZoom').value = st.z; $('vZoomRead').textContent = st.z.toFixed(2) + '×';
    drawFrame(pctx, prev.width, prev.height, v, s, st);
    // Sharpness readout: how far the output size has to upscale the crop.
    const up = OUT().h / r.h;
    const el = $('vSharp');
    el.className = 'sharp ' + (up <= 1.9 ? 'ok' : up <= 2.4 ? 'warn' : 'bad');
    $('vUpscale').textContent = up.toFixed(2) + '×';
    $('vSharpTxt').textContent = up <= 1.9 ? 'upscale: clean at ' + OUT().w + '×' + OUT().h : up <= 2.4 ? 'upscale: getting soft' : 'upscale: soft, zoom out if you can';
    const t = v.currentTime || 0;
    $('vTc').textContent = fmt(t);
    if(s.duration) $('kHead').style.left = (t / s.duration * 100) + '%';
  }
  function syncAll(){ renderTrack(); renderPanels(); paint(); updateCmd(); }
  function loop(){
    const s = seg();
    if(s && !rendering && RBS.currentView() === 'vertical'){
      if(!v.paused && v.currentTime >= s.tOut - 0.02){ v.currentTime = s.tIn; lastPathT = s.tIn; }   // loop inside the trim, like Cropper
      if((drag || wheelEdit) && !v.paused){ applyDrag(); recordIfPlaying(); }
      paint();
    }
    requestAnimationFrame(loop);
  }
  window.addEventListener('resize', () => paint());

  /* ------------------------------ in-browser render ------------------------------ */
  let rv = null, actx = null, adest = null;
  function pickMime(){
    const c = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4D401F,mp4a.40.2', 'video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }
  const once = (el, ev) => new Promise(res => el.addEventListener(ev, res, {once: true}));
  async function renderAll(){
    if(rendering) return;
    const list = segs.filter(s => s.url && s.vw && s.tOut > s.tIn);
    if(!list.length){ RBS.toast('Add at least one clip first', 'orange'); return; }
    if(!window.MediaRecorder){ RBS.toast('This browser cannot record video. Use the ffmpeg script instead.', 'red'); return; }
    const mime = pickMime();
    let W = OUT().w, H = OUT().h;
    if(quality === 'source'){
      const r0 = cropRect(list[0], evalCrop(list[0], list[0].tIn));
      W = Math.min(OUT().w, Math.round(r0.w / 2) * 2); H = Math.round(W / outAR() / 2) * 2;
    }
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if(!rv){
      rv = document.createElement('video'); rv.playsInline = true; rv.preload = 'auto';
      try{
        actx = new (window.AudioContext || window.webkitAudioContext)();
        const src = actx.createMediaElementSource(rv); adest = actx.createMediaStreamDestination(); src.connect(adest);
      }catch(e){ actx = null; }
    }
    if(actx && actx.state === 'suspended') await actx.resume();
    const stream = canvas.captureStream(outFps);
    if(adest) adest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    const bitrate = Math.max(W, H) >= 1920 ? 12e6 : 8e6;
    const rec = new MediaRecorder(stream, mime ? {mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000} : {videoBitsPerSecond: bitrate});
    const chunks = [];
    rec.ondataavailable = e => { if(e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => rec.onstop = res);
    rendering = true; v.pause();
    $('vRenderBtn').disabled = true; $('vRenderBtn').textContent = 'Rendering…';
    const total = list.reduce((a, s) => a + (s.tOut - s.tIn) / s.speed, 0);
    let doneT = 0;
    try{
      for(let i = 0; i < list.length; i++){
        const s = list[i];
        $('vRenderStatus').textContent = `Clip ${i + 1} of ${list.length}: ${s.name}`;
        if(rv.src !== s.url){ rv.src = s.url; await once(rv, 'loadedmetadata'); }
        rv.currentTime = s.tIn; await once(rv, 'seeked');
        rv.playbackRate = s.speed;
        drawFrame(ctx, W, H, rv, s, evalCrop(s, s.tIn));
        if(rec.state === 'inactive') rec.start(500); else rec.resume();
        await rv.play();
        await new Promise(res => {
          const tick = () => {
            const t = rv.currentTime;
            drawFrame(ctx, W, H, rv, s, evalCrop(s, t));
            $('vRenderMeter').style.width = Math.min(100, (doneT + (t - s.tIn) / s.speed) / total * 100) + '%';
            if(t >= s.tOut - 0.01 || rv.ended){ res(); return; }
            rv.requestVideoFrameCallback ? rv.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
          };
          tick();
        });
        rv.pause(); rec.pause();
        doneT += (s.tOut - s.tIn) / s.speed;
      }
      rec.stop(); await stopped;
      const type = (mime || 'video/webm').split(';')[0];
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, {type});
      const name = 'vertical_' + (list.length === 1 ? list[0].name : 'reel_' + list.length + 'clips') + '.' + ext;
      RBS.saveFile(name, blob);
      $('vRenderMeter').style.width = '100%';
      $('vRenderStatus').textContent = `Done: ${name} (${(blob.size / 1048576).toFixed(1)} MB, ${W}×${H}).` + (ext === 'webm' ? ' This browser saves WebM; Instagram and TikTok accept it, or use the ffmpeg script for MP4.' : '');
      RBS.toast('Vertical video saved: ' + name, 'lime');
      RBS.emit('step-done', {step: 'vertical', next: null});
    }catch(err){
      console.error(err);
      try{ if(rec.state !== 'inactive') rec.stop(); }catch(e){}
      $('vRenderStatus').textContent = 'Render stopped: ' + (err.message || err) + '. Try the ffmpeg script instead.';
      RBS.toast('Render failed. The ffmpeg script still works.', 'red');
    }finally{
      rendering = false; $('vRenderBtn').disabled = false; $('vRenderBtn').textContent = 'Render vertical video';
    }
  }
  $('vRenderBtn').addEventListener('click', renderAll);

  /* ------------------------------ keyframes JSON + ffmpeg script ------------------------------ */
  const n3 = x => Math.round(x * 1000) / 1000;
  const cubicExpr = P => `if(lt(${P},0.5),4*pow(${P},3),1-pow(-2*${P}+2,3)/2)`;
  // Piecewise expression in clip-relative time (ffmpeg's t / it start at 0 after -ss),
  // following each keyframe's own transition exactly like the browser preview.
  function axisExpr(k, T){
    if(k.length === 1) return String(n3(k[0].v));
    let expr = String(n3(k[k.length - 1].v));
    for(let i = k.length - 2; i >= 0; i--){
      const a = k[i], b = k[i + 1], span = b.t - a.t, dv = b.v - a.v;
      if(span < 0.002) continue;
      if(Math.abs(dv) < 0.0005 || b.tr === 'movie'){ expr = `if(lt(${T},${n3(b.t)}),${n3(a.v)},${expr})`; continue; }
      if(b.tr === 'sport'){
        const d = Math.min(SNAP, span), s0 = b.t - d, P = `((${T}-${n3(s0)})/${n3(d)})`;
        expr = `if(lt(${T},${n3(s0)}),${n3(a.v)},if(lt(${T},${n3(b.t)}),${n3(a.v)}+(${n3(dv)})*${cubicExpr(P)},${expr}))`;
        continue;
      }
      const P = `((${T}-${n3(a.t)})/${n3(span)})`;
      const shape = b.tr === 'path' ? P : `(1-cos(PI*${P}))/2`;
      expr = `if(lt(${T},${n3(b.t)}),${n3(a.v)}+(${n3(dv)})*${shape},${expr})`;
    }
    return `if(lt(${T},${n3(k[0].t)}),${n3(k[0].v)},${expr})`;
  }
  // Same math as the browser preview: interpolate (cx, cy, zoom), then keep the box inside the frame.
  // Constant zoom: one animated crop. Changing zoom: crop a strip at the widest zoom, then zoompan inside it.
  function segPlan(s){
    const vw = s.vw || 1920, vh = s.vh || 1080;
    const inner = s.kfs.filter(k => k.t > s.tIn + 0.001 && k.t < s.tOut - 0.001);
    const nextK = s.kfs.find(k => k.t >= s.tOut - 0.001);
    const pts = [Object.assign({t: s.tIn}, evalCrop(s, s.tIn)), ...inner, Object.assign({t: s.tOut}, evalCrop(s, s.tOut), {tr: nextK ? nextK.tr : 'smooth'})]
      .map(p => ({t: p.t - s.tIn, cx: p.cx * vw, cy: p.cy * vh, z: p.z, tr: p.tr || s.motion || 'smooth'}));
    const zs = pts.map(p => p.z), zmin = Math.min(...zs);
    const zoomVaries = Math.max(...zs) - zmin > 0.01;
    const r = cropRect(s, {cx: .5, cy: .5, z: zmin});
    const W1 = Math.round(r.w / 2) * 2, H1 = Math.round(r.h / 2) * 2;
    const ax = (key, T) => axisExpr(pts.map(p => ({t: p.t, v: p[key], tr: p.tr})), T);
    const crop = `crop=${W1}:${H1}:x='clip(${ax('cx', 't')}-ow/2,0,iw-ow)':y='clip(${ax('cy', 't')}-oh/2,0,ih-oh)',scale=${OUT().w}:${OUT().h}:flags=lanczos`;
    let vf = crop;
    if(zoomVaries){
      const S = n3(OUT().w / W1), CX = ax('cx', 'it'), CY = ax('cy', 'it');
      const ux = `(${CX}-clip(${CX}-${W1 / 2},0,${vw - W1}))*${S}`;
      const uy = `(${CY}-clip(${CY}-${H1 / 2},0,${vh - H1}))*${S}`;
      vf += `,zoompan=z='(${ax('z', 'it')})/${n3(zmin)}':x='clip(${ux}-iw/zoom/2,0,iw-iw/zoom)':y='clip(${uy}-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${OUT().w}x${OUT().h}:fps=__SFPS__`;
    }
    return {vf: vf + ',setsar=1', zoomVaries, dur: s.tOut - s.tIn};
  }
  function logoFilter(){
    if(!logo.img) return '';
    const lw = Math.round(OUT().w * logo.size / 2) * 2, m = Math.round(OUT().w * 0.045);
    const x = logo.pos.endsWith('L') ? m : logo.pos.endsWith('R') ? `W-w-${m}` : '(W-w)/2';
    const y = logo.pos.startsWith('Top') ? Math.round(m * 1.6) : `H-h-${Math.round(m * 2.6)}`;
    return `[b];movie=logo.png,scale=${lw}:-1,format=rgba,colorchannelmixer=aa=${logo.opacity.toFixed(2)}[l];[b][l]overlay=${x}:${y}`;
  }
  function atempo(sp){
    if(sp === 1) return 'anull';
    const parts = []; let r = sp;
    while(r < 0.5){ parts.push('atempo=0.5'); r /= 0.5; }
    while(r > 2){ parts.push('atempo=2'); r /= 2; }
    parts.push('atempo=' + n3(r));
    return parts.join(',');
  }
  function buildScript(){
    const list = segs.filter(s => s.vw && s.tOut > s.tIn);
    const L = ['#!/usr/bin/env bash',
      '# Reel Bin Studio — vertical reframe (generated ' + new Date().toISOString() + ')',
      '# Put this script next to the source clips' + (logo.img ? ' and a logo.png' : '') + ', then run:  bash vertical_reframe.sh',
      'set -euo pipefail', 'cd "$(dirname "$0")"', 'OUT="vertical_reel.mp4"', 'FPS=' + outFps,
      'ENC=(-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r "$FPS" -colorspace bt709 -color_primaries bt709 -color_trc bt709 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart)',
      'find_src(){ for f in "$1" "${1%.*}".mp4 "${1%.*}".MP4 "${1%.*}".mov "${1%.*}".MOV "${1%.*}".m4v; do [ -f "$f" ] && { echo "$f"; return 0; }; done; return 1; }',
      '# render <index> <source> <start> <source-duration> <output-duration> <video-filter> <audio-filter>',
      'render(){',
      '  local src; src=$(find_src "$2") || { echo "Missing source clip: $2" >&2; exit 1; }',
      '  local sfps; sfps=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$src")',
      '  local vf="${6//__SFPS__/$sfps}"',
      '  echo "→ part $1: $src ($3s +$4s)"',
      '  if ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$src" | grep -q .; then',
      '    ffmpeg -hide_banner -loglevel error -y -ss "$3" -t "$4" -i "$src" -vf "$vf" -af "$7" -map 0:v:0 -map 0:a:0 "${ENC[@]}" "part_$1.mp4"',
      '  else',
      '    ffmpeg -hide_banner -loglevel error -y -ss "$3" -t "$4" -i "$src" -f lavfi -t "$5" -i anullsrc=r=48000:cl=stereo -vf "$vf" -map 0:v:0 -map 1:a:0 "${ENC[@]}" -shortest "part_$1.mp4"',
      '  fi',
      '}', ': > parts.txt'];
    list.forEach((s, i) => {
      const p = segPlan(s), idx = String(i + 1).padStart(2, '0');
      const vf = p.vf + (s.speed !== 1 ? ',setpts=PTS/' + s.speed : '') + logoFilter();
      L.push(`# ${i + 1}. ${s.name}${s.label ? ' · ' + s.label : ''} | ${s.kfs.length} keyframes${p.zoomVaries ? ' | animated zoom' : ''}${s.speed !== 1 ? ' | ' + s.speed + 'x' : ''}`);
      L.push(`render ${idx} "${(s.fileName || s.name).replace(/"/g, '')}" ${n3(s.tIn)} ${n3(p.dur)} ${n3(p.dur / s.speed)} "${vf}" "${atempo(s.speed)}"`);
      L.push(`echo "file 'part_${idx}.mp4'" >> parts.txt`);
    });
    L.push('ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i parts.txt -c copy "$OUT"', 'echo "✓ $OUT"');
    return {text: L.join('\n') + '\n', count: list.length};
  }
  function buildJson(){
    return JSON.stringify({app: 'reel-bin-studio-web', kind: 'vertical-keyframes', version: 1, output: {format: fmtKey, w: OUT().w, h: OUT().h, fps: outFps},
      logo: logo.img ? {file: 'logo.png', position: logo.pos, widthFraction: logo.size, opacity: logo.opacity} : null,
      clips: segs.map(s => ({file: s.fileName || s.name, name: s.name, label: s.label, in: n3(s.tIn), out: n3(s.tOut), speed: s.speed,
        source: {w: s.vw, h: s.vh}, base: s.base, keyframes: s.kfs.map(k => ({t: n3(k.t), transition: k.tr || 'smooth', cx: n3(k.cx), cy: n3(k.cy), zoom: n3(k.z), crop_px: (r => ({x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h)}))(cropRect(s, k))}))}))}, null, 2);
  }
  let cmdT = null;
  function updateCmd(){
    clearTimeout(cmdT);
    cmdT = setTimeout(() => {
      if(!segs.length){ $('vCmd').textContent = 'Add a clip to see the ffmpeg command.'; return; }
      const b = buildScript();
      $('vCmd').textContent = b.text;
    }, 120);
  }
  $('vDlSh').addEventListener('click', () => { if(!segs.length) return; RBS.saveFile('vertical_reframe.sh', buildScript().text, 'text/x-shellscript'); });
  $('vDlJson').addEventListener('click', () => { if(!segs.length) return; RBS.saveFile('vertical_keyframes.json', buildJson(), 'application/json'); });
  $('vCopyCmd').addEventListener('click', async () => {
    try{ await navigator.clipboard.writeText(buildScript().text); RBS.toast('Script copied', 'lime'); }catch(e){ RBS.toast('Copy blocked by the browser. Use the .sh download.', 'orange'); }
  });

  /* ------------------------------ keyboard ------------------------------ */
  document.addEventListener('keydown', e => {
    if(RBS.currentView() !== 'vertical' || RBS.drawerOpen()) return;
    const tag = (e.target.tagName || '').toUpperCase();
    if(tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    if(e.code === 'Space'){ e.preventDefault(); togglePlay(); }
    else if(e.key === 'ArrowLeft'){ e.preventDefault(); step(-1); }
    else if(e.key === 'ArrowRight'){ e.preventDefault(); step(1); }
    else if(e.key === 'k' || e.key === 'K'){ const st = curState(); if(st) setKf(st, v.currentTime); }
    else if(e.key === 'Delete' || e.key === 'Backspace'){ e.preventDefault(); delKf(); }
    else if(e.key === '['){ jumpKf(-1); }
    else if(e.key === ']'){ jumpKf(1); }
    else if(e.key === 'ArrowUp' || e.key === 'ArrowDown'){
      e.preventDefault();
      const i = segs.findIndex(s => s.id === activeId), n = i + (e.key === 'ArrowUp' ? -1 : 1);
      if(segs[n]) select(segs[n].id);
    }
  });

  RBS.vertical = {segs: () => segs, buildScript, buildJson, evalCrop, cropRect, format: () => Object.assign({key: fmtKey}, OUT()), formats: FORMATS, presets: PRESETS};
  renderPanels(); renderSegs(); refreshPlayerFilter();
  requestAnimationFrame(loop);
})();
