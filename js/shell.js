/* Netflix-on-TV shell: icon-only rail, collapsed by default.
   Finishing a step springs the drawer open (blur only over the left edge);
   it blocks the workspace until you pick a step, click the workspace, or press Esc. */
(function(){
  const $ = id => document.getElementById(id);
  const ICON = {
    marker: '<path d="M5 3h14v18l-7-4.5L5 21z"/><path d="M9 8h6"/>',
    vertical: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M3 8v8M21 8v8"/>',
    library: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    import: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/>',
    platform: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    inspire: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    brief: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/>',
    preview: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5z"/>',
    export: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'
  };
  const STEPS = [
    {id:'marker', label:'Reel Marker', icon:'marker', live:true},
    {id:'vertical', label:'Vertical Maker', icon:'vertical', live:true},
    {sec:'IN THE MAC APP'},
    {id:'library', label:'Library', icon:'library'},
    {id:'import', label:'Import and link', icon:'import'},
    {id:'platform', label:'Platform', icon:'platform'},
    {id:'inspire', label:'Inspire', icon:'inspire'},
    {id:'brief', label:'Decision brief', icon:'brief'},
    {id:'preview', label:'Preview', icon:'preview'},
    {id:'export', label:'Export + recipe', icon:'export'}
  ];
  const state = {view:'marker', status:{marker:'MARK PLAYS', vertical:'FRAME 9:16'}, done:{}, next:null};

  function render(){
    const wrap = $('railItems');
    wrap.innerHTML = '';
    let i = 0;
    STEPS.forEach(s => {
      if(s.sec){ const d = document.createElement('div'); d.className = 'rsec mono'; d.textContent = s.sec; wrap.appendChild(d); return; }
      const b = document.createElement('button');
      const cls = ['it'];
      if(state.view === s.id) cls.push('on');
      if(state.done[s.id]) cls.push('dn');
      if(state.next === s.id && state.view !== s.id) cls.push('nx');
      if(!s.live) cls.push('locked');
      b.className = cls.join(' ');
      b.style.setProperty('--i', i++);
      b.title = s.label + (s.live ? '' : ' (Mac app)');
      b.setAttribute('aria-label', s.label);
      if(state.view === s.id) b.setAttribute('aria-current', 'page');
      const status = s.live ? (state.next === s.id && state.view !== s.id ? 'NEXT' : (state.status[s.id] || '')) : 'MAC APP';
      b.innerHTML = `<span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[s.icon]}</svg>
        <i class="dd"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></i>
        <i class="lk"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></i></span>
        <span class="lab"><span class="l1">${s.label}</span><span class="l2">${status}</span></span>`;
      b.addEventListener('click', () => go(s.id));
      wrap.appendChild(b);
    });
    const ticks = $('railTicks');
    ticks.innerHTML = ['marker','vertical'].map(id => `<i class="tk ${state.done[id] ? 'd' : (state.view === id ? 'c' : '')}"></i>`).join('');
  }

  function go(id){
    const s = STEPS.find(x => x.id === id);
    if(!s) return;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
    if(s.live){
      state.view = id;
      $('view-' + id).classList.add('on');
    } else {
      state.view = id;
      $('lockedTitle').textContent = s.label + ' runs in the Mac app';
      $('view-locked').classList.add('on');
    }
    if(state.next === id) state.next = null;
    close();
    render();
    RBS.emit('view', id);
    window.scrollTo({top:0, behavior:'smooth'});
  }

  function open(){
    $('rail').classList.add('open');
    document.body.classList.add('drawer-open');
    $('railToggle').setAttribute('aria-expanded', 'true');
    $('railToggle').setAttribute('aria-label', 'Close steps');
  }
  function close(){
    $('rail').classList.remove('open');
    document.body.classList.remove('drawer-open');
    $('railToggle').setAttribute('aria-expanded', 'false');
    $('railToggle').setAttribute('aria-label', 'Open steps');
  }
  $('railToggle').addEventListener('click', () => $('rail').classList.contains('open') ? close() : open());
  $('scrim').addEventListener('click', close);
  $('lockedBack').addEventListener('click', () => go('marker'));
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && $('rail').classList.contains('open')){ e.stopImmediatePropagation(); close(); }
  }, true);

  // A step finished: mark it done, highlight the next one, spring the drawer open.
  RBS.on('step-done', ({step, next}) => {
    state.done[step] = true;
    state.next = next || null;
    render();
    setTimeout(open, 250);
  });
  RBS.on('status', ({step, text}) => { state.status[step] = text; render(); });
  RBS.on('job', text => { $('railJob').textContent = text; });
  RBS.go = go;
  RBS.currentView = () => state.view;
  RBS.drawerOpen = () => $('rail').classList.contains('open');
  render();
})();
