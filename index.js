/**
 * Lorebook Auto-Updater v2.0
 * SillyTavern Extension — IIFE (no top-level ES imports)
 *
 * Uses ST's native world-info.js via dynamic import():
 *   loadWorldInfo(name)              — loads book from disk, always fresh
 *   createWorldInfoEntry(name, data) — creates entry in data, returns it
 *   saveWorldInfo(name, data, true)  — persists to disk immediately
 */

(() => {
  'use strict';

  const EXT_KEY = 'lau_lorebook_updater';

  // ═══════════════════════════════════════════════════════════════════════════
  // DEFAULTS
  // ═══════════════════════════════════════════════════════════════════════════

  const DEFAULT_PROMPT =
`You are a lorebook maintenance assistant for a roleplay session.

Review the recent chat and the existing lorebook entries shown below.
Decide what should be created, updated, merged, forgotten, or summarized.

AVAILABLE ACTIONS:
  create    — A new entity/fact not yet in the lorebook
  update    — An existing entry needs new information (provide COMPLETE content)
  merge     — Two entries cover the same topic; consolidate them
  forget    — An entry is outdated, disproven, or permanently irrelevant
  summarize — Chronicle a significant scene or event that just happened

CRITICAL RULES:
1. Read every existing entry's snippet before deciding.
2. If the fact is already covered → use "update", never "create".
3. If two entries cover the same topic → use "merge".
4. Prefer FEWER, BROADER entries. One scan rarely needs more than 2–3 operations.
5. Skip minor dialogue, greetings, and restating known facts.
6. For "update": your content REPLACES the entire entry — include ALL existing
   valid facts PLUS the new information. Never drop existing facts.

Respond ONLY with this JSON (no markdown, no extra text):
{
  "operations": [
    {
      "action": "create",
      "comment": "Entry Title",
      "content": "Full entry text, third person, present tense.",
      "keys": ["keyword1", "keyword2"],
      "target_book": "ExactBookName",
      "reason": "Why this is new"
    },
    {
      "action": "update",
      "uid": 42,
      "target_book": "ExactBookName",
      "comment": "Title (can be unchanged)",
      "content": "COMPLETE content: all old facts + new ones.",
      "keys": ["keyword1"],
      "reason": "What changed"
    },
    {
      "action": "merge",
      "keep_uid": 42,
      "remove_uid": 57,
      "target_book": "ExactBookName",
      "comment": "Merged title",
      "content": "Combined content from both entries.",
      "reason": "Why these should be one entry"
    },
    {
      "action": "forget",
      "uid": 33,
      "target_book": "ExactBookName",
      "reason": "Why this is outdated or wrong"
    },
    {
      "action": "summarize",
      "comment": "Scene: Descriptive Title",
      "content": "What happened, past tense, who was involved, what changed.",
      "keys": ["scene"],
      "target_book": "ExactBookName",
      "reason": "Why this scene matters"
    }
  ]
}

If nothing meaningful happened: {"operations": []}`;

  const DEFAULTS = {
    selectedBooks:    [],
    messageScanCount: 20,
    prompt:           DEFAULT_PROMPT,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  let scanning     = false;
  let previewData  = [];   // array of operation objects
  let previewBooks = {};   // { name: bookData } — for popup book dropdown
  let collapsed    = true;
  let activityLog  = [];   // last 10 applied operations

  // ═══════════════════════════════════════════════════════════════════════════
  // ST CONTEXT HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const ext = ctx().extensionSettings;
    if (!ext[EXT_KEY]) ext[EXT_KEY] = { ...DEFAULTS, selectedBooks: [] };
    const s = ext[EXT_KEY];
    if (!Array.isArray(s.selectedBooks))  s.selectedBooks    = [];
    if (!(s.messageScanCount >= 1))       s.messageScanCount = 20;
    if (typeof s.prompt !== 'string')     s.prompt           = DEFAULT_PROMPT;
    return s;
  }

  function save() { ctx().saveSettingsDebounced(); }

  // ═══════════════════════════════════════════════════════════════════════════
  // WORLD-INFO MODULE — dynamic import, cached after first load
  // ═══════════════════════════════════════════════════════════════════════════

  let _wi = null;

  async function getWI() {
    if (_wi) return _wi;
    // /scripts/world-info.js is an absolute path that always resolves correctly
    // from classic scripts (unlike relative paths which resolve from document URL)
    _wi = await import('/scripts/world-info.js');
    if (typeof _wi.loadWorldInfo !== 'function') {
      _wi = null;
      throw new Error('loadWorldInfo not found in world-info.js. Is ST up to date?');
    }
    console.log('[LAU] world-info.js imported ✓');
    return _wi;
  }

  async function wiGetNames() {
    const wi = await getWI();
    return Array.isArray(wi.world_names) ? [...wi.world_names] : [];
  }

  async function wiLoad(name) {
    const wi = await getWI();
    const data = await wi.loadWorldInfo(name);
    return data; // { entries: { [key]: entry } }
  }

  async function wiSave(name, data) {
    const wi = await getWI();
    await wi.saveWorldInfo(name, data, /* immediately */ true);
  }

  // Must call getWI() first — _wi is guaranteed non-null here
  function wiCreate(name, data) {
    return _wi.createWorldInfoEntry(name, data);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AI GENERATION
  // ═══════════════════════════════════════════════════════════════════════════

  function extractText(d) {
    if (d?.choices?.[0]?.message?.content != null) return d.choices[0].message.content;
    if (d?.choices?.[0]?.text            != null) return d.choices[0].text;
    if (typeof d?.response === 'string')           return d.response;
    if (Array.isArray(d?.content)) {
      const t = d.content.find(b => b.type === 'text');
      return t?.text ?? null;
    }
    if (typeof d?.content === 'string') return d.content;
    return null;
  }

  async function aiGenerate(fullPrompt) {
    const c = ctx();

    // 1. generateRaw — uses the active ST connection profile
    if (typeof c.generateRaw === 'function') {
      try {
        const r = await c.generateRaw(fullPrompt, '', false, false, '', 'normal');
        if (r?.trim()) return r.trim();
      } catch (e) { console.warn('[LAU] generateRaw failed:', e.message); }
    }

    // 2. generateQuietPrompt — older ST versions
    if (typeof c.generateQuietPrompt === 'function') {
      try {
        const r = await c.generateQuietPrompt(fullPrompt, false, false);
        if (r?.trim()) return r.trim();
      } catch (e) { console.warn('[LAU] generateQuietPrompt failed:', e.message); }
    }

    // 3. ST proxy endpoints
    for (const { url, body } of [
      { url: '/api/backends/chat-completions/generate',
        body: { messages: [{ role: 'user', content: fullPrompt }], stream: false } },
      { url: '/api/generate',
        body: { prompt: fullPrompt, max_new_tokens: 2000, stream: false } },
    ]) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) continue;
        const t = extractText(await resp.json());
        if (t?.trim()) return t.trim();
      } catch { /* try next */ }
    }

    throw new Error('No active AI connection. Set one up in SillyTavern first.');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROMPT BUILDING
  // ═══════════════════════════════════════════════════════════════════════════

  function buildBookSummary(books) {
    const lines = [];
    for (const [name, data] of Object.entries(books)) {
      const active = Object.values(data?.entries || {}).filter(e => !e.disable);
      lines.push(`\n[Lorebook: "${name}" — ${active.length} active entries]`);
      for (const e of active) {
        const keys    = (e.key || []).slice(0, 5).join(', ') || '—';
        const snippet = (e.content || '').slice(0, 150).replace(/\n/g, ' ').trim();
        const dots    = (e.content?.length || 0) > 150 ? '…' : '';
        lines.push(`  UID ${e.uid} | "${e.comment || '(no title)'}" | keys: [${keys}]`);
        if (snippet) lines.push(`    → ${snippet}${dots}`);
      }
    }
    return lines.join('\n').trim() || '(no entries yet)';
  }

  function buildFullPrompt(customPrompt, bookSummary, msgs, count) {
    return `${customPrompt}

=== EXISTING LOREBOOK ENTRIES ===
${bookSummary}

=== RECENT CHAT (last ${count} messages) ===
${msgs.join('\n\n')}

Return your JSON operations array now.`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCAN
  // ═══════════════════════════════════════════════════════════════════════════

  async function runScan() {
    if (scanning) return;
    scanning = true;
    setScanBtn(false);
    setScanInfo('', '');
    resetStats();

    try {
      const s = getSettings();

      // Guard: need at least one book selected
      if (!s.selectedBooks.length) {
        setScanInfo('⚠️ No lorebooks selected — tap them in the list.', 'warn');
        return;
      }

      // ── Step 1: Load lorebooks from disk ──────────────────────────────────
      setScanInfo('📂 Loading lorebooks…', 'info');

      const books  = {};
      const failed = [];

      for (const name of s.selectedBooks) {
        try {
          const data = await wiLoad(name);
          if (data?.entries) {
            books[name] = data;
            console.log(`[LAU] Loaded "${name}" — ${Object.keys(data.entries).length} entries`);
          } else {
            failed.push(name);
            console.warn('[LAU] No entries in:', name);
          }
        } catch (e) {
          failed.push(name);
          console.warn('[LAU] Could not load:', name, e.message);
        }
      }

      const bookCount    = Object.keys(books).length;
      const totalEntries = Object.values(books)
        .reduce((n, b) => n + Object.values(b.entries).filter(e => !e.disable).length, 0);

      if (!bookCount) {
        setScanInfo('❌ Could not load any lorebook. See console (F12).', 'err');
        return;
      }

      if (failed.length) {
        setScanInfo(`⚠️ Loaded ${bookCount}. Could not load: ${failed.join(', ')}`, 'warn');
      }

      // ── Step 2: Get chat messages ─────────────────────────────────────────
      const c     = ctx();
      const chat  = c.chat || [];
      const count = Math.max(1, s.messageScanCount);

      const msgs = chat
        .slice(-count)
        .filter(m => m?.mes && !m.is_system)
        .map(m => {
          const role = m.is_user ? (c.name1 || 'User') : (m.name || c.name2 || 'AI');
          return `${role}: ${m.mes}`;
        });

      if (!msgs.length) {
        setScanInfo('⚠️ No chat messages to scan yet.', 'warn');
        return;
      }

      setStats({ books: bookCount, entries: totalEntries, msgs: msgs.length, suggested: null });
      setScanInfo(`🤖 Asking AI… (${totalEntries} entries · ${msgs.length} msgs)`, 'info');

      // ── Step 3: Build prompt & call AI ────────────────────────────────────
      const summary    = buildBookSummary(books);
      const fullPrompt = buildFullPrompt(s.prompt, summary, msgs, count);
      const raw        = await aiGenerate(fullPrompt);

      if (!raw) {
        setScanInfo('⚠️ AI returned empty response.', 'warn');
        return;
      }

      // ── Step 4: Parse response ────────────────────────────────────────────
      const ops = parseResponse(raw, books, s);

      if (!ops.length) {
        setScanInfo('ℹ️ AI found nothing to add or update.', 'info');
        setStats({ books: bookCount, entries: totalEntries, msgs: msgs.length, suggested: 0 });
        return;
      }

      previewData  = ops;
      previewBooks = books;

      const counts = countByAction(ops);
      setStats({ books: bookCount, entries: totalEntries, msgs: msgs.length, suggested: ops.length });
      setScanInfo(
        `✅ ${counts.create} new · ${counts.update} updated · ${counts.merge} merged · ` +
        `${counts.forget} forgotten · ${counts.summarize} summarized`,
        'ok'
      );

      openPopup();

    } catch (err) {
      setScanInfo('❌ ' + err.message, 'err');
      console.error('[LAU] Scan error:', err);
    } finally {
      scanning = false;
      setScanBtn(true);
    }
  }

  function countByAction(ops) {
    return ops.reduce((acc, op) => {
      acc[op.action] = (acc[op.action] || 0) + 1;
      return acc;
    }, { create: 0, update: 0, merge: 0, forget: 0, summarize: 0 });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PARSE AI RESPONSE
  // ═══════════════════════════════════════════════════════════════════════════

  const VALID_ACTIONS = new Set(['create', 'update', 'merge', 'forget', 'summarize']);

  function parseResponse(raw, books, s) {
    // Strip markdown fences if present
    const text = raw.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Try to extract the first JSON object from the response
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('AI returned invalid JSON. Got: ' + text.slice(0, 200));
      try { parsed = JSON.parse(m[0]); }
      catch { throw new Error('Could not parse AI response as JSON. Got: ' + text.slice(0, 200)); }
    }

    const arr = parsed.operations || parsed.entries || parsed;
    if (!Array.isArray(arr)) throw new Error('AI response has no "operations" array.');

    // Build uid → bookName map so we can auto-detect target book from uid
    const uidBook = {};
    for (const [name, data] of Object.entries(books)) {
      for (const e of Object.values(data.entries || {})) {
        uidBook[e.uid] = name;
      }
    }

    const defaultBook = s.selectedBooks[0] || '';
    const ops = [];

    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i];
      if (!raw || !VALID_ACTIONS.has(raw.action)) continue;

      let targetBook = raw.target_book || defaultBook;

      const base = {
        _id:        `lau_${Date.now()}_${i}`,
        action:     raw.action,
        reason:     String(raw.reason || ''),
        targetBook,
        applied:    false,
      };

      if (raw.action === 'create' || raw.action === 'summarize') {
        if (!raw.comment?.trim() || !raw.content?.trim()) continue; // skip incomplete
        ops.push({
          ...base,
          comment: String(raw.comment).slice(0, 200),
          content: String(raw.content).slice(0, 5000),
          keys:    Array.isArray(raw.keys) ? raw.keys.map(String).slice(0, 10) : [],
        });

      } else if (raw.action === 'update') {
        if (raw.uid == null) continue;
        const uid = Number(raw.uid);
        if (!isFinite(uid)) continue;
        // Auto-detect book from uid
        if (!raw.target_book && uidBook[uid]) targetBook = uidBook[uid];
        ops.push({
          ...base,
          uid,
          targetBook,
          comment: raw.comment?.trim() ? String(raw.comment).slice(0, 200) : null,
          content: raw.content?.trim() ? String(raw.content).slice(0, 5000) : null,
          keys:    Array.isArray(raw.keys) ? raw.keys.map(String).slice(0, 10) : null,
        });

      } else if (raw.action === 'merge') {
        if (raw.keep_uid == null || raw.remove_uid == null) continue;
        const keepUid   = Number(raw.keep_uid);
        const removeUid = Number(raw.remove_uid);
        if (!isFinite(keepUid) || !isFinite(removeUid) || keepUid === removeUid) continue;
        if (!raw.target_book && uidBook[keepUid]) targetBook = uidBook[keepUid];
        ops.push({
          ...base,
          keepUid,
          removeUid,
          targetBook,
          comment: raw.comment?.trim() ? String(raw.comment).slice(0, 200) : null,
          content: raw.content?.trim() ? String(raw.content).slice(0, 5000) : null,
        });

      } else if (raw.action === 'forget') {
        if (raw.uid == null) continue;
        const uid = Number(raw.uid);
        if (!isFinite(uid)) continue;
        if (!raw.target_book && uidBook[uid]) targetBook = uidBook[uid];
        ops.push({ ...base, uid, targetBook });
      }
    }

    return ops;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPLY OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  function findEntryByUid(entries, uid) {
    for (const e of Object.values(entries)) {
      if (e.uid === uid) return e;
    }
    return null;
  }

  async function applyOp(op) {
    if (!op.targetBook) throw new Error('No target lorebook specified for this operation.');

    // Always reload fresh from disk — avoids stale state between applies
    const data = await wiLoad(op.targetBook);
    if (!data?.entries) throw new Error(`Could not load lorebook "${op.targetBook}".`);

    if (op.action === 'create' || op.action === 'summarize') {
      // createWorldInfoEntry adds entry to data.entries and returns it
      const entry = wiCreate(op.targetBook, data);
      entry.comment   = op.comment;
      entry.content   = op.content;
      entry.key       = op.keys || [];
      entry.disable   = false;
      entry.constant  = false;
      entry.selective = false;
      entry.addMemo   = !!op.comment;
      entry.order     = 100;
      await wiSave(op.targetBook, data);
      logActivity(op.action, op.comment, op.targetBook);
      console.log(`[LAU] Created "${op.comment}" (UID ${entry.uid}) → "${op.targetBook}"`);

    } else if (op.action === 'update') {
      const entry = findEntryByUid(data.entries, op.uid);
      if (!entry) throw new Error(`UID ${op.uid} not found in "${op.targetBook}".`);
      if (op.content != null) entry.content = op.content;
      if (op.comment != null) entry.comment = op.comment;
      if (op.keys    != null) entry.key     = op.keys;
      await wiSave(op.targetBook, data);
      logActivity('update', entry.comment || `UID ${op.uid}`, op.targetBook);
      console.log(`[LAU] Updated UID ${op.uid} "${entry.comment}" → "${op.targetBook}"`);

    } else if (op.action === 'merge') {
      const keepEntry   = findEntryByUid(data.entries, op.keepUid);
      const removeEntry = findEntryByUid(data.entries, op.removeUid);
      if (!keepEntry)   throw new Error(`Keep UID ${op.keepUid} not found in "${op.targetBook}".`);
      if (!removeEntry) throw new Error(`Remove UID ${op.removeUid} not found in "${op.targetBook}".`);

      if (op.content) keepEntry.content = op.content;
      if (op.comment) keepEntry.comment = op.comment;

      // Merge keys (deduplicate, case-insensitive)
      const seen = new Set((keepEntry.key || []).map(k => String(k).toLowerCase()));
      for (const k of (removeEntry.key || [])) {
        const lk = String(k).toLowerCase();
        if (!seen.has(lk)) { seen.add(lk); keepEntry.key = keepEntry.key || []; keepEntry.key.push(k); }
      }

      removeEntry.disable = true; // soft-delete the absorbed entry
      await wiSave(op.targetBook, data);
      logActivity('merge', `UID ${op.keepUid} ← ${op.removeUid}`, op.targetBook);
      console.log(`[LAU] Merged UID ${op.removeUid} into UID ${op.keepUid} "${keepEntry.comment}" → "${op.targetBook}"`);

    } else if (op.action === 'forget') {
      const entry = findEntryByUid(data.entries, op.uid);
      if (!entry) throw new Error(`UID ${op.uid} not found in "${op.targetBook}".`);
      entry.disable = true;
      await wiSave(op.targetBook, data);
      logActivity('forget', entry.comment || `UID ${op.uid}`, op.targetBook);
      console.log(`[LAU] Disabled UID ${op.uid} "${entry.comment}" → "${op.targetBook}"`);
    }

    // Reload the WI editor panel if it's open, so changes are visible
    const c = ctx();
    if (typeof c.reloadWorldInfoEditor === 'function') {
      c.reloadWorldInfoEditor(op.targetBook, true);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIVITY LOG
  // ═══════════════════════════════════════════════════════════════════════════

  const ACTION_ICONS = {
    create: '📝', update: '✏️', merge: '🔗', forget: '🗑️', summarize: '📋',
  };

  function logActivity(action, label, book) {
    activityLog.unshift({
      icon:  ACTION_ICONS[action] || '•',
      label: String(label || '').slice(0, 55),
      book:  String(book  || '').slice(0, 35),
      time:  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    activityLog = activityLog.slice(0, 10);
    renderActivityLog();
  }

  function renderActivityLog() {
    const $log = $('#lau-activity-log');
    if (!$log.length) return;
    if (!activityLog.length) {
      $log.html('<div class="lau-log-empty">No activity yet.</div>');
      return;
    }
    $log.empty();
    for (const e of activityLog) {
      $log.append(`
        <div class="lau-log-row">
          <span class="lau-log-icon">${e.icon}</span>
          <span class="lau-log-label">${esc(e.label)}</span>
          <span class="lau-log-book">${esc(e.book)}</span>
          <span class="lau-log-time">${e.time}</span>
        </div>`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS PANEL
  // ═══════════════════════════════════════════════════════════════════════════

  function mountUI() {
    if ($('#lau-block').length) return;

    const $ext = $('#extensions_settings2, #extensions_settings').first();
    if (!$ext.length) { console.error('[LAU] #extensions_settings not found'); return; }

    $ext.append(`
<div class="lau-block" id="lau-block">

  <div class="lau-hdr" id="lau-hdr">
    <span class="lau-hdr-icon">📖</span>
    <span class="lau-hdr-title">Lorebook Auto-Updater</span>
    <span class="lau-hdr-chev" id="lau-chev">▾</span>
  </div>

  <div class="lau-body" id="lau-body">

    <!-- Books + Scan — two columns -->
    <div class="lau-main-row">

      <div class="lau-col-books">
        <div class="lau-col-hdr">
          <span>📚 Lorebooks</span>
          <span class="lau-sel-count" id="lau-sel-count">none selected</span>
        </div>
        <div class="lau-books-list" id="lau-books-list">
          <div class="lau-msg">🔄 Loading…</div>
        </div>
        <div class="lau-row-btns">
          <button class="lau-btn" id="lau-refresh">🔄 Refresh</button>
          <button class="lau-btn" id="lau-all">All</button>
          <button class="lau-btn" id="lau-none">None</button>
        </div>
      </div>

      <div class="lau-col-scan">
        <div class="lau-col-hdr"><span>🚀 Scan</span></div>
        <div class="lau-msgs-row">
          <span class="lau-lbl">Last</span>
          <input type="number" class="lau-num" id="lau-count" min="1" max="500" />
          <span class="lau-lbl">msgs</span>
        </div>
        <button class="lau-btn lau-btn-primary lau-scan-big" id="lau-scan-btn">🔍 Scan</button>
        <div class="lau-stats-box">
          <div class="lau-srow" id="lau-s-books">📚 —</div>
          <div class="lau-srow" id="lau-s-entries">📝 —</div>
          <div class="lau-srow" id="lau-s-msgs">💬 —</div>
          <div class="lau-srow lau-srow-hi" id="lau-s-suggested">✨ —</div>
        </div>
        <div class="lau-scan-info" id="lau-scan-info"></div>
      </div>

    </div>

    <!-- Activity log -->
    <div class="lau-section-hdr" id="lau-log-hdr">
      📋 Recent activity <span id="lau-log-chev">▾</span>
    </div>
    <div id="lau-activity" style="display:none">
      <div id="lau-activity-log"><div class="lau-log-empty">No activity yet.</div></div>
    </div>

    <!-- Settings -->
    <div class="lau-section-hdr" id="lau-settings-hdr">
      ⚙️ Settings <span id="lau-settings-chev">▾</span>
    </div>
    <div id="lau-settings-body" style="display:none">
      <div class="lau-field">
        <div class="lau-field-label">🤖 AI Prompt</div>
        <textarea class="lau-textarea" id="lau-prompt"></textarea>
        <button class="lau-btn" id="lau-reset-prompt" style="margin-top:5px">↩️ Reset to default</button>
      </div>
    </div>

  </div>
</div>`);

    // Restore saved settings to UI
    const s = getSettings();
    $('#lau-count').val(s.messageScanCount);
    $('#lau-prompt').val(s.prompt);

    if (collapsed) $('#lau-body').hide();

    populateBookList();
    wireUI();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BOOK LIST (checkbox rows — mobile-friendly, no Ctrl required)
  // ═══════════════════════════════════════════════════════════════════════════

  async function populateBookList() {
    const $list = $('#lau-books-list').html('<div class="lau-msg">🔄 Loading…</div>');

    let names;
    try {
      names = await wiGetNames();
    } catch (e) {
      $list.html(`<div class="lau-msg lau-msg-err">❌ ${esc(e.message)}</div>`);
      return;
    }

    const s = getSettings();
    $list.empty();

    if (!names.length) {
      $list.html('<div class="lau-msg lau-msg-warn">⚠️ No lorebooks found in ST.</div>');
      return;
    }

    for (const name of names) {
      const on  = s.selectedBooks.includes(name);
      const $row = $(`<div class="lau-book-row${on ? ' lau-on' : ''}">
        <span class="lau-ck">${on ? '☑' : '☐'}</span>
        <span class="lau-bname">${esc(name)}</span>
      </div>`);
      // Store name directly on DOM node — avoids HTML encoding issues with data attributes
      $row[0]._lauName = name;
      $row.on('click', function () {
        const n  = this._lauName;
        const sl = getSettings().selectedBooks;
        const i  = sl.indexOf(n);
        if (i === -1) { sl.push(n);    $(this).addClass('lau-on').find('.lau-ck').text('☑'); }
        else          { sl.splice(i,1); $(this).removeClass('lau-on').find('.lau-ck').text('☐'); }
        save();
        updateSelCount();
      });
      $list.append($row);
    }

    updateSelCount();
  }

  function updateSelCount() {
    const sel   = getSettings().selectedBooks;
    const total = $('#lau-books-list .lau-book-row').length;
    const $el   = $('#lau-sel-count');
    if (sel.length) {
      $el.text(`${sel.length}/${total}`).css('color', '#4ade80');
    } else {
      $el.text('none selected').css('color', '#f87171');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WIRE UI EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  function wireUI() {
    let _db = {};
    const deb = (k, fn, ms = 400) => { clearTimeout(_db[k]); _db[k] = setTimeout(fn, ms); };

    // Main panel toggle
    $('#lau-hdr').on('click', () => {
      collapsed = !collapsed;
      $('#lau-body').slideToggle(180);
      $('#lau-chev').text(collapsed ? '▾' : '▴');
    });

    // Activity log toggle
    let logOpen = false;
    $('#lau-log-hdr').on('click', () => {
      logOpen = !logOpen;
      $('#lau-activity').slideToggle(150);
      $('#lau-log-chev').text(logOpen ? '▴' : '▾');
      if (logOpen) renderActivityLog();
    });

    // Settings toggle
    let settingsOpen = false;
    $('#lau-settings-hdr').on('click', () => {
      settingsOpen = !settingsOpen;
      $('#lau-settings-body').slideToggle(150);
      $('#lau-settings-chev').text(settingsOpen ? '▴' : '▾');
    });

    // Book list controls
    $('#lau-refresh').on('click', () => populateBookList());
    $('#lau-all').on('click', async () => {
      const names = await wiGetNames();
      getSettings().selectedBooks = [...names];
      save();
      $('#lau-books-list .lau-book-row').addClass('lau-on').find('.lau-ck').text('☑');
      updateSelCount();
    });
    $('#lau-none').on('click', () => {
      getSettings().selectedBooks = [];
      save();
      $('#lau-books-list .lau-book-row').removeClass('lau-on').find('.lau-ck').text('☐');
      updateSelCount();
    });

    // Scan count
    $('#lau-count').on('input', function () {
      deb('cnt', () => { getSettings().messageScanCount = Math.max(1, parseInt(this.value) || 20); save(); });
    });

    // Prompt
    $('#lau-prompt').on('input', function () {
      deb('pmt', () => { getSettings().prompt = this.value.trim() || DEFAULT_PROMPT; save(); });
    });
    $('#lau-reset-prompt').on('click', () => {
      getSettings().prompt = DEFAULT_PROMPT;
      $('#lau-prompt').val(DEFAULT_PROMPT);
      save();
    });

    // Scan button
    $('#lau-scan-btn').on('click', () => { if (!scanning) runScan(); });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCAN PANEL HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function setScanBtn(enabled) {
    $('#lau-scan-btn')
      .prop('disabled', !enabled)
      .text(enabled ? '🔍 Scan' : '⏳ Scanning…');
  }

  function setScanInfo(msg, type) {
    const colors = { info: '#94a3b8', warn: '#f59e0b', err: '#f87171', ok: '#4ade80' };
    $('#lau-scan-info').css('color', colors[type] || '#94a3b8').text(msg);
  }

  function resetStats() {
    $('#lau-s-books').text('📚 —');
    $('#lau-s-entries').text('📝 —');
    $('#lau-s-msgs').text('💬 —');
    $('#lau-s-suggested').text('✨ —').css('color', '');
  }

  function setStats(d) {
    if (d.books     != null) $('#lau-s-books').text(`📚 ${d.books} book(s) loaded`);
    if (d.entries   != null) $('#lau-s-entries').text(`📝 ${d.entries} existing entries`);
    if (d.msgs      != null) $('#lau-s-msgs').text(`💬 ${d.msgs} messages scanned`);
    if (d.suggested != null) {
      $('#lau-s-suggested')
        .text(d.suggested > 0 ? `✨ ${d.suggested} suggestion(s)` : '✨ Nothing to update')
        .css('color', d.suggested > 0 ? '#4ade80' : '#94a3b8');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREVIEW POPUP
  // ═══════════════════════════════════════════════════════════════════════════

  const ACTION_META = {
    create:    { badge: 'new',       bdgCls: 'b-create',    cardCls: 'c-create'    },
    update:    { badge: 'update',    bdgCls: 'b-update',    cardCls: 'c-update'    },
    merge:     { badge: 'merge',     bdgCls: 'b-merge',     cardCls: 'c-merge'     },
    forget:    { badge: 'forget',    bdgCls: 'b-forget',    cardCls: 'c-forget'    },
    summarize: { badge: 'summarize', bdgCls: 'b-summarize', cardCls: 'c-summarize' },
  };

  function openPopup() {
    $('#lau-overlay').remove();

    const counts      = countByAction(previewData);
    const total       = previewData.length;
    const bookNames   = Object.keys(previewBooks);
    const bookOptHtml = bookNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');

    $('body').append(`
<div id="lau-overlay">
  <div id="lau-popup">

    <div class="lau-pop-hdr">
      <span class="lau-pop-title">📖 Preview — ${total} suggestion(s)</span>
      <div class="lau-pop-hdr-r">
        <button class="lau-btn lau-btn-xs" id="lau-expand-all">Expand all</button>
        <button class="lau-btn lau-btn-xs" id="lau-collapse-all">Collapse all</button>
        <button class="lau-pop-close" id="lau-pop-close">✕</button>
      </div>
    </div>

    <div class="lau-pop-tabs">
      <div class="lau-tab active" data-f="all">All (${total})</div>
      <div class="lau-tab" data-f="create">📝 New (${counts.create})</div>
      <div class="lau-tab" data-f="update">✏️ Update (${counts.update})</div>
      <div class="lau-tab" data-f="merge">🔗 Merge (${counts.merge})</div>
      <div class="lau-tab" data-f="forget">🗑️ Forget (${counts.forget})</div>
      <div class="lau-tab" data-f="summarize">📋 Summary (${counts.summarize})</div>
    </div>

    <div id="lau-card-list"></div>

    <div class="lau-pop-foot">
      <span class="lau-foot-hint">Review and edit entries, then apply.</span>
      <div class="lau-foot-btns">
        <button class="lau-btn" id="lau-discard">✕ Discard</button>
        <button class="lau-btn lau-btn-apply" id="lau-apply-all">✅ Apply all</button>
      </div>
    </div>

  </div>
</div>`);

    renderCards('all', bookOptHtml);
    wirePopup(bookOptHtml);
  }

  function renderCards(filter, bookOptHtml) {
    const $list = $('#lau-card-list').empty();
    const items = filter === 'all'
      ? previewData
      : previewData.filter(op => op.action === filter);

    if (!items.length) {
      $list.html('<div class="lau-empty">Nothing in this category.</div>');
      return;
    }
    items.forEach(op => $list.append(buildCard(op, bookOptHtml)));
  }

  function bookSelect(bookOptHtml, selected) {
    return bookOptHtml.replace(`value="${esc(selected)}"`, `value="${esc(selected)}" selected`);
  }

  function buildCard(op, bookOptHtml) {
    const meta      = ACTION_META[op.action] || ACTION_META.create;
    const appliedCls = op.applied ? 'c-applied' : meta.cardCls;
    const badge      = op.applied ? '✅ applied' : meta.badge;
    const bdgCls     = op.applied ? 'b-applied'  : meta.bdgCls;
    const bOpts      = bookSelect(bookOptHtml, op.targetBook);

    // Title line shown in collapsed header
    let headerTitle = '';
    if (op.action === 'update')  headerTitle = `UID ${op.uid}${op.comment ? ' — ' + op.comment : ''}`;
    else if (op.action === 'merge')  headerTitle = `UID ${op.keepUid} ← ${op.removeUid}${op.comment ? ' — ' + op.comment : ''}`;
    else if (op.action === 'forget') headerTitle = `UID ${op.uid}`;
    else headerTitle = op.comment || '';

    // Body fields per action
    let bodyHtml = '';
    if (op.action === 'create' || op.action === 'summarize') {
      bodyHtml = `
        <div class="lau-fg"><div class="lau-fl">Title</div>
          <input class="lau-fi f-comment" type="text" value="${esc(op.comment)}"></div>
        <div class="lau-fg"><div class="lau-fl">Content</div>
          <textarea class="lau-ft f-content">${esc(op.content)}</textarea></div>
        <div class="lau-frow">
          <div class="lau-fg"><div class="lau-fl">Keywords (comma-separated)</div>
            <input class="lau-fi f-keys" type="text" value="${esc((op.keys || []).join(', '))}"></div>
          <div class="lau-fg lau-fg-sm"><div class="lau-fl">Target lorebook</div>
            <select class="lau-fs f-book">${bOpts}</select></div>
        </div>`;

    } else if (op.action === 'update') {
      bodyHtml = `
        <div class="lau-info-pill">Updating UID <b>${op.uid}</b></div>
        <div class="lau-fg"><div class="lau-fl">New title <em>(optional — leave blank to keep)</em></div>
          <input class="lau-fi f-comment" type="text" value="${esc(op.comment || '')}"></div>
        <div class="lau-fg"><div class="lau-fl">Full updated content</div>
          <textarea class="lau-ft f-content">${esc(op.content || '')}</textarea></div>
        <div class="lau-frow">
          <div class="lau-fg"><div class="lau-fl">Keywords</div>
            <input class="lau-fi f-keys" type="text" value="${esc((op.keys || []).join(', '))}"></div>
          <div class="lau-fg lau-fg-sm"><div class="lau-fl">Lorebook</div>
            <select class="lau-fs f-book">${bOpts}</select></div>
        </div>`;

    } else if (op.action === 'merge') {
      bodyHtml = `
        <div class="lau-info-pill">Keep UID <b>${op.keepUid}</b> · Disable UID <b>${op.removeUid}</b></div>
        <div class="lau-fg"><div class="lau-fl">Merged title <em>(optional)</em></div>
          <input class="lau-fi f-comment" type="text" value="${esc(op.comment || '')}"></div>
        <div class="lau-fg"><div class="lau-fl">Merged content</div>
          <textarea class="lau-ft f-content">${esc(op.content || '')}</textarea></div>
        <div class="lau-fg lau-fg-sm"><div class="lau-fl">Lorebook</div>
          <select class="lau-fs f-book">${bOpts}</select></div>`;

    } else if (op.action === 'forget') {
      bodyHtml = `
        <div class="lau-info-pill">Will disable UID <b>${op.uid}</b></div>
        <div class="lau-fg lau-fg-sm"><div class="lau-fl">Lorebook</div>
          <select class="lau-fs f-book">${bOpts}</select></div>`;
    }

    return $(`
<div class="lau-card ${appliedCls}" data-id="${op._id}">
  <div class="lau-card-hdr">
    <span class="lau-badge ${bdgCls}">${badge}</span>
    <span class="lau-card-title">${esc(headerTitle)}</span>
    <span class="lau-card-chev">▼</span>
  </div>
  <div class="lau-card-body">
    ${bodyHtml}
    ${op.reason ? `<div class="lau-reason">💬 ${esc(op.reason)}</div>` : ''}
    <div class="lau-card-foot">
      <button class="lau-btn lau-btn-xs lau-apply-one" data-id="${op._id}">Apply this</button>
      <button class="lau-btn lau-btn-xs lau-btn-del lau-remove" data-id="${op._id}">Remove</button>
    </div>
  </div>
</div>`);
  }

  // Sync visible card DOM values back into previewData before tab switch / apply all
  function syncCardsToData() {
    $('#lau-card-list .lau-card').each(function () {
      const id = $(this).data('id');
      const op = previewData.find(o => o._id === id);
      if (!op) return;
      const g = sel => $(this).find(sel).val();

      // Fields common to multiple actions
      const book = g('.f-book');
      if (book != null) op.targetBook = book;

      if (op.action === 'create' || op.action === 'summarize' || op.action === 'update') {
        const comment = g('.f-comment');
        const content = g('.f-content');
        const keys    = g('.f-keys');
        if (comment != null) op.comment = comment || null;
        if (content != null) op.content = content || null;
        if (keys    != null) op.keys    = keys.split(',').map(k => k.trim()).filter(Boolean);
      }
      if (op.action === 'merge') {
        const comment = g('.f-comment');
        const content = g('.f-content');
        if (comment != null) op.comment = comment || null;
        if (content != null) op.content = content || null;
      }
    });
  }

  function updateTabCounts() {
    $('.lau-tab').each(function () {
      const f = $(this).data('f');
      const n = f === 'all'
        ? previewData.length
        : previewData.filter(op => op.action === f).length;
      $(this).text($(this).text().replace(/\(\d+\)/, `(${n})`));
    });
  }

  function wirePopup(bookOptHtml) {
    let activeFilter = 'all';

    // Close buttons
    $(document).on('click.lau', '#lau-pop-close, #lau-discard', closePopup);
    $('#lau-overlay').on('click', e => { if (e.target.id === 'lau-overlay') closePopup(); });

    // Tabs
    $(document).on('click.lau', '.lau-tab', function () {
      syncCardsToData();
      $('.lau-tab').removeClass('active');
      $(this).addClass('active');
      activeFilter = $(this).data('f');
      renderCards(activeFilter, bookOptHtml);
    });

    // Card expand/collapse
    $(document).on('click.lau', '.lau-card-hdr', function (e) {
      // Don't toggle when clicking buttons inside the header
      if ($(e.target).closest('button').length) return;
      $(this).closest('.lau-card').toggleClass('open');
    });

    // Expand / Collapse all
    $(document).on('click.lau', '#lau-expand-all',   () => $('#lau-card-list .lau-card').addClass('open'));
    $(document).on('click.lau', '#lau-collapse-all', () => $('#lau-card-list .lau-card').removeClass('open'));

    // Remove individual card
    $(document).on('click.lau', '.lau-remove', function () {
      const id  = $(this).data('id');
      const idx = previewData.findIndex(op => op._id === id);
      if (idx !== -1) previewData.splice(idx, 1);
      $(`#lau-card-list .lau-card[data-id="${id}"]`).remove();
      updateTabCounts();
    });

    // Apply single operation
    $(document).on('click.lau', '.lau-apply-one', async function () {
      syncCardsToData();
      const id = $(this).data('id');
      const op = previewData.find(o => o._id === id);
      if (!op || op.applied) return;

      const $btn = $(this).text('Saving…').prop('disabled', true);
      try {
        await applyOp(op);
        op.applied = true;
        $(`#lau-card-list .lau-card[data-id="${id}"]`)
          .removeClass('c-create c-update c-merge c-forget c-summarize')
          .addClass('c-applied');
        $btn.text('✅ Saved').prop('disabled', false);
      } catch (err) {
        $btn.text('❌ Error').prop('disabled', false);
        setScanInfo('❌ ' + err.message, 'err');
        alert('Error applying operation:\n' + err.message);
      }
    });

    // Apply all pending operations
    $(document).on('click.lau', '#lau-apply-all', async function () {
      syncCardsToData();
      const pending = previewData.filter(op => !op.applied);
      if (!pending.length) { alert('Nothing left to apply.'); return; }

      const $btn = $(this).text('Saving…').prop('disabled', true);
      let ok = 0, fail = 0;

      for (const op of pending) {
        try {
          await applyOp(op);
          op.applied = true;
          ok++;
        } catch (err) {
          fail++;
          console.error('[LAU] Apply failed for op:', op, err);
        }
      }

      $btn.prop('disabled', false);

      if (!fail) {
        setScanInfo(`✅ Applied ${ok} operation(s) successfully.`, 'ok');
        closePopup();
      } else {
        $btn.text('Retry');
        setScanInfo(`Applied ${ok}, failed ${fail}. See console (F12).`, 'warn');
        alert(`Applied: ${ok} ✅   Failed: ${fail} ❌\nCheck the browser console (F12) for details.`);
      }
    });
  }

  function closePopup() {
    $(document).off('.lau');
    $('#lau-overlay').remove();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BOOT
  // ═══════════════════════════════════════════════════════════════════════════

  jQuery(function () {
    try {
      const { eventSource, event_types } = ctx();
      eventSource.on(event_types.APP_READY, () => mountUI());
      console.log('[Lorebook Auto-Updater v2.0] loaded ✓');
    } catch (e) {
      console.error('[LAU] Boot failed:', e);
    }
  });

})();
