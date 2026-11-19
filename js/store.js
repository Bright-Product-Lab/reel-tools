/* Local-first storage + tiny event bus shared by every view.
   Everything small (teams, tag libraries, marks, prefs) lives in this
   browser's localStorage. Video files are never stored or uploaded:
   marks re-attach to a clip by file name when it's added again. */
(function(){
  const KEY = {
    teams: 'bb_marker_teams',        // same keys as Reel bin v8, so old local data carries over
    plays: 'bb_marker_playlib',
    dirs: 'bb_marker_dirlib',
    teamCollapsed: 'bb_marker_team_collapsed',
    marks: 'rbs_marks_v1',           // { clipName: {marks:[...], fps, duration, capturedAt} }
    prefs: 'rbs_prefs_v1'
  };
  function get(k, def){
    try{ const raw = localStorage.getItem(k); return raw == null ? def : JSON.parse(raw); }catch(e){ return def; }
  }
  function set(k, v){
    try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; }
  }
  const bus = new EventTarget();
  const RBS = window.RBS = {
    KEY, get, set, bus,
    emit(name, detail){ bus.dispatchEvent(new CustomEvent(name, {detail})); },
    on(name, fn){ bus.addEventListener(name, e => fn(e.detail)); },
    uid(){ return 'm' + Math.random().toString(36).slice(2, 10); },
    esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); },
    fmt(s){
      if(!isFinite(s) || s < 0) s = 0;
      const m = Math.floor(s / 60), sec = (s % 60).toFixed(2).padStart(5, '0');
      return m + ':' + sec;
    },
    async saveFile(filename, data, mime){
      const blob = data instanceof Blob ? data : new Blob([data], {type: mime});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    },
    toast(msg, kind){
      const t = document.getElementById('toast');
      if(!t) return;
      t.textContent = msg; t.className = 'toast show ' + (kind || '');
      clearTimeout(t._h); t._h = setTimeout(() => { t.className = 'toast ' + (kind || ''); }, 3200);
    }
  };
  RBS.markSaved = function(){
    const chip = document.getElementById('saveChip');
    if(!chip) return;
    const d = new Date();
    chip.textContent = 'Saved on this device · ' + d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  };
})();
