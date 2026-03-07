/**
 * Lorebook Auto-Updater v1.1
 * SillyTavern Extension — IIFE, no ES imports
 */

(() => {
  'use strict';

  const EXT_KEY = 'lau_lorebook_updater';

  const DEFAULTS = {
    selectedBooks:    [],
    messageScanCount: 20,
    autoEnabled:      false,
    autoInterval:     5,
    prompt: `You are a lorebook assistant for a roleplay session.

Analyze the provided chat messages and the existing lorebook entries below.

Find important entities: characters, places, objects, factions, events, relationships, lore.
- For entities ALREADY in the lorebook: suggest an updated entry ONLY if genuinely new information was revealed in chat.
- For NEW entities not yet in the lorebook: create a new entry.
- If nothing meaningful is new — return empty entries array.

CRITICAL RULE FOR UPDATES:
When writing "content" for an "update" action, you MUST:
1. Start with the COMPLETE EXISTING CONTENT of that entry (provided below as FULL CONTENT).
2. APPEND or INTEGRATE the new information from chat into it.
3. NEVER delete, shorten, or omit any existing information.
4. The updated content must be a SUPERSET of the original — always longer or equal, never shorter.
5. Only add genuinely NEW facts that appeared in the recent chat.

Respond ONLY with this exact JSON (no markdown, no extra text):
{
  "entries": [
    {
      "action": "create",
      "comment": "Entry title",
      "content": "Full lorebook entry text.",
      "keys": ["keyword1", "keyword2"],
      "reason": "Why this entry is being created"
    },
    {
      "action": "update",
      "uid": 42,
      "comment": "Existing entry title",
      "content": "FULL original content + new info merged in. Must preserve ALL existing text.",
      "keys": ["keyword1", "keyword2"],
      "reason": "What specific new info was added from the recent chat"
    }
  ]
}

Rules:
- Write entry content in third person, present tense, concise but complete.
- 2-4 trigger keywords per entry.
- For "update" you MUST include the uid of the existing entry.
- Never duplicate existing entries unless genuinely updating them.
- If unsure whether to update — skip it. Only update when new facts are clearly present in chat.`,
  };

  let scanning    = false;
  let autoCounter = 0;
  let previewData = [];
  let snapBooks   = {};
  let collapsed   = true;

  function ctx() { return SillyTavern.getContext(); }

  /**
   * Returns fetch headers including the CSRF token required by SillyTavern.
   * Tries multiple sources in order of preference.
   */
  function getHeaders() {
    // 1) ctx().getRequestHeaders() — available in newer ST builds
    try {
      const c = ctx();
      if (typeof c.getRequestHeaders === 'function') return c.getRequestHeaders();
    } catch { /* */ }

    // 2) Global getRequestHeaders (exported by script.js into window in some builds)
    if (typeof window.getRequestHeaders === 'function') {
      try { return window.getRequestHeaders(); } catch { /* */ }
    }

    // 3) Read CSRF token from <meta name="csrf-token"> (injected by ST server)
    const metaToken = document.querySelector('meta[name="csrf-token"]')?.content;
    if (metaToken) {
      return { 'Content-Type': 'application/json', 'X-CSRF-Token': metaToken };
    }

    // 4) Read from cookie _csrf (non-httpOnly fallback)
    const cookieMatch = document.cookie.match(/(?:^|;\s*)_csrf=([^;]*)/);
    if (cookieMatch) {
      return { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(cookieMatch[1]) };
    }

    // 5) Last resort — no token (will likely still get CSRF error, but worth a try)
    console.warn('[LAU] Could not find CSRF token — requests may fail.');
    return { 'Content-Type': 'application/json' };
  }

  function getSettings() {
    const ext = ctx().extensionSettings;
    if (!ext[EXT_KEY]) ext[EXT_KEY] = { ...DEFAULTS, selectedBooks: [] };
    const s = ext[EXT_KEY];
    Object.entries(DEFAULTS).forEach(([k,v]) => { if (s[k]===undefined) s[k]=v; });
    return s;
  }

  function save() { ctx().saveSettingsDebounced(); }

  // ─── World Info: server-first approach ───────────────────────────────────

  async function serverGetNames() {
    // 1) /api/worldinfo/all
    try {
      const r = await fetch('/api/worldinfo/all', {
        method:'POST', headers: getHeaders(), body:'{}',
      });
      if (r.ok) {
        const d = await r.json();
        const arr = Array.isArray(d) ? d : (d?.entries || d?.names || d?.worlds);
        if (Array.isArray(arr) && arr.length && typeof arr[0]==='string') {
          console.log('[LAU] Names via /api/worldinfo/all:', arr.length); return arr;
        }
      }
    } catch(e) { console.warn('[LAU] /api/worldinfo/all failed:', e.message); }

    // 2) /getsettings — world_names is in the response
    try {
      const r = await fetch('/getsettings', {
        method:'POST', headers: getHeaders(), body:'{}',
      });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d?.world_names) && d.world_names.length) {
          console.log('[LAU] Names via /getsettings:', d.world_names.length); return d.world_names;
        }
      }
    } catch(e) { console.warn('[LAU] /getsettings failed:', e.message); }

    // 3) Dynamic import of world-info.js
    for (const p of ['../../../../world-info.js','../../../world-info.js','/scripts/world-info.js']) {
      try {
        const m = await import(p);
        if (Array.isArray(m?.world_names) && m.world_names.length) {
          console.log('[LAU] Names via import', p, ':', m.world_names.length); return [...m.world_names];
        }
      } catch { /* */ }
    }

    // 4) Context
    try {
      const c = ctx();
      if (Array.isArray(c.world_names) && c.world_names.length) return c.world_names;
      for (const key of ['worldInfoData','worldInfo','world_info']) {
        const o = c[key];
        if (o && typeof o==='object' && !Array.isArray(o)) {
          const keys = Object.keys(o).filter(k => typeof o[k]==='object');
          if (keys.length) { console.log('[LAU] Names via ctx.'+key); return keys; }
        }
      }
    } catch { /* */ }

    console.error('[LAU] Could not get book names from any source!');
    return [];
  }

  async function serverGetBook(name) {
    // 1) /api/worldinfo/get
    try {
      const r = await fetch('/api/worldinfo/get', {
        method:'POST', headers: getHeaders(),
        body: JSON.stringify({name}),
      });
      if (r.ok) {
        const d = await r.json();
        if (d?.entries) { console.log('[LAU] Book via /api/worldinfo/get:', name); return d; }
      }
    } catch(e) { console.warn('[LAU] /api/worldinfo/get failed:', e.message); }

    // 2) /getworldinfo
    try {
      const r = await fetch('/getworldinfo', {
        method:'POST', headers: getHeaders(),
        body: JSON.stringify({name}),
      });
      if (r.ok) {
        const d = await r.json();
        if (d?.entries) { console.log('[LAU] Book via /getworldinfo:', name); return d; }
      }
    } catch(e) { console.warn('[LAU] /getworldinfo failed:', e.message); }

    // 3) Dynamic import
    for (const p of ['../../../../world-info.js','../../../world-info.js','/scripts/world-info.js']) {
      try {
        const m = await import(p);
        if (m?.world_info?.[name]) { console.log('[LAU] Book via import:', name); return m.world_info[name]; }
      } catch { /* */ }
    }

    // 4) Context
    try {
      const c = ctx();
      for (const key of ['worldInfoData','worldInfo','world_info']) {
        if (c[key]?.[name]) { console.log('[LAU] Book via ctx.'+key); return c[key][name]; }
      }
    } catch { /* */ }

    console.error('[LAU] Could not load book:', name);
    return null;
  }

  // ─── AI generation ────────────────────────────────────────────────────────

  function extractText(d) {
    if (d?.choices?.[0]?.message?.content!=null) return d.choices[0].message.content;
    if (d?.choices?.[0]?.text!=null) return d.choices[0].text;
    if (typeof d?.response==='string') return d.response;
    if (Array.isArray(d?.content)) { const t=d.content.find(b=>b.type==='text'); return t?.text??null; }
    if (typeof d?.content==='string') return d.content;
    return null;
  }

  async function aiGenerate(fullPrompt) {
    const c = ctx();
    if (typeof c.generateRaw==='function') {
      try { const r=await c.generateRaw(fullPrompt,'',false,false,'','normal'); if(r?.trim()) return r; }
      catch(e) { console.warn('[LAU] generateRaw:', e.message); }
    }
    if (typeof c.generateQuietPrompt==='function') {
      try { const r=await c.generateQuietPrompt(fullPrompt,false,false); if(r?.trim()) return r; }
      catch(e) { console.warn('[LAU] generateQuietPrompt:', e.message); }
    }
    for (const {url,body} of [
      {url:'/api/backends/chat-completions/generate', body:{messages:[{role:'user',content:fullPrompt}],stream:false}},
      {url:'/api/generate', body:{prompt:fullPrompt,max_new_tokens:2000,stream:false}},
    ]) {
      try {
        const r=await fetch(url,{method:'POST',headers: getHeaders(),body:JSON.stringify(body)});
        if (!r.ok) continue;
        const t=extractText(await r.json());
        if (t?.trim()) return t;
      } catch { /* */ }
    }
    throw new Error('No active AI connection. Set one up in SillyTavern first.');
  }

  // ─── Core scan ────────────────────────────────────────────────────────────

  async function runScan() {
    if (scanning) return;
    scanning = true;
    setScanBtn(false);
    resetStats();
    setScanInfo('','');

    try {
      const s = getSettings();

      if (!s.selectedBooks.length) {
        setScanInfo('⚠️ No lorebooks selected — tap them in the list above.','warn'); return;
      }

      setScanInfo('📂 Loading lorebook data from server…','info');
      const books = {};
      const failed = [];
      for (const name of s.selectedBooks) {
        const data = await serverGetBook(name);
        if (data) books[name] = data;
        else failed.push(name);
      }

      const bookCount    = Object.keys(books).length;
      const totalEntries = Object.values(books)
        .reduce((n,b) => n + Object.keys(b.entries||{}).length, 0);

      if (!bookCount) {
        setScanInfo('❌ Could not load lorebook data. Check browser console (F12) for details.','err');
        return;
      }

      if (failed.length) setScanInfo(`⚠️ Loaded ${bookCount} book(s). Failed: ${failed.join(', ')}`, 'warn');

      const c    = ctx();
      const chat = c.chat || [];
      const count = Math.max(1, s.messageScanCount);
      const msgs = chat
        .slice(-count)
        .filter(m => m && m.mes && !m.is_system)
        .map(m => `${m.is_user?(c.name1||'User'):(m.name||c.name2||'AI')}: ${m.mes}`);

      if (!msgs.length) { setScanInfo('⚠️ No chat messages found yet.','warn'); return; }

      // Show stats
      setStats({books:bookCount, entries:totalEntries, msgs:msgs.length, suggested:null});
      setScanInfo(`🤖 Asking AI… (${bookCount} book, ${totalEntries} entries, ${msgs.length} msgs)`,'info');

      // Build prompt
      const existing = buildExistingSummary(books);
      const fullPrompt = `${s.prompt}

=== EXISTING LOREBOOK ENTRIES ===
${existing}

=== RECENT CHAT (last ${msgs.length} messages) ===
${msgs.join('\n\n')}

Based on the chat above, suggest lorebook actions. Respond with JSON only.`;

      const raw = await aiGenerate(fullPrompt);
      if (!raw?.trim()) { setScanInfo('⚠️ AI returned empty response.','warn'); return; }

      const entries = parseResponse(raw, books);
      if (!entries.length) { setScanInfo('ℹ️ AI found nothing new to add or update.','info'); return; }

      previewData = entries;
      snapBooks   = books;
      renderMemoryPanel();

      const cn=entries.filter(e=>e.action==='create').length;
      const un=entries.filter(e=>e.action==='update').length;
      const sn=entries.filter(e=>e.action==='skip').length;

      setStats({books:bookCount, entries:totalEntries, msgs:msgs.length, suggested:entries.length});
      setScanInfo(`✅ ${cn} new · ${un} updated · ${sn} skipped — see preview below.`,'ok');
      updateReopenBtn();
      openPopup();

    } catch(err) {
      setScanInfo('❌ '+err.message,'err');
      console.error('[LAU]', err);
    } finally {
      scanning = false;
      setScanBtn(true);
    }
  }

  function buildExistingSummary(books) {
    const lines = [];
    for (const [name,data] of Object.entries(books)) {
      const entries = Object.values(data?.entries||{});
      lines.push(`[Lorebook: "${name}" — ${entries.length} entries]`);
      entries.forEach(e => {
        const keys = (e.key||[]).join(', ');
        lines.push(`  uid:${e.uid} | "${e.comment||''}" | keys:[${keys}]`);
        if (e.content) lines.push(`  FULL CONTENT:\n${e.content}\n  --- END OF ENTRY ---`);
      });
    }
    return lines.join('\n')||'(no entries)';
  }

  function parseResponse(raw, books) {
    let text = raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```\s*$/i,'');
    let parsed;
    try { parsed=JSON.parse(text); }
    catch {
      const m=text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('AI did not return valid JSON. Got: '+text.slice(0,300));
      parsed=JSON.parse(m[0]);
    }
    const arr = parsed.entries||parsed;
    if (!Array.isArray(arr)) throw new Error('AI response has no "entries" array.');
    const uidBook={};
    Object.entries(books).forEach(([name,data]) => {
      Object.values(data?.entries||{}).forEach(e=>{uidBook[e.uid]=name;});
    });
    const s=getSettings();
    return arr.map((e,i)=>({
      _id:`lau_${Date.now()}_${i}`,
      action:e.action||'create', uid:e.uid??null,
      comment:e.comment||`Entry ${i+1}`, content:e.content||'',
      keys:Array.isArray(e.keys)?e.keys:[], secondary_keys:[],
      order:e.order??100, reason:e.reason||'',
      targetBook:(e.uid!=null&&uidBook[e.uid])?uidBook[e.uid]:(s.selectedBooks[0]||''),
      applied:false,
    }));
  }

  // ─── Auto-scan ────────────────────────────────────────────────────────────

  function onMessage() {
    const s=getSettings();
    if (!s.autoEnabled) return;
    autoCounter++;
    if (autoCounter>=s.autoInterval) { autoCounter=0; runScan(); }
  }

  // ─── Mount UI ─────────────────────────────────────────────────────────────

  function mountUI() {
    if ($('#lau-block').length) return;
    const $ext = $('#extensions_settings2, #extensions_settings').first();
    if (!$ext.length) { console.error('[LAU] #extensions_settings not found'); return; }

    $ext.append(`
<div class="lau-block" id="lau-block">

  <div class="lau-hdr" id="lau-hdr">
    <span>📖</span>
    <span class="lau-hdr-title">Lorebook Auto-Updater</span>
    <span id="lau-chev" class="lau-hdr-chev">▾</span>
  </div>

  <div class="lau-body" id="lau-body">

    <!-- Books + Scan side-by-side -->
    <div class="lau-main-row">

      <!-- Left: lorebook checkboxes -->
      <div class="lau-col-books">
        <div class="lau-sec-label">📚 Lorebooks</div>
        <div id="lau-books-list" class="lau-books-list">
          <div class="lau-books-msg">Loading…</div>
        </div>
        <div class="lau-book-btns">
          <button class="lau-btn lau-btn-xs" id="lau-refresh">🔄</button>
          <button class="lau-btn lau-btn-xs" id="lau-all">All</button>
          <button class="lau-btn lau-btn-xs" id="lau-none">None</button>
        </div>
      </div>

      <!-- Right: scan controls + stats -->
      <div class="lau-col-scan">
        <div class="lau-sec-label">🚀 Scan</div>
        <div class="lau-scan-msg-row">
          <span class="lau-scan-lbl">Last</span>
          <input type="number" class="lau-num-input" id="lau-count" min="1" max="500"/>
          <span class="lau-scan-lbl">msgs</span>
        </div>
        <button class="lau-btn lau-btn-primary lau-scan-big" id="lau-scan-btn">🔍 Scan</button>

        <div class="lau-stats-box" id="lau-stats-box">
          <div class="lau-srow" id="lau-s-books">📚 —</div>
          <div class="lau-srow" id="lau-s-entries">📝 —</div>
          <div class="lau-srow" id="lau-s-msgs">💬 —</div>
          <div class="lau-srow lau-s-highlight" id="lau-s-suggested">✨ —</div>
        </div>
        <div class="lau-scan-info" id="lau-scan-info"></div>
      </div>

    </div>

    <!-- Memory panel -->
    <div class="lau-settings-toggle" id="lau-memory-hdr">
      🧠 Memory <span id="lau-memory-count" style="color:#60a5fa;font-size:0.9em"></span> <span id="lau-memory-chev">▾</span>
    </div>
    <div id="lau-memory-body" style="display:none;padding:4px 0 6px 0">
      <div id="lau-memory-list" style="font-size:0.75em;color:#64748b;padding:4px 2px;max-height:140px;overflow-y:auto;line-height:1.7">
        <em>No data in memory yet. Run a scan first.</em>
      </div>
      <div class="lau-btn-row" style="margin-top:4px">
        <button class="lau-btn lau-btn-xs" id="lau-memory-reload">🔄 Reload into memory</button>
        <button class="lau-btn lau-btn-xs" id="lau-memory-clear" style="color:#f87171">🗑 Clear</button>
      </div>
    </div>

    <!-- Settings toggle -->
    <div class="lau-settings-toggle" id="lau-settings-hdr">
      ⚙️ Settings <span id="lau-settings-chev">▾</span>
    </div>
    <div id="lau-settings-body" style="display:none;padding:8px 0;display:none">
      <div class="lau-check-row" style="margin-bottom:6px">
        <input type="checkbox" id="lau-auto"/>
        <label for="lau-auto">Auto-scan every</label>
        <input type="number" class="lau-num-input" id="lau-interval" min="1" max="200" style="width:52px"/>
        <label>messages</label>
      </div>
      <div class="lau-sec-label">🤖 AI Prompt</div>
      <textarea class="lau-prompt-area" id="lau-prompt"></textarea>
      <div class="lau-btn-row" style="margin-top:5px">
        <button class="lau-btn lau-btn-xs" id="lau-reset-prompt">↩️ Reset</button>
      </div>
    </div>

  </div>
</div>`);

    const s=getSettings();
    $('#lau-count').val(s.messageScanCount);
    $('#lau-interval').val(s.autoInterval);
    $('#lau-auto').prop('checked',!!s.autoEnabled);
    $('#lau-prompt').val(s.prompt);
    if (collapsed) $('#lau-body').hide();

    populateBookList();
    wireUI();
    resetStats();
  }

  async function populateBookList() {
    const $list = $('#lau-books-list');
    $list.html('<div class="lau-books-msg">🔄 Loading…</div>');

    const names = await serverGetNames();
    const s = getSettings();
    $list.empty();

    if (!names.length) {
      $list.html('<div class="lau-books-msg lau-books-err">No lorebooks found.<br><small>Check console F12</small></div>');
      return;
    }

    names.forEach(name => {
      const on = s.selectedBooks.includes(name);
      const $r = $(`<div class="lau-book-row${on?' lau-on':''}" data-n="${esc(name)}">
        <span class="lau-ck">${on?'☑':'☐'}</span>
        <span class="lau-bname">${esc(name)}</span>
      </div>`);
      $r.on('click', function() {
        const n=String($(this).data('n'));
        const sl=getSettings().selectedBooks;
        const i=sl.indexOf(n);
        if (i===-1) { sl.push(n); $(this).addClass('lau-on').find('.lau-ck').text('☑'); }
        else        { sl.splice(i,1); $(this).removeClass('lau-on').find('.lau-ck').text('☐'); }
        save();
      });
      $list.append($r);
    });
  }

  function wireUI() {
    let _db={};
    const deb=(k,fn,ms=380)=>{clearTimeout(_db[k]);_db[k]=setTimeout(fn,ms);};

    $('#lau-hdr').on('click',()=>{
      collapsed=!collapsed;
      $('#lau-body').slideToggle(180);
      $('#lau-chev').text(collapsed?'▾':'▴');
    });

    let settingsOpen=false;
    $('#lau-settings-hdr').on('click',()=>{
      settingsOpen=!settingsOpen;
      $('#lau-settings-body').slideToggle(160);
      $('#lau-settings-chev').text(settingsOpen?'▴':'▾');
    });

    $('#lau-refresh').on('click', ()=>populateBookList());
    $('#lau-all').on('click', async()=>{
      const names=await serverGetNames();
      getSettings().selectedBooks=[...names]; save();
      $('#lau-books-list .lau-book-row').addClass('lau-on').find('.lau-ck').text('☑');
    });
    $('#lau-none').on('click',()=>{
      getSettings().selectedBooks=[]; save();
      $('#lau-books-list .lau-book-row').removeClass('lau-on').find('.lau-ck').text('☐');
    });

    $('#lau-count').on('input',function(){deb('c',()=>{getSettings().messageScanCount=parseInt(this.value)||20;save();});});
    $('#lau-auto').on('change',function(){getSettings().autoEnabled=this.checked;autoCounter=0;save();});
    $('#lau-interval').on('input',function(){deb('i',()=>{getSettings().autoInterval=parseInt(this.value)||5;autoCounter=0;save();});});
    $('#lau-prompt').on('input',function(){deb('p',()=>{getSettings().prompt=this.value||DEFAULTS.prompt;save();});});
    $('#lau-reset-prompt').on('click',()=>{getSettings().prompt=DEFAULTS.prompt;$('#lau-prompt').val(DEFAULTS.prompt);save();});

    // Memory panel
    let memOpen=false;
    $('#lau-memory-hdr').on('click',()=>{
      memOpen=!memOpen;
      $('#lau-memory-body').slideToggle(160);
      $('#lau-memory-chev').text(memOpen?'▴':'▾');
      if(memOpen) renderMemoryPanel();
    });
    $('#lau-memory-reload').on('click', async()=>{
      const s=getSettings();
      if(!s.selectedBooks.length){alert('Select lorebooks first.');return;}
      const $btn=$('#lau-memory-reload').text('Loading…').prop('disabled',true);
      snapBooks={};
      for(const name of s.selectedBooks){
        const data=await serverGetBook(name);
        if(data) snapBooks[name]=data;
      }
      renderMemoryPanel();
      $btn.text('🔄 Reload into memory').prop('disabled',false);
    });
    $('#lau-memory-clear').on('click',()=>{
      snapBooks={};previewData=[];
      renderMemoryPanel();updateReopenBtn();
      $('#lau-memory-count').text('');
    });
    $('#lau-scan-btn').on('click',()=>{if(!scanning)runScan();});
  }

  // ─── Scan UI helpers ──────────────────────────────────────────────────────

  function setScanBtn(enabled) {
    $('#lau-scan-btn').prop('disabled',!enabled).text(enabled?'🔍 Scan':'⏳ Scanning…');
  }

  function setScanInfo(msg, type) {
    const colors={info:'#94a3b8',warn:'#f59e0b',err:'#f87171',ok:'#4ade80'};
    $('#lau-scan-info').css('color',colors[type]||'#94a3b8').text(msg);
  }

  function resetStats() {
    $('#lau-s-books').text('📚 —');
    $('#lau-s-entries').text('📝 —');
    $('#lau-s-msgs').text('💬 —');
    $('#lau-s-suggested').text('✨ —').removeClass('lau-s-highlight-on');
  }

  function setStats(d) {
    if (d.books    !=null) $('#lau-s-books').text(`📚 ${d.books} book(s) loaded`);
    if (d.entries  !=null) $('#lau-s-entries').text(`📝 ${d.entries} existing entries`);
    if (d.msgs     !=null) $('#lau-s-msgs').text(`💬 ${d.msgs} messages scanned`);
    if (d.suggested!=null) {
      $('#lau-s-suggested').text(`✨ ${d.suggested} AI suggestion(s)`).addClass('lau-s-highlight-on');
    }
  }

  // ─── Memory panel renderer ───────────────────────────────────────────────
  function renderMemoryPanel() {
    const books = Object.entries(snapBooks);
    const $list = $('#lau-memory-list');
    if (!books.length) {
      $list.html('<em style="color:#64748b">No data in memory yet. Run a scan or click Reload.</em>');
      $('#lau-memory-count').text('');
      return;
    }
    let totalEntries = 0;
    const lines = [];
    books.forEach(([name, data]) => {
      const entries = Object.values(data?.entries || {});
      totalEntries += entries.length;
      lines.push(`<div style="margin-bottom:5px"><span style="color:#93c5fd;font-weight:bold">📚 ${esc(name)}</span> <span style="color:#475569">(${entries.length} entries)</span></div>`);
      entries.forEach(e => {
        const keys = (e.key||[]).slice(0,3).join(', ');
        lines.push(`<div style="padding-left:10px;color:#64748b">uid:${e.uid} · <span style="color:#cbd5e1">${esc(e.comment||'—')}</span>${keys?' <span style="color:#475569">['+esc(keys)+']</span>':''}</div>`);
      });
    });
    $list.html(lines.join(''));
    $('#lau-memory-count').text(`(${books.length} book${books.length!==1?'s':''}, ${totalEntries} entries)`);
  }

  // ─── Reopen button ───────────────────────────────────────────────────────
  function updateReopenBtn() {
    const has = previewData.length > 0;
    let $btn = $('#lau-reopen-btn');
    if (!has) { $btn.remove(); return; }
    const unapplied = previewData.filter(e => !e.applied && e.action !== 'skip').length;
    const label = unapplied > 0
      ? `📋 Show last results (${unapplied} pending)`
      : `📋 Show last results`;
    if (!$btn.length) {
      $btn = $(`<button class="lau-btn lau-btn-xs" id="lau-reopen-btn" style="width:100%;margin-top:4px"></button>`);
      $btn.on('click', () => openPopup());
      $('#lau-scan-info').before($btn);
    }
    $btn.text(label);
  }

  // ─── Preview popup ────────────────────────────────────────────────────────

  function openPopup() {
    $('#lau-overlay').remove();
    const bookOptHtml = Object.keys(snapBooks).map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');
    const cn=previewData.filter(e=>e.action==='create').length;
    const un=previewData.filter(e=>e.action==='update').length;
    const sn=previewData.filter(e=>e.action==='skip').length;

    $('body').append(`
<div id="lau-overlay">
  <div id="lau-popup">
    <div class="lau-pop-hdr">
      <div class="lau-pop-title">📖 Preview — Lorebook Suggestions</div>
      <div class="lau-pop-hdr-right">
        <button class="lau-btn lau-btn-xs" id="lau-expand-all">Expand all</button>
        <button class="lau-btn lau-btn-xs" id="lau-collapse-all">Collapse all</button>
        <button class="lau-close-x" id="lau-close-pop">✕</button>
      </div>
    </div>
    <div class="lau-tabs" id="lau-pop-tabs">
      <div class="lau-tab active" data-f="all">All (${previewData.length})</div>
      <div class="lau-tab" data-f="create">🟢 New (${cn})</div>
      <div class="lau-tab" data-f="update">🔵 Updated (${un})</div>
      <div class="lau-tab" data-f="skip">⚫ Skipped (${sn})</div>
    </div>
    <div class="lau-stats">
      <div class="lau-stat"><b class="g">${cn}</b> new</div>
      <div class="lau-stat"><b class="b">${un}</b> updated</div>
      <div class="lau-stat"><b class="gr">${sn}</b> skipped</div>
      <div class="lau-stat"><b>${previewData.length}</b> total</div>
    </div>
    <div class="lau-sort-bar">Sort: <select id="lau-sort"><option value="action">Action type</option><option value="name">Name A–Z</option></select></div>
    <div id="lau-list"></div>
    <div class="lau-pop-foot">
      <div class="lau-foot-info">Review, edit, then apply.</div>
      <div class="lau-foot-right">
        <button class="lau-btn" id="lau-discard">✕ Discard</button>
        <button class="lau-btn lau-apply-btn" id="lau-apply-all">✅ Apply all</button>
      </div>
    </div>
  </div>
</div>`);

    renderCards('all', bookOptHtml);
    wirePopup(bookOptHtml);
  }

  function renderCards(filter, bookOptHtml) {
    const $list=$('#lau-list').empty();
    const items=filter==='all'?previewData:previewData.filter(e=>e.action===filter);
    if (!items.length){$list.html('<div class="lau-empty">Nothing here.</div>');return;}
    items.forEach(e=>$list.append(buildCard(e,bookOptHtml)));
    enableDrag($list[0]);
  }

  function buildCard(entry, bookOptHtml) {
    const badge=entry.applied?'done':entry.action;
    const bLabel=entry.applied?'✅ applied':entry.action;
    const cClass=`c-${entry.applied?'done':entry.action}`;
    const bOpts=bookOptHtml.replace(`value="${esc(entry.targetBook)}"`,`value="${esc(entry.targetBook)}" selected`);
    return $(`
<div class="lau-card ${cClass}" data-id="${entry._id}" draggable="true">
  <div class="lau-card-hdr">
    <span class="lau-drag-h">⠿</span>
    <span class="lau-badge b-${badge}">${bLabel}</span>
    <span class="lau-card-name">${esc(entry.comment)}</span>
    <span class="lau-card-keys">${esc(entry.keys.slice(0,3).join(', ')||'—')}</span>
    <span class="lau-chevron">▼</span>
  </div>
  <div class="lau-card-body">
    <div class="lau-f-group"><div class="lau-f-label">Entry title</div><input class="lau-f-input f-comment" type="text" value="${esc(entry.comment)}"/></div>
    <div class="lau-f-group"><div class="lau-f-label">Content</div><textarea class="lau-f-textarea f-content">${esc(entry.content)}</textarea></div>
    <div class="lau-f-row">
      <div class="lau-f-group"><div class="lau-f-label">Primary keywords</div><input class="lau-f-input f-keys" type="text" value="${esc(entry.keys.join(', '))}"/></div>
      <div class="lau-f-group"><div class="lau-f-label">Secondary keywords</div><input class="lau-f-input f-seckeys" type="text" value="${esc(entry.secondary_keys.join(', '))}"/></div>
      <div class="lau-f-group" style="max-width:80px"><div class="lau-f-label">Order</div><input class="lau-f-input f-order" type="number" value="${entry.order}"/></div>
    </div>
    <div class="lau-f-row">
      <div class="lau-f-group"><div class="lau-f-label">Target lorebook</div><select class="lau-f-select f-book">${bOpts}</select></div>
      <div class="lau-f-group" style="max-width:110px"><div class="lau-f-label">Action</div><select class="lau-f-select f-action"><option value="create" ${entry.action==='create'?'selected':''}>create</option><option value="update" ${entry.action==='update'?'selected':''}>update</option><option value="skip" ${entry.action==='skip'?'selected':''}>skip</option></select></div>
    </div>
    ${entry.reason?`<div class="lau-reason">💬 ${esc(entry.reason)}</div>`:''}
  </div>
  <div class="lau-card-foot">
    <button class="lau-xs lau-apply-one" data-id="${entry._id}">Apply this</button>
    <button class="lau-xs del lau-del" data-id="${entry._id}">Remove</button>
  </div>
</div>`);
  }

  function wirePopup(bookOptHtml) {
    let af='all';
    $(document).on('click.lau','#lau-close-pop,#lau-discard',closePopup);
    $('#lau-overlay').on('click',e=>{if(e.target.id==='lau-overlay')closePopup();});
    $(document).on('click.lau','.lau-tab',function(){
      $('.lau-tab').removeClass('active');$(this).addClass('active');
      af=$(this).data('f');syncToData();renderCards(af,bookOptHtml);
    });
    $(document).on('click.lau','.lau-card-hdr',function(){$(this).closest('.lau-card').toggleClass('open');});
    $(document).on('click.lau','#lau-expand-all',()=>$('#lau-list .lau-card').addClass('open'));
    $(document).on('click.lau','#lau-collapse-all',()=>$('#lau-list .lau-card').removeClass('open'));
    $(document).on('change.lau','#lau-sort',function(){
      syncToData();
      if(this.value==='name') previewData.sort((a,b)=>a.comment.localeCompare(b.comment));
      else {const o={create:0,update:1,skip:2};previewData.sort((a,b)=>(o[a.action]||0)-(o[b.action]||0));}
      renderCards(af,bookOptHtml);
    });
    $(document).on('click.lau','.lau-del',function(){
      const id=$(this).data('id'),i=previewData.findIndex(e=>e._id===id);
      if(i!==-1)previewData.splice(i,1);
      $(`#lau-list .lau-card[data-id="${id}"]`).remove();
      updateTabCounts();
    });
    $(document).on('click.lau','.lau-apply-one',async function(){
      syncToData();
      const id=$(this).data('id'),entry=previewData.find(e=>e._id===id);
      if(!entry)return;
      const $b=$(this).text('Saving…').prop('disabled',true);
      try{await saveEntry(entry);entry.applied=true;$b.text('✅ Saved');$(`#lau-list .lau-card[data-id="${id}"]`).removeClass('c-new c-update c-skip').addClass('c-done');}
      catch(err){$b.text('❌ Error').prop('disabled',false);alert('Error: '+err.message);}
    });
    $(document).on('click.lau','#lau-apply-all',async function(){
      syncToData();
      const toApply=previewData.filter(e=>e.action!=='skip'&&!e.applied);
      if(!toApply.length){alert('Nothing to apply.');return;}
      const $b=$(this).text('Saving…').prop('disabled',true);
      let ok=0,fail=0;
      for(const e of toApply){try{await saveEntry(e);e.applied=true;ok++;}catch(err){fail++;console.error('[LAU]',e.comment,err);}}
      if(!fail){setScanInfo(`✅ Applied ${ok} entries.`,'ok');closePopup();}
      else{$b.text('Retry').prop('disabled',false);alert(`Applied: ${ok} ✅  Failed: ${fail} ❌`);}
    });
  }

  function syncToData() {
    $('#lau-list .lau-card').each(function(){
      const id=$(this).data('id'),e=previewData.find(x=>x._id===id);
      if(!e)return;
      const g=s=>$(this).find(s).val();
      e.comment=g('.f-comment')||e.comment;e.content=g('.f-content')||e.content;
      e.keys=(g('.f-keys')||'').split(',').map(s=>s.trim()).filter(Boolean);
      e.secondary_keys=(g('.f-seckeys')||'').split(',').map(s=>s.trim()).filter(Boolean);
      e.order=parseInt(g('.f-order'))||100;e.targetBook=g('.f-book')||e.targetBook;e.action=g('.f-action')||e.action;
    });
  }

  function updateTabCounts() {
    $('.lau-tab').each(function(){
      const f=$(this).data('f');
      $(this).text(f==='all'?`All (${previewData.length})`:`${f.charAt(0).toUpperCase()+f.slice(1)} (${previewData.filter(e=>e.action===f).length})`);
    });
  }

  function closePopup(){$(document).off('.lau');$('#lau-overlay').remove();}

  // ─── Save entry ───────────────────────────────────────────────────────────

  async function saveEntry(entry) {
    if(entry.action==='skip')return;
    const bookName=entry.targetBook||getSettings().selectedBooks[0];
    if(!bookName)throw new Error('No target lorebook.');
    const c=ctx();
    let data=snapBooks[bookName];
    if(!data){data=await serverGetBook(bookName);if(data)snapBooks[bookName]=data;}
    if(!data)throw new Error(`Could not load "${bookName}".`);
    if(!data.entries)data.entries={};

    if(entry.action==='update'&&entry.uid!=null&&data.entries[entry.uid]){
      const ex=data.entries[entry.uid];
      ex.key=entry.keys;ex.comment=entry.comment;ex.content=entry.content;ex.order=entry.order;
      if(entry.secondary_keys.length)ex.secondary_key=entry.secondary_keys;
    } else {
      let ne;
      if(typeof c.createWorldInfoEntry==='function') ne=c.createWorldInfoEntry(bookName,data);
      if(!ne){
        const uids=Object.keys(data.entries).map(Number).filter(n=>!isNaN(n));
        const uid=uids.length?Math.max(...uids)+1:0;
        ne={uid,key:[],secondary_key:[],comment:'',content:'',constant:false,selective:false,addMemo:false,order:100,position:0,disable:false,depth:4,role:0};
        data.entries[uid]=ne;
      }
      ne.key=entry.keys;ne.comment=entry.comment;ne.content=entry.content;ne.order=entry.order;ne.addMemo=!!entry.comment;
      if(entry.secondary_keys.length)ne.secondary_key=entry.secondary_keys;
    }

    await c.saveWorldInfo(bookName,data);
    if(typeof c.reloadWorldInfoEditor==='function')c.reloadWorldInfoEditor(bookName,true);
    console.log('[LAU] Saved:',entry.comment,'→',bookName);
  }

  // ─── Drag sort ────────────────────────────────────────────────────────────

  function enableDrag(list) {
    let dragId=null;
    list.querySelectorAll('.lau-card').forEach(card=>{
      card.addEventListener('dragstart',e=>{dragId=card.dataset.id;setTimeout(()=>card.style.opacity='0.45',0);e.dataTransfer.effectAllowed='move';});
      card.addEventListener('dragend',()=>{card.style.opacity='';list.querySelectorAll('.lau-card').forEach(c=>c.style.outline='');});
      card.addEventListener('dragover',e=>{e.preventDefault();list.querySelectorAll('.lau-card').forEach(c=>c.style.outline='');if(card.dataset.id!==dragId)card.style.outline='2px solid #3b82f6';});
      card.addEventListener('drop',e=>{
        e.preventDefault();const toId=card.dataset.id;if(dragId===toId)return;
        const fi=previewData.findIndex(x=>x._id===dragId),ti=previewData.findIndex(x=>x._id===toId);
        if(fi<0||ti<0)return;const[m]=previewData.splice(fi,1);previewData.splice(ti,0,m);
        const $d=$(`#lau-list .lau-card[data-id="${dragId}"]`),$t=$(`#lau-list .lau-card[data-id="${toId}"]`);
        if(fi<ti)$t.after($d);else $t.before($d);
        list.querySelectorAll('.lau-card').forEach(c=>c.style.outline='');
      });
    });
  }

  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  // ─── Boot ─────────────────────────────────────────────────────────────────

  jQuery(function(){
    try {
      const {eventSource,event_types}=ctx();
      eventSource.on(event_types.APP_READY,()=>mountUI());
      eventSource.on(event_types.MESSAGE_RECEIVED,onMessage);
      eventSource.on(event_types.MESSAGE_SENT,onMessage);
      console.log('[Lorebook Auto-Updater v1.1] loaded ✓');
    } catch(e){console.error('[LAU] Boot failed:',e);}
  });

})();
