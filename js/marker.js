/* Reel Marker — every Reel bin v8 feature, in the Studio shell.
   Changes from v8:
   - Storage is local-first (no Claude artifact database): teams, tag libraries
     AND marks persist in this browser; full backup/restore as JSON.
   - Marks re-attach to a clip by file name when the file is added again
     (v8 created a duplicate file-less clip).
   - Fullscreen edit keeps you in fullscreen across clips: edge arrows, ↑/↓, N/P,
     swipe, a clip strip, a clip counter, per-clip pending in/out, optional auto-play,
     and clips without a loaded file are skipped instead of showing the old video. */
(function(){
  const $ = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = RBS.esc, fmt = RBS.fmt, uid = RBS.uid;

  const DEFAULT_HOME = '#1D3B6B', DEFAULT_AWAY = '#FFFFFF';
  const ZOOM_PRESETS = ['Full', 'Zoom L', 'Zoom C', 'Zoom R', 'Tight'];
  const CATEGORY_PRESETS = ['Team', 'B-roll'];
  const SHORT_CLIP_THRESHOLD = 3.0;
  const PLAY_SEEDS = {
    basketball: ['Dunk','Layup','3-Pointer','Jump Shot','Steal','Block','Assist','Rebound','And-1','Fast Break','Crossover'],
    football: ['Touchdown','Reception','Rush','Sack','Interception','Fumble Recovery','Tackle','Field Goal','Return','Pass Breakup','Pancake Block'],
    volleyball: ['Kill','Ace','Block','Dig','Set','Assist','Pancake','Tip','Serve Receive','Overpass Kill']
  };
  const DIRECTION_SEEDS = ['Slomo','Slice','Opener','Overlay','Freeze','Replay','Speed-ramp','Closer','Zoom punch','Transition'];

  let teams = [], activeTeamId = null;
  let clips = [], activeClipId = null;
  let pendingIn = null, pendingOut = null;
  const pendingByClip = {};
  let selectedPlayers = new Set(), selectedPlays = new Set(), selectedDirections = new Set();
  let selectedZoom = 'Full', selectedCategory = 'Team';
  let pendingNotes = [];
  let playLibrary = {basketball: PLAY_SEEDS.basketball.slice(), football: PLAY_SEEDS.football.slice(), volleyball: PLAY_SEEDS.volleyball.slice()};
  let directionLibrary = DIRECTION_SEEDS.slice();
  let hideShortClips = false;
  let marksSort = {col: 'clip', dir: 1};
  const marksFilter = {text:'', clipf:'', player:'', zoom:'', categoryf:'', play:'', direction:''};

  const video = $('video'), stage = $('stage'), fsHud = $('fsHud');
  const mergeUnique = (a, b) => { const out = a.slice(); (b || []).forEach(x => { if(x && !out.includes(x)) out.push(x); }); return out; };
  const activeTeam = () => teams.find(t => t.id === activeTeamId) || teams[0];
  const activeSport = () => (activeTeam() && activeTeam().sport) || 'basketball';
  const activeClip = () => clips.find(c => c.id === activeClipId);
  const baseName = n => n.replace(/\.[^.]+$/, '');

  /* ------------------------------ persistence ------------------------------ */
  function loadState(){
    teams = RBS.get(RBS.KEY.teams, []) || [];
    if(!teams.length){
      teams = [{id: uid(), name: 'My team', school: '', opponent: '', gameDate: '', sport: 'basketball',
        home: DEFAULT_HOME, away: DEFAULT_AWAY, players: [{name: 'My son', number: ''}]}];
    }
    activeTeamId = teams[0].id;
    const p = RBS.get(RBS.KEY.plays, null);
    if(p){ Object.keys(PLAY_SEEDS).forEach(s => { playLibrary[s] = mergeUnique(PLAY_SEEDS[s], p[s] || []); }); }
    let dirs = RBS.get(RBS.KEY.dirs, []) || [];
    const oldNotes = RBS.get('bb_marker_notes', null);          // v8 migration: old saved notes become directions
    if(Array.isArray(oldNotes)) dirs = mergeUnique(dirs, oldNotes);
    directionLibrary = mergeUnique(DIRECTION_SEEDS, dirs);
    const stored = RBS.get(RBS.KEY.marks, {}) || {};
    Object.keys(stored).forEach(name => {
      const s = stored[name];
      if(!s || !Array.isArray(s.marks) || !s.marks.length) return;
      clips.push({id: 'n:' + name, name, file: null, url: null, fps: s.fps || null, duration: s.duration || null,
        segments: [], jerseyFlags: {}, marks: s.marks, capturedAt: s.capturedAt || null});
    });
  }
  function saveTeams(){ RBS.set(RBS.KEY.teams, teams); RBS.markSaved(); updateTop(); }
  function saveLibraries(){ RBS.set(RBS.KEY.plays, playLibrary); RBS.set(RBS.KEY.dirs, directionLibrary); RBS.markSaved(); }
  function saveMarks(){
    const out = {};
    clips.forEach(c => { if(c.marks.length) out[c.name] = {marks: c.marks, fps: c.fps, duration: c.duration, capturedAt: c.capturedAt}; });
    if(!RBS.set(RBS.KEY.marks, out)) RBS.toast('Browser storage is full. Use Back up to save your marks.', 'red');
    RBS.markSaved();
    publish();
  }
  function publish(){
    let total = 0; clips.forEach(c => total += c.marks.length);
    RBS.emit('status', {step: 'marker', text: total ? total + ' MARKS' : 'MARK PLAYS'});
    const t = activeTeam();
    RBS.emit('job', ((t && t.name) || 'TEAM').toUpperCase() + ' · ' + clips.length + ' CLIP' + (clips.length === 1 ? '' : 'S'));
    RBS.emit('marks-changed', total);
  }
  function updateTop(){
    const t = activeTeam();
    if(!t) return;
    const d = t.gameDate ? new Date(t.gameDate) : null;
    const dStr = d && !isNaN(d) ? d.toLocaleDateString([], {month:'short', day:'numeric'}).toUpperCase() + ' · ' + d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) : '';
    $('gameLine').innerHTML = `<b style="color:var(--ink)">${esc(t.name || 'Team')}</b>${t.opponent ? `<span>vs <b style="color:var(--ink)">${esc(t.opponent)}</b></span>` : ''}${dStr ? `<span>${esc(dStr)}</span>` : ''}`;
  }

  /* ------------------------------ team + roster ------------------------------ */
  function renderTeamSelect(){
    $('teamSelect').innerHTML = teams.map(t => `<option value="${esc(t.id)}"${t.id === activeTeamId ? ' selected' : ''}>${esc(t.name || 'Untitled team')}</option>`).join('');
  }
  function renderTeamFields(){
    const t = activeTeam(); if(!t) return;
    $('teamNameInput').value = t.name || '';
    $('teamSchoolInput').value = t.school || '';
    $('opponentInput').value = t.opponent || '';
    $('gameDateInput').value = t.gameDate || '';
    $('sportSelect').value = t.sport || 'basketball';
    $('homeColorInput').value = t.home || DEFAULT_HOME;
    $('awayColorInput').value = t.away || DEFAULT_AWAY;
    updateTop();
  }
  $('teamSelect').addEventListener('change', e => { activeTeamId = e.target.value; selectedPlayers = new Set(); renderTeamFields(); renderRoster(); renderPlayChips(); renderMarks(); publish(); });
  $('addTeamBtn').addEventListener('click', () => {
    const t = {id: uid(), name: 'Team ' + (teams.length + 1), school: '', opponent: '', gameDate: '', sport: 'basketball', home: DEFAULT_HOME, away: DEFAULT_AWAY, players: [{name: 'Player 1', number: ''}]};
    teams.push(t); activeTeamId = t.id; saveTeams(); renderTeamSelect(); renderTeamFields(); renderRoster();
  });
  $('teamNameInput').addEventListener('change', e => { activeTeam().name = e.target.value; saveTeams(); renderTeamSelect(); publish(); });
  $('teamSchoolInput').addEventListener('change', e => { activeTeam().school = e.target.value; saveTeams(); });
  $('opponentInput').addEventListener('change', e => { activeTeam().opponent = e.target.value; saveTeams(); });
  $('gameDateInput').addEventListener('change', e => { activeTeam().gameDate = e.target.value; saveTeams(); });
  $('sportSelect').addEventListener('change', e => { activeTeam().sport = e.target.value; if(!playLibrary[e.target.value]) playLibrary[e.target.value] = []; saveTeams(); selectedPlays = new Set(); renderPlayChips(); });
  $('homeColorInput').addEventListener('change', e => { activeTeam().home = e.target.value; saveTeams(); renderRoster(); });
  $('awayColorInput').addEventListener('change', e => { activeTeam().away = e.target.value; saveTeams(); renderRoster(); });
  $('teamDrawerToggle').addEventListener('click', () => setTeamCollapsed(!$('teamDrawer').classList.contains('collapsed')));
  function setTeamCollapsed(c){
    $('teamDrawer').classList.toggle('collapsed', c);
    $('teamDrawerToggle').setAttribute('aria-expanded', c ? 'false' : 'true');
    $('teamDrawerLabel').textContent = c ? 'Team ▸ ' + ((activeTeam() && activeTeam().name) || '') : 'Team setup';
    RBS.set(RBS.KEY.teamCollapsed, c ? '1' : '0');
  }
  $('addPlayerBtn').addEventListener('click', () => { const t = activeTeam(); t.players.push({name: 'Player ' + (t.players.length + 1), number: ''}); saveTeams(); renderRoster(); });

  function renderRoster(){
    const t = activeTeam();
    const list = $('rosterList');
    list.innerHTML = '';
    (t.players || []).forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'rr';
      row.innerHTML = `<span class="k">${i < 9 ? i + 1 : ''}</span><span class="num" style="background:${esc(t.home)}">${esc(p.number || '—')}</span>
        <input class="n" value="${esc(p.name)}" data-i="${i}" data-f="name" aria-label="Player name">
        <input class="no" value="${esc(p.number || '')}" placeholder="#" data-i="${i}" data-f="number" aria-label="Jersey number">
        <button class="x" data-del="${i}" title="Remove player" aria-label="Remove player">×</button>`;
      list.appendChild(row);
    });
    list.querySelectorAll('input').forEach(inp => inp.addEventListener('change', e => {
      const i = +e.target.dataset.i, f = e.target.dataset.f;
      const old = t.players[i].name;
      t.players[i][f] = e.target.value.trim();
      if(f === 'name' && selectedPlayers.has(old)){ selectedPlayers.delete(old); selectedPlayers.add(t.players[i].name); }
      saveTeams(); renderRoster(); renderMarks();
    }));
    list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.del;
      if(!confirm('Remove ' + (t.players[i].name || 'this player') + ' from the roster? Existing marks keep their name.')) return;
      selectedPlayers.delete(t.players[i].name);
      t.players.splice(i, 1); saveTeams(); renderRoster();
    }));
    renderChips();
  }

  /* ------------------------------ tag chips ------------------------------ */
  function renderChips(){
    const t = activeTeam();
    $$('.rosterChips').forEach(row => {
      row.innerHTML = '';
      (t.players || []).forEach(p => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cp' + (selectedPlayers.has(p.name) ? ' on' : '');
        chip.innerHTML = `<span class="sw" style="background:${esc(t.home)}"></span>${esc(p.name || 'unnamed')}${p.number ? ' #' + esc(p.number) : ''}`;
        chip.addEventListener('click', () => { selectedPlayers.has(p.name) ? selectedPlayers.delete(p.name) : selectedPlayers.add(p.name); renderChips(); });
        row.appendChild(chip);
      });
      if(!(t.players || []).length) row.innerHTML = '<span class="hint">Add players in Team setup</span>';
    });
  }
  function renderSingle(cls, list, getSel, setSel, extraCls){
    $$('.' + cls).forEach(row => {
      row.innerHTML = '';
      list.forEach(v => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cp ' + (extraCls || '') + (getSel() === v ? ' on' : '');
        chip.textContent = v;
        chip.addEventListener('click', () => { setSel(v); renderSingle(cls, list, getSel, setSel, extraCls); });
        row.appendChild(chip);
      });
    });
  }
  const renderZoomChips = () => renderSingle('zoomChips', ZOOM_PRESETS, () => selectedZoom, v => selectedZoom = v, 'zoom');
  const renderCategoryChips = () => renderSingle('categoryChips', CATEGORY_PRESETS, () => selectedCategory, v => selectedCategory = v, '');

  function renderTagChips(cls, library, selectedSet, placeholder, onAdd){
    $$('.' + cls).forEach(row => {
      row.innerHTML = '';
      library.forEach(tag => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cp' + (selectedSet.has(tag) ? ' on' : '');
        chip.textContent = tag;
        chip.addEventListener('click', () => { selectedSet.has(tag) ? selectedSet.delete(tag) : selectedSet.add(tag); renderTagChips(cls, library, selectedSet, placeholder, onAdd); });
        row.appendChild(chip);
      });
      const input = document.createElement('input');
      input.className = 'tag-add'; input.placeholder = placeholder;
      input.addEventListener('keydown', e => {
        if(e.key !== 'Enter') return;
        e.preventDefault(); e.stopPropagation();
        const v = input.value.trim(); if(!v) return;
        onAdd(v); input.value = '';
      });
      row.appendChild(input);
    });
  }
  function renderPlayChips(){
    const sport = activeSport();
    if(!playLibrary[sport]) playLibrary[sport] = [];
    renderTagChips('playChips', playLibrary[sport], selectedPlays, '+ new play', v => {
      if(!playLibrary[sport].includes(v)){ playLibrary[sport].push(v); saveLibraries(); }
      selectedPlays.add(v); renderPlayChips();
    });
  }
  function renderDirectionChips(){
    renderTagChips('directionChips', directionLibrary, selectedDirections, '+ new direction', v => {
      if(!directionLibrary.includes(v)){ directionLibrary.push(v); saveLibraries(); }
      selectedDirections.add(v); renderDirectionChips();
    });
  }
  function renderPendingNotes(){
    $$('.pendingNotes').forEach(row => {
      row.innerHTML = '';
      if(!pendingNotes.length){ row.innerHTML = '<span class="hint">No notes attached</span>'; return; }
      pendingNotes.forEach((n, i) => {
        const chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'cp note';
        chip.innerHTML = esc(n) + ' <span style="color:var(--ink-4)">×</span>';
        chip.title = 'Remove note';
        chip.addEventListener('click', () => { pendingNotes.splice(i, 1); renderPendingNotes(); });
        row.appendChild(chip);
      });
    });
  }
  const noteInputs = () => $$('.noteInput');
  function setNoteInputs(v){ noteInputs().forEach(i => i.value = v); }
  function addPendingNote(){
    const v = (noteInputs()[0].value || '').trim();
    if(!v) return;
    pendingNotes.push(v); setNoteInputs(''); renderPendingNotes();
  }
  noteInputs().forEach(inp => {
    inp.addEventListener('input', e => setNoteInputs(e.target.value));
    inp.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); e.stopPropagation(); addPendingNote(); } });
  });
  $$('.addNoteBtn').forEach(b => b.addEventListener('click', addPendingNote));

  /* ------------------------------ clip queue ------------------------------ */
  function probeDuration(c){
    if(!c.url) return;
    const probe = document.createElement('video');
    probe.preload = 'metadata'; probe.muted = true; probe.src = c.url;
    probe.addEventListener('loadedmetadata', () => { c.duration = probe.duration; c.vw = probe.videoWidth; c.vh = probe.videoHeight; renderClipList(); probe.removeAttribute('src'); }, {once: true});
  }
  const visibleClips = () => clips.filter(c => !(hideShortClips && c.duration != null && c.duration < SHORT_CLIP_THRESHOLD));
  const isMax = () => stage.classList.contains('max');

  function stepClip(dir){
    let list = visibleClips();
    // In fullscreen, only clips you can actually play; never leave the old video on screen.
    const playable = list.filter(c => c.url);
    if(isMax()) list = playable;
    if(!list.length){ if(isMax()) fsToast('No other clips with a loaded file'); return; }
    let idx = list.findIndex(c => c.id === activeClipId);
    let next;
    if(idx === -1) next = dir > 0 ? list[0] : list[list.length - 1];
    else {
      const n = idx + dir;
      if(n < 0 || n >= list.length){
        fsToast(n < 0 ? 'First clip' : 'Last clip · wrapping around');
        next = list[(n + list.length) % list.length];
      } else next = list[n];
    }
    if(next.id === activeClipId) return;
    const wasPlaying = !video.paused;
    selectClip(next.id, {autoplay: wasPlaying || $('fsAutoplay').checked});
    if(isMax()){
      const pos = list.findIndex(c => c.id === next.id) + 1;
      fsToast(pos + ' / ' + list.length + ' · ' + next.name);
    }
  }

  function renderClipList(){
    const list = $('clipList');
    list.innerHTML = '';
    const shortCount = clips.filter(c => c.duration != null && c.duration < SHORT_CLIP_THRESHOLD).length;
    $('shortCount').textContent = shortCount;
    $('queueCount').textContent = clips.length;
    const vis = visibleClips();
    if(!clips.length){ list.innerHTML = '<p class="hint" style="padding:8px 4px">No clips loaded yet</p>'; refreshMarkFilterOptions(); renderStrip(); return; }
    if(!vis.length){ list.innerHTML = `<p class="hint" style="padding:8px 4px">All ${clips.length} clip(s) are under ${SHORT_CLIP_THRESHOLD}s and hidden. Uncheck “Hide clips under” to see them.</p>`; refreshMarkFilterOptions(); renderStrip(); return; }
    vis.forEach(c => {
      const isShort = c.duration != null && c.duration < SHORT_CLIP_THRESHOLD;
      const row = document.createElement('div');
      row.className = 'cr' + (c.id === activeClipId ? ' on' : '') + (isShort ? ' short' : '');
      row.setAttribute('role', 'button'); row.tabIndex = 0;
      const meta = [c.duration != null ? fmt(c.duration) : '', c.fps ? c.fps + 'fps' : ''].filter(Boolean).join(' · ');
      row.innerHTML = `<span class="dot${c.marks.length ? ' done' : ''}">${c.marks.length || ''}</span>
        <span class="nm"><b>${esc(c.name)}</b><small>${esc(meta || '—')}</small></span>
        ${isShort ? `<span class="badge red" title="Under ${SHORT_CLIP_THRESHOLD}s, likely too short for a full play">${c.duration.toFixed(1)}s</span>` : ''}
        ${!c.url ? '<span class="badge orange" title="Marks are saved, but the video file is not loaded. Add the file again to relink it.">no file</span>' : ''}
        <button class="x" title="Remove from queue" aria-label="Remove clip">×</button>`;
      row.addEventListener('click', e => { if(e.target.closest('.x')) return; selectClip(c.id); });
      row.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); selectClip(c.id); } });
      row.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); removeClip(c.id); });
      list.appendChild(row);
    });
    refreshMarkFilterOptions();
    renderStrip();
  }
  $('hideShortToggle').addEventListener('change', e => { hideShortClips = e.target.checked; renderClipList(); });

  function removeClip(id){
    const c = clips.find(x => x.id === id);
    if(!c) return;
    if(c.marks.length && !confirm(`${c.name} has ${c.marks.length} mark(s). Remove it and its marks?`)) return;
    if(c.url) URL.revokeObjectURL(c.url);
    clips = clips.filter(x => x.id !== id);
    if(activeClipId === id){
      activeClipId = null;
      clearVideo('No clip selected');
      if(clips.length) selectClip(clips[0].id);
    }
    saveMarks(); renderClipList(); renderMarks();
  }
  function clearVideo(msg){
    video.pause(); video.removeAttribute('src'); video.load();
    $('stageEmpty').textContent = msg || 'No clip loaded';
    $('stageEmpty').hidden = false;
  }
  const fmtCaptured = ms => { try{ return ms ? new Date(ms).toLocaleString() : ''; }catch(e){ return ''; } };

  function selectClip(id, opts){
    opts = opts || {};
    if(activeClipId) pendingByClip[activeClipId] = {pIn: pendingIn, pOut: pendingOut};
    activeClipId = id;
    const c = activeClip();
    if(!c) return;
    const saved = pendingByClip[id] || {};
    pendingIn = saved.pIn != null ? saved.pIn : null;
    pendingOut = saved.pOut != null ? saved.pOut : null;
    if(c.url){
      $('stageEmpty').hidden = true;
      if(video.src !== c.url){ video.src = c.url; video.playbackRate = parseFloat($('speedSelect').value) || 1; }
      if(opts.autoplay){ video.addEventListener('loadeddata', () => video.play().catch(() => {}), {once: true}); }
    } else {
      clearVideo('“' + c.name + '” is not loaded on this device. Add the file again to relink its ' + c.marks.length + ' mark(s).');
    }
    const cap = c.capturedAt ? `<small>${esc(fmtCaptured(c.capturedAt))} (file date)</small>` : '';
    $('clipTitle').innerHTML = `<b>${esc(c.name)}</b>${c.fps ? `<small>${esc(c.fps)} fps</small>` : ''}${cap}`;
    $('fsClipName').innerHTML = `${esc(c.name)}<small>${c.marks.length} mark${c.marks.length === 1 ? '' : 's'}${c.fps ? ' · ' + esc(c.fps) + ' fps' : ''}</small>`;
    updateCount();
    updatePendingLabels(); renderClipList(); renderTicks(); renderMarks();
  }
  function updateCount(){
    const list = visibleClips().filter(c => c.url);
    const i = list.findIndex(c => c.id === activeClipId);
    $('fsCount').textContent = (i >= 0 ? i + 1 : '–') + ' / ' + list.length;
  }

  function renderTicks(){
    const c = activeClip();
    const ticks = $('scrubTicks'), mk = $('scrubMarks');
    ticks.innerHTML = ''; mk.innerHTML = '';
    if(!c || !c.duration) return;
    (c.segments || []).forEach(seg => { const d = document.createElement('div'); d.className = 'tick'; d.style.left = (seg.start / c.duration * 100) + '%'; ticks.appendChild(d); });
    c.marks.forEach(m => { const d = document.createElement('div'); d.className = 'mkr'; d.style.left = (m.start / c.duration * 100) + '%'; d.style.width = Math.max(0.4, (m.end - m.start) / c.duration * 100) + '%'; mk.appendChild(d); });
  }

  function handleFiles(fileList){
    let added = 0, relinked = 0, dupes = 0, errors = 0;
    Array.from(fileList).forEach(file => {
      const name = baseName(file.name);
      const existing = clips.find(c => c.name === name);
      if(existing && existing.url){ dupes++; return; }
      try{
        const url = URL.createObjectURL(file);
        if(existing){
          Object.assign(existing, {file, url, capturedAt: existing.capturedAt || file.lastModified || null});
          probeDuration(existing); relinked++;
        } else {
          const clip = {id: file.name + '_' + file.size, name, file, url, fps: null, duration: null, segments: [], jerseyFlags: {}, marks: [], capturedAt: file.lastModified || null};
          clips.push(clip); probeDuration(clip); added++;
        }
        const t = activeTeam();
        if(t && !t.gameDate && file.lastModified){
          const d = new Date(file.lastModified), pad = n => String(n).padStart(2, '0');
          t.gameDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          saveTeams(); renderTeamFields();
        }
      }catch(e){ console.error('Could not load', file.name, e); errors++; }
    });
    renderClipList(); publish();
    const cur = activeClip();
    if(!cur || !cur.url){ const first = clips.find(c => c.url); if(first) selectClip(first.id); }
    const parts = [];
    if(added) parts.push(added + ' added');
    if(relinked) parts.push(relinked + ' relinked to saved marks');
    if(dupes) parts.push(dupes + ' already in the queue');
    if(errors) parts.push(errors + ' could not load');
    if(parts.length) RBS.toast(parts.join(' · '), errors ? 'red' : (added || relinked ? 'lime' : 'orange'));
  }
  function handleHints(fileList){
    Array.from(fileList).forEach(file => {
      const r = new FileReader();
      r.onload = () => {
        try{
          const data = JSON.parse(r.result);
          const clip = clips.find(c => c.name === data.clip);
          if(clip){
            clip.fps = data.fps; clip.duration = clip.duration || data.duration;
            clip.segments = data.segments || []; clip.jerseyFlags = data.jersey_flags || {};
            if(clip.id === activeClipId) selectClip(clip.id);
            renderClipList();
          }
        }catch(e){ console.warn('bad hints file', file.name); }
      };
      r.readAsText(file);
    });
  }
  $('clipInput').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
  $('hintsInput').addEventListener('change', e => { handleHints(e.target.files); e.target.value = ''; });

  // Page-wide drop goes to whichever tool is open.
  let dragDepth = 0;
  document.addEventListener('dragenter', e => { if(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')){ dragDepth++; document.body.classList.add('dragging'); } });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if(!dragDepth) document.body.classList.remove('dragging'); });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    const files = Array.from(e.dataTransfer.files || []);
    const vids = files.filter(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name));
    const jsons = files.filter(f => /\.json$/i.test(f.name));
    if(RBS.currentView() === 'vertical'){ if(vids.length) RBS.emit('vertical-files', vids); return; }
    if(vids.length) handleFiles(vids);
    if(jsons.length) handleHints(jsons);
  });

  /* ------------------------------ playback ------------------------------ */
  video.addEventListener('loadedmetadata', () => {
    const c = activeClip();
    if(c){ c.duration = c.duration || video.duration; renderTicks(); }
    $('tcDuration').textContent = fmt(video.duration);
    updatePendingLabels();
  });
  video.addEventListener('timeupdate', paintHead);
  video.addEventListener('seeked', paintHead);
  function paintHead(){
    $('tcCurrent').textContent = fmt(video.currentTime);
    const pct = video.duration ? video.currentTime / video.duration * 100 : 0;
    $('scrubFill').style.width = pct + '%'; $('scrubHead').style.left = pct + '%';
    $('fsFill').style.width = pct + '%'; $('fsHead').style.left = pct + '%';
  }
  function bindScrub(el){
    let down = false;
    const seek = e => {
      if(!video.duration) return;
      const r = el.getBoundingClientRect();
      video.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * video.duration;
    };
    el.addEventListener('pointerdown', e => { down = true; el.setPointerCapture(e.pointerId); seek(e); });
    el.addEventListener('pointermove', e => { if(down) seek(e); });
    el.addEventListener('pointerup', () => { down = false; });
    el.addEventListener('pointercancel', () => { down = false; });
  }
  bindScrub($('scrub')); bindScrub($('fsScrub'));

  function togglePlay(){ if(!video.src) return; video.paused ? video.play().catch(() => {}) : video.pause(); }
  $('playBtn').addEventListener('click', togglePlay);
  $('fsPlayBtn').addEventListener('click', togglePlay);
  video.addEventListener('click', () => { if(!isMax()) togglePlay(); });
  video.addEventListener('play', () => { $('playBtn').textContent = '❚❚'; $('fsPlayBtn').textContent = '❚❚'; });
  video.addEventListener('pause', () => { $('playBtn').textContent = '▶'; $('fsPlayBtn').textContent = '▶'; });
  function frameStep(dir){
    const c = activeClip(); const fps = (c && c.fps) || 30;
    video.pause();
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + dir / fps));
  }
  $('stepBackBtn').addEventListener('click', () => frameStep(-1));
  $('stepFwdBtn').addEventListener('click', () => frameStep(1));
  $('fsBackBtn').addEventListener('click', () => frameStep(-1));
  $('fsFwdBtn').addEventListener('click', () => frameStep(1));
  $('speedSelect').addEventListener('change', e => { video.playbackRate = parseFloat(e.target.value); });
  $('prevClipBtn').addEventListener('click', () => stepClip(-1));
  $('nextClipBtn').addEventListener('click', () => stepClip(1));
  ['fsPrevBtn', 'fsPrevEdge'].forEach(id => $(id).addEventListener('click', e => { e.stopPropagation(); stepClip(-1); }));
  ['fsNextBtn', 'fsNextEdge'].forEach(id => $(id).addEventListener('click', e => { e.stopPropagation(); stepClip(1); }));

  /* ------------------------------ in / out + marks ------------------------------ */
  function updatePendingLabels(){
    const i = pendingIn == null ? '—' : fmt(pendingIn), o = pendingOut == null ? '—' : fmt(pendingOut);
    $('pendingIn').textContent = i; $('pendingOut').textContent = o;
    $('fsPendingIn').textContent = i; $('fsPendingOut').textContent = o;
    $('pendingLen').textContent = (pendingIn != null && pendingOut != null) ? Math.abs(pendingOut - pendingIn).toFixed(2) + 's' : '—';
    const d = video.duration;
    [['scrubRng'], ['fsRng']].forEach(([id]) => {
      const el = $(id);
      if(d && (pendingIn != null || pendingOut != null)){
        const a = pendingIn != null ? pendingIn : 0, b = pendingOut != null ? pendingOut : video.currentTime;
        const lo = Math.min(a, b), hi = Math.max(a, b);
        el.hidden = false; el.style.left = (lo / d * 100) + '%'; el.style.width = ((hi - lo) / d * 100) + '%';
      } else el.hidden = true;
    });
  }
  const doMarkIn = () => { pendingIn = video.currentTime; updatePendingLabels(); flashStatus('In set at ' + fmt(pendingIn)); };
  const doMarkOut = () => { pendingOut = video.currentTime; updatePendingLabels(); flashStatus('Out set at ' + fmt(pendingOut)); };
  const doInZero = () => { pendingIn = 0; updatePendingLabels(); };
  const doOutEnd = () => { pendingOut = video.duration || 0; updatePendingLabels(); };
  $('markInBtn').addEventListener('click', doMarkIn); $('fsMarkInBtn').addEventListener('click', doMarkIn);
  $('markOutBtn').addEventListener('click', doMarkOut); $('fsMarkOutBtn').addEventListener('click', doMarkOut);
  $('inZeroBtn').addEventListener('click', doInZero); $('fsInZeroBtn').addEventListener('click', doInZero);
  $('outEndBtn').addEventListener('click', doOutEnd); $('fsOutEndBtn').addEventListener('click', doOutEnd);
  function flashStatus(msg, kind){
    const s = $('markStatus'); s.textContent = msg; s.style.color = kind === 'ok' ? 'var(--lime)' : (kind === 'bad' ? 'var(--red)' : 'var(--teal)');
    clearTimeout(s._h); s._h = setTimeout(() => { s.textContent = ''; }, 2600);
    if(isMax()) fsToast(msg);
  }

  function doAddMark(){
    const c = activeClip();
    if(!c){ flashStatus('Load a clip first', 'bad'); return; }
    if(pendingIn == null || pendingOut == null){ flashStatus('Set both an in and an out point first', 'bad'); return; }
    const leftover = (noteInputs()[0].value || '').trim();
    if(leftover) pendingNotes.push(leftover);
    const start = Math.min(pendingIn, pendingOut), end = Math.max(pendingIn, pendingOut);
    if(end - start < 0.05){ flashStatus('In and out are the same frame', 'bad'); return; }
    const t = activeTeam();
    const players = Array.from(selectedPlayers).map(name => { const p = (t.players || []).find(pl => pl.name === name); return {name, number: (p && p.number) || ''}; });
    const mark = {id: uid(), start, end, team: t.name, category: selectedCategory, players, zoom: selectedZoom,
      plays: Array.from(selectedPlays), directions: Array.from(selectedDirections), notes: pendingNotes.slice()};
    c.marks.push(mark);
    pendingIn = null; pendingOut = null; delete pendingByClip[c.id];
    selectedPlayers = new Set(); selectedPlays = new Set(); selectedDirections = new Set(); pendingNotes = [];
    setNoteInputs('');
    updatePendingLabels(); renderChips(); renderPlayChips(); renderDirectionChips(); renderPendingNotes();
    saveMarks(); renderClipList(); renderTicks(); renderMarks();
    $('fsClipName').querySelector('small') && ($('fsClipName').querySelector('small').textContent = c.marks.length + ' mark' + (c.marks.length === 1 ? '' : 's'));
    flashStatus('✓ Mark added (' + fmt(start) + ' – ' + fmt(end) + ')', 'ok');
  }
  $$('.addMarkBtn').forEach(b => b.addEventListener('click', doAddMark));

  /* ------------------------------ fullscreen edit ------------------------------ */
  // A CSS full-viewport overlay instead of requestFullscreen(): works the same in
  // every browser, in an installed PWA, and keeps all marking controls usable.
  let hudTimer = null, toastTimer = null;
  function wakeHud(){
    if(!isMax()) return;
    fsHud.classList.remove('dim');
    clearTimeout(hudTimer);
    if(fsHud.classList.contains('tray') || fsHud.classList.contains('strip')) return;
    hudTimer = setTimeout(() => fsHud.classList.add('dim'), 2800);
  }
  function fsToast(msg){
    if(!isMax()) return;
    const t = $('fsToast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }
  // The stage moves to <body> while maximized: glass panels use backdrop-filter,
  // which would otherwise trap a position:fixed child inside the panel.
  const stageHome = document.createComment('stage-home');
  function enterFullscreen(){
    if(isMax()) return;
    stage.parentNode.insertBefore(stageHome, stage);
    document.body.appendChild(stage);
    stage.classList.add('max'); document.body.classList.add('stage-locked');
    updateCount(); renderStrip(); wakeHud();
  }
  function exitFullscreen(){
    if(!isMax()) return;
    stage.classList.remove('max'); fsHud.classList.remove('dim', 'tray', 'strip');
    if(stageHome.parentNode){ stageHome.parentNode.insertBefore(stage, stageHome); stageHome.remove(); }
    document.body.classList.remove('stage-locked'); clearTimeout(hudTimer);
    const row = $('clipList').querySelector('.cr.on'); if(row) row.scrollIntoView({block: 'nearest'});
  }
  $('fsEnterBtn').addEventListener('click', enterFullscreen);
  $('fsExitBtn').addEventListener('click', exitFullscreen);
  $('fsTrayToggle').addEventListener('click', () => { fsHud.classList.toggle('tray'); wakeHud(); });
  $('fsStripToggle').addEventListener('click', () => { fsHud.classList.toggle('strip'); renderStrip(); wakeHud(); });
  ['pointermove', 'pointerdown'].forEach(evt => stage.addEventListener(evt, wakeHud, {passive: true}));
  // Swipe left/right on the picture to change clips (phones / tablets).
  let sx = null, sy = null;
  video.addEventListener('touchstart', e => { if(!isMax()) return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, {passive: true});
  video.addEventListener('touchend', e => {
    if(sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
    if(Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) stepClip(dx < 0 ? 1 : -1);
    else togglePlay();
  });
  function renderStrip(){
    const strip = $('fsStrip');
    if(!isMax() || !fsHud.classList.contains('strip')){ strip.innerHTML = ''; return; }
    strip.innerHTML = '';
    visibleClips().forEach((c, i) => {
      const b = document.createElement('button');
      b.className = (c.id === activeClipId ? 'on' : '') + (c.url ? '' : ' nofile');
      b.innerHTML = `<b>${i + 1}. ${esc(c.name)}</b><small>${c.marks.length} mark${c.marks.length === 1 ? '' : 's'}${c.url ? '' : ' · no file'}</small>`;
      b.addEventListener('click', () => { if(!c.url){ fsToast('Add this file again to play it'); return; } selectClip(c.id, {autoplay: $('fsAutoplay').checked}); });
      strip.appendChild(b);
    });
    const on = strip.querySelector('.on'); if(on) on.scrollIntoView({inline: 'center', block: 'nearest'});
  }

  /* ------------------------------ marks table ------------------------------ */
  function flatMarks(){
    const out = [];
    clips.forEach(c => c.marks.forEach((m, i) => out.push(Object.assign({clipId: c.id, clipName: c.name, idx: i}, m))));
    return out;
  }
  function filteredSortedMarks(){
    let rows = flatMarks();
    const f = marksFilter;
    if(f.clipf) rows = rows.filter(r => r.clipId === f.clipf);
    if(f.categoryf) rows = rows.filter(r => (r.category || 'Team') === f.categoryf);
    if(f.play) rows = rows.filter(r => (r.plays || []).includes(f.play));
    if(f.direction) rows = rows.filter(r => (r.directions || []).includes(f.direction));
    if(f.player) rows = rows.filter(r => (r.players || []).some(p => p.name === f.player));
    if(f.zoom) rows = rows.filter(r => (r.zoom || 'Full') === f.zoom);
    if(f.text){
      const q = f.text.toLowerCase();
      rows = rows.filter(r => [(r.notes || []).join(' '), (r.players || []).map(p => p.name + ' ' + (p.number || '')).join(' '), (r.plays || []).join(' '), (r.directions || []).join(' '), r.clipName].join(' ').toLowerCase().includes(q));
    }
    const col = marksSort.col, dir = marksSort.dir;
    const key = r => {
      switch(col){
        case 'start': return r.start; case 'end': return r.end;
        case 'player': return (r.players || []).map(p => p.name).join(', ').toLowerCase();
        case 'category': return r.category || 'Team';
        case 'play': return (r.plays || []).join(', ').toLowerCase();
        case 'direction': return (r.directions || []).join(', ').toLowerCase();
        case 'zoom': return r.zoom || '';
        case 'note': return (r.notes || []).join(' ').toLowerCase();
        default: return r.clipName.toLowerCase() + ' ' + String(r.start.toFixed(2)).padStart(9, '0');
      }
    };
    rows.sort((a, b) => { const av = key(a), bv = key(b); return av < bv ? -dir : av > bv ? dir : 0; });
    return rows;
  }
  function renderMarks(){
    const body = $('marksBody');
    body.innerHTML = '';
    const rows = filteredSortedMarks();
    let total = 0, broll = 0;
    clips.forEach(c => c.marks.forEach(m => { total++; if((m.category || 'Team') === 'B-roll') broll++; }));
    $('markCount').textContent = total;
    $('markSplit').innerHTML = total ? `<span class="chip k-lime">${total - broll} team · ${broll} b-roll</span>` : '';
    $('marksEmptyHint').textContent = total === 0 ? 'No marks yet. Set in and out on a clip, tag it, then Add mark.' : (rows.length === 0 ? 'No marks match the current filter.' : '');
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'jump'; tr.title = 'Jump to this mark';
      const who = (r.players && r.players.length) ? r.players.map(p => esc(p.name) + (p.number ? ' #' + esc(p.number) : '')).join(', ') : '—';
      const cat = r.category || 'Team';
      tr.innerHTML = `<td>${esc(r.clipName)}</td><td><span class="tg${cat === 'B-roll' ? ' broll' : ''}">${esc(cat)}</span></td>
        <td>${(r.plays || []).map(p => `<span class="tg play">${esc(p)}</span>`).join('')}</td>
        <td class="n">${fmt(r.start)}</td><td class="n">${fmt(r.end)}</td><td>${who}</td><td>${esc(r.zoom || 'Full')}</td>
        <td>${(r.directions || []).map(d => `<span class="tg dir">${esc(d)}</span>`).join('')}</td>
        <td>${esc((r.notes || []).join(' · '))}</td>
        <td><button class="x" data-clip="${esc(r.clipId)}" data-i="${r.idx}" aria-label="Delete mark" title="Delete mark">×</button></td>`;
      tr.addEventListener('click', e => {
        if(e.target.closest('.x')) return;
        if(r.clipId !== activeClipId) selectClip(r.clipId);
        const c = activeClip();
        if(c && c.url){
          const go = () => { video.currentTime = r.start; pendingIn = r.start; pendingOut = r.end; updatePendingLabels(); };
          video.readyState >= 1 ? go() : video.addEventListener('loadedmetadata', go, {once: true});
          stage.scrollIntoView({behavior: 'smooth', block: 'center'});
        }
      });
      body.appendChild(tr);
    });
    body.querySelectorAll('.x').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      const c = clips.find(x => x.id === btn.dataset.clip);
      if(!c) return;
      c.marks.splice(+btn.dataset.i, 1);
      // Drop a file-less clip once its last mark is gone.
      if(!c.url && !c.marks.length){ clips = clips.filter(x => x !== c); if(activeClipId === c.id){ activeClipId = null; clearVideo(); } }
      saveMarks(); renderClipList(); renderTicks(); renderMarks();
    }));
    $$('.mt th[data-col]').forEach(th => {
      th.querySelectorAll('.ar').forEach(a => a.remove());
      if(th.dataset.col === marksSort.col){ const a = document.createElement('span'); a.className = 'ar'; a.textContent = marksSort.dir === 1 ? '▲' : '▼'; th.appendChild(a); }
    });
  }
  $$('.mt th[data-col]').forEach(th => th.addEventListener('click', () => {
    const col = th.dataset.col;
    marksSort = marksSort.col === col ? {col, dir: -marksSort.dir} : {col, dir: 1};
    renderMarks();
  }));
  function refreshMarkFilterOptions(){
    const sel = id => $(id);
    const keep = {}; ['filterClip','filterPlayer','filterZoom','filterCategory','filterPlay','filterDirection'].forEach(id => keep[id] = sel(id).value);
    const players = new Set(), plays = new Set(), dirs = new Set();
    clips.forEach(c => c.marks.forEach(m => { (m.players || []).forEach(p => p.name && players.add(p.name)); (m.plays || []).forEach(x => plays.add(x)); (m.directions || []).forEach(x => dirs.add(x)); }));
    const opts = (all, list, val) => `<option value="">${all}</option>` + list.map(v => `<option value="${esc(val ? val(v) : v)}">${esc(typeof v === 'string' ? v : v.name)}</option>`).join('');
    sel('filterClip').innerHTML = opts('All clips', clips, c => c.id);
    sel('filterPlayer').innerHTML = opts('All players', Array.from(players).sort());
    sel('filterZoom').innerHTML = opts('All zooms', ZOOM_PRESETS);
    sel('filterCategory').innerHTML = opts('All categories', CATEGORY_PRESETS);
    sel('filterPlay').innerHTML = opts('All plays', Array.from(plays).sort());
    sel('filterDirection').innerHTML = opts('All directions', Array.from(dirs).sort());
    Object.keys(keep).forEach(id => { sel(id).value = keep[id]; });
  }
  $('filterText').addEventListener('input', e => { marksFilter.text = e.target.value; renderMarks(); });
  [['filterClip','clipf'],['filterPlayer','player'],['filterZoom','zoom'],['filterCategory','categoryf'],['filterPlay','play'],['filterDirection','direction']]
    .forEach(([id, k]) => $(id).addEventListener('change', e => { marksFilter[k] = e.target.value; renderMarks(); }));

  /* ------------------------------ export / import / backup ------------------------------ */
  function allMarks(){
    const out = [];
    clips.forEach(c => c.marks.forEach(m => out.push({
      id: m.id, clip: c.name, category: m.category || 'Team', start: m.start, end: m.end, team: m.team || '',
      players: m.players || [], zoom: m.zoom || 'Full', plays: m.plays || [], directions: m.directions || [], notes: m.notes || []
    })));
    return out;
  }
  const fullJson = () => JSON.stringify({app: 'reel-bin-studio-web', version: 1, exportedAt: new Date().toISOString(),
    teams, tagLibraries: {plays: playLibrary, directions: directionLibrary}, marks: allMarks()}, null, 2);
  $('exportJsonBtn').addEventListener('click', () => {
    const n = allMarks().length;
    if(!n){ RBS.toast('No marks to export yet', 'orange'); return; }
    RBS.saveFile('highlight_marks.json', fullJson(), 'application/json');
    RBS.toast('Exported ' + n + ' marks as highlight_marks.json', 'lime');
    RBS.emit('step-done', {step: 'marker', next: 'vertical'});
  });
  $('backupBtn').addEventListener('click', () => {
    const d = new Date(), pad = x => String(x).padStart(2, '0');
    RBS.saveFile(`reel-bin-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`, fullJson(), 'application/json');
    RBS.toast('Backup downloaded. Keep it somewhere safe; it restores on any device.', 'lime');
  });
  $('exportCsvBtn').addEventListener('click', () => {
    const rows = [['clip','category','play','start','end','team','players','zoom','direction','notes'], ...allMarks().map(m => [
      m.clip, m.category, m.plays.join('; '), m.start, m.end, m.team,
      m.players.map(p => p.name + (p.number ? ' #' + p.number : '')).join('; '), m.zoom, m.directions.join('; '), m.notes.join('; ')])];
    RBS.saveFile('highlight_marks.csv', rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  });
  function parseCsv(text){
    const rows = []; let row = [], cur = '', q = false;
    for(let i = 0; i < text.length; i++){
      const ch = text[i];
      if(q){ if(ch === '"'){ if(text[i + 1] === '"'){ cur += '"'; i++; } else q = false; } else cur += ch; }
      else if(ch === '"') q = true;
      else if(ch === ','){ row.push(cur); cur = ''; }
      else if(ch === '\n' || ch === '\r'){ if(ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if(row.some(v => v !== '')) rows.push(row); row = []; }
      else cur += ch;
    }
    row.push(cur); if(row.some(v => v !== '')) rows.push(row);
    return rows;
  }
  const splitList = s => String(s || '').split(';').map(x => x.trim()).filter(Boolean);
  function marksFromCsv(text){
    const rows = parseCsv(text.replace(/^﻿/, ''));
    if(rows.length < 2) return [];
    const head = rows[0].map(h => h.trim().toLowerCase());
    return rows.slice(1).map(r => {
      const g = n => { const i = head.indexOf(n); return i >= 0 ? (r[i] || '') : ''; };
      return {clip: g('clip').trim(), category: g('category') || 'Team', start: parseFloat(g('start')), end: parseFloat(g('end')),
        team: g('team'), zoom: g('zoom') || 'Full',
        players: splitList(g('players')).map(s => { const m = s.match(/^(.*?)\s*#\s*(\S+)$/); return m ? {name: m[1].trim(), number: m[2]} : {name: s, number: ''}; }),
        plays: splitList(g('play')), directions: splitList(g('direction')), notes: splitList(g('notes'))};
    }).filter(m => m.clip && isFinite(m.start) && isFinite(m.end));
  }
  function importText(name, text, isCsv){
    let incoming = [];
    if(isCsv){
      incoming = marksFromCsv(text);
      if(!incoming.length) throw new Error('no usable rows (need clip, start, end columns)');
    } else {
      const data = JSON.parse(text);
      if(Array.isArray(data)) incoming = data;
      else {
        if(data.teams && data.teams.length){
          // Merge by id so a backup from another device doesn't wipe local teams.
          data.teams.forEach(t => { const i = teams.findIndex(x => x.id === t.id); if(i >= 0) teams[i] = t; else teams.push(t); });
          activeTeamId = data.teams[0].id; saveTeams(); renderTeamSelect(); renderTeamFields(); renderRoster();
        }
        if(data.tagLibraries){
          const tl = data.tagLibraries;
          if(tl.plays) Object.keys(tl.plays).forEach(s => { playLibrary[s] = mergeUnique(playLibrary[s] || [], tl.plays[s] || []); });
          if(Array.isArray(tl.directions)) directionLibrary = mergeUnique(directionLibrary, tl.directions);
        }
        incoming = data.marks || [];
      }
    }
    let added = 0, updated = 0;
    const newPlays = new Set(), newDirs = new Set();
    incoming.forEach(m => {
      if(!m || !m.clip) return;
      const cname = baseName(String(m.clip));
      let c = clips.find(x => x.name === cname || x.name === m.clip);
      if(!c){ c = {id: 'n:' + cname, name: cname, file: null, url: null, fps: null, duration: null, segments: [], jerseyFlags: {}, marks: [], capturedAt: null}; clips.push(c); }
      const players = m.players || (m.player ? [{name: m.player, number: m.number || ''}] : []);
      const notes = m.notes || (m.note ? [m.note] : []);
      const fields = {start: +m.start, end: +m.end, team: m.team || '', category: m.category || 'Team', players, zoom: m.zoom || 'Full',
        plays: m.plays || [], directions: m.directions || [], notes};
      fields.plays.forEach(x => newPlays.add(x)); fields.directions.forEach(x => newDirs.add(x));
      const same = c.marks.find(x => (m.id && x.id === m.id) || (Math.abs(x.start - fields.start) < 0.01 && Math.abs(x.end - fields.end) < 0.01));
      if(same){ Object.assign(same, fields); updated++; }
      else { c.marks.push(Object.assign({id: m.id || uid()}, fields)); added++; }
    });
    if(newPlays.size || newDirs.size){
      playLibrary[activeSport()] = mergeUnique(playLibrary[activeSport()] || [], Array.from(newPlays));
      directionLibrary = mergeUnique(directionLibrary, Array.from(newDirs));
    }
    saveLibraries(); renderPlayChips(); renderDirectionChips();
    saveMarks(); renderClipList(); renderTicks(); renderMarks();
    RBS.toast('Imported ' + added + ' new, ' + updated + ' updated from ' + name, 'lime');
  }
  function bindImport(input){
    input.addEventListener('change', e => {
      const file = e.target.files[0]; e.target.value = '';
      if(!file) return;
      const r = new FileReader();
      r.onload = () => { try{ importText(file.name, r.result, /\.csv$/i.test(file.name) || file.type === 'text/csv'); }catch(err){ RBS.toast('Could not read ' + file.name + ': ' + (err.message || 'unknown error'), 'red'); } };
      r.readAsText(file);
    });
  }
  bindImport($('importInput')); bindImport($('restoreInput'));

  $('sendToVerticalBtn').addEventListener('click', () => {
    if(!allMarks().length){ RBS.toast('Add some marks first', 'orange'); return; }
    RBS.go('vertical'); RBS.emit('marks-to-vertical');
  });

  /* ------------------------------ keyboard ------------------------------ */
  document.addEventListener('keydown', e => {
    if(RBS.currentView() !== 'marker' || RBS.drawerOpen()) return;
    if(e.key === 'Escape' && isMax()){ exitFullscreen(); return; }
    const tag = (e.target.tagName || '').toUpperCase();
    if(tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    wakeHud();
    const k = e.key;
    if(e.code === 'Space'){ e.preventDefault(); togglePlay(); }
    else if(k === 'i' || k === 'I') doMarkIn();
    else if(k === 'o' || k === 'O') doMarkOut();
    else if(k === 'ArrowLeft'){ e.preventDefault(); frameStep(-1); }
    else if(k === 'ArrowRight'){ e.preventDefault(); frameStep(1); }
    else if(k === 'ArrowUp' || k === 'p' || k === 'P' || k === 'PageUp'){ e.preventDefault(); stepClip(-1); }
    else if(k === 'ArrowDown' || k === 'n' || k === 'N' || k === 'PageDown'){ e.preventDefault(); stepClip(1); }
    else if(k === 'f' || k === 'F'){ isMax() ? exitFullscreen() : enterFullscreen(); }
    else if((k === 't' || k === 'T') && isMax()){ fsHud.classList.toggle('tray'); wakeHud(); }
    else if((k === 'c' || k === 'C') && isMax()){ fsHud.classList.toggle('strip'); renderStrip(); wakeHud(); }
    else if(k === 'Enter' && tag !== 'BUTTON'){ e.preventDefault(); doAddMark(); }
    else if(/^[1-9]$/.test(k)){
      const p = activeTeam().players[+k - 1];
      if(p){ selectedPlayers.has(p.name) ? selectedPlayers.delete(p.name) : selectedPlayers.add(p.name); renderChips(); flashStatus((selectedPlayers.has(p.name) ? '+ ' : '− ') + p.name); }
    }
  });

  /* ------------------------------ public API for other views ------------------------------ */
  RBS.marker = {
    clips: () => clips,
    team: activeTeam,
    teams: () => teams
  };

  /* ------------------------------ boot ------------------------------ */
  loadState();
  setTeamCollapsed(RBS.get(RBS.KEY.teamCollapsed, '0') === '1');
  renderTeamSelect(); renderTeamFields(); renderRoster();
  renderZoomChips(); renderCategoryChips(); renderPlayChips(); renderDirectionChips(); renderPendingNotes();
  renderClipList(); renderMarks(); updatePendingLabels(); publish();
  RBS.set(RBS.KEY.marks, RBS.get(RBS.KEY.marks, {}));
})();
