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
    bookMeta:         {},   // { [bookName]: { description: '', tags: '' } }
    promptPresets:    {},   // { [presetName]: promptString }
    entryDefaults: {        // defaults applied when creating new entries
      order:     100,
      position:  0,         // 0=↑Char 1=↓Char 2=↑AN 3=↓AN 4=↑EM 5=↓EM
      constant:  false,
      selective: false,
    },
    // Feature AI-1/2/3/4
    includeCharContext: true,  // inject character card + persona into prompt
    entryPreviewChars:  1000,  // max chars shown per entry to AI (0 = unlimited)
    relevanceSorting:   true,  // show keyword-matching entries first
    scanOnlyNew:        false, // scan only messages since last successful scan
    lastScans:          {},    // { [chatId]: lastMsgIndex } — persisted per chat
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  let scanning          = false;
  let previewData       = [];   // array of operation objects
  let previewBooks      = {};   // { name: bookData } — for popup book dropdown
  let lastBookOptHtml   = '';   // cached for "reopen" button
  let collapsed         = true;
  let activityLog       = [];   // last 10 applied operations

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
    if (!s.bookMeta || typeof s.bookMeta !== 'object') s.bookMeta = {};
    if (!s.promptPresets || typeof s.promptPresets !== 'object') s.promptPresets = {};
    if (!s.entryDefaults || typeof s.entryDefaults !== 'object') s.entryDefaults = {};
    s.entryDefaults = { ...DEFAULTS.entryDefaults, ...s.entryDefaults };
    if (typeof s.includeCharContext !== 'boolean') s.includeCharContext = true;
    if (!(s.entryPreviewChars >= 0))               s.entryPreviewChars = 1000;
    if (typeof s.relevanceSorting !== 'boolean')   s.relevanceSorting  = true;
    if (typeof s.scanOnlyNew !== 'boolean')        s.scanOnlyNew       = false;
    if (!s.lastScans || typeof s.lastScans !== 'object') s.lastScans   = {};
    return s;
  }

  function save() { ctx().saveSettingsDebounced(); }

  // Get metadata for a book (description + tags). Always returns an object.
  function getBookMeta(name) {
    const s = getSettings();
    if (!s.bookMeta[name]) s.bookMeta[name] = { description: '', tags: '' };
    return s.bookMeta[name];
  }

  function setBookMeta(name, description, tags) {
    const s = getSettings();
    if (!s.bookMeta[name]) s.bookMeta[name] = {};
    s.bookMeta[name].description = String(description || '').trim();
    s.bookMeta[name].tags        = String(tags        || '').trim();
    save();
  }

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

  // Feature AI-1: extract character card / persona from ST context
  function buildCharacterContext(c) {
    const lines = [];

    const uname = c.name1 || 'User';
    const cname = c.name2 || 'Character';
    lines.push(`User name: ${uname}`);
    lines.push(`Character name: ${cname}`);

    // Character card fields — try multiple access paths ST uses
    const char = (c.characters && c.characterId != null)
      ? (c.characters[c.characterId] || {})
      : {};

    const desc     = (char.description     || c.description     || '').trim();
    const pers     = (char.personality     || c.personality     || '').trim();
    const scen     = (char.scenario        || c.scenario        || '').trim();
    const sysprompt= (char.system_prompt   || c.system_prompt   || '').trim();

    if (desc)      lines.push(`Character description: ${desc.slice(0, 600)}`);
    if (pers)      lines.push(`Personality: ${pers.slice(0, 400)}`);
    if (scen)      lines.push(`Scenario: ${scen.slice(0, 400)}`);
    if (sysprompt) lines.push(`System prompt excerpt: ${sysprompt.slice(0, 300)}`);

    // Active persona
    const personaId = c.persona_description !== undefined
      ? null   // some ST builds expose it directly
      : null;
    const personaText = (c.persona_description || '').trim();
    if (personaText) lines.push(`User persona: ${personaText.slice(0, 300)}`);

    return lines.join('\n');
  }

  // Feature AI-2: score an entry by how many of its keys appear in recent text
  function scoreEntryRelevance(entry, recentLower) {
    const keys = (entry.key || []);
    if (!keys.length || !recentLower) return 0;
    let hits = 0;
    for (const k of keys) {
      if (recentLower.includes(String(k).toLowerCase())) hits++;
    }
    return hits;
  }

  // Feature AI-2+3: build lorebook summary with relevance sorting + truncation tracking
  // Returns { summary: string, truncatedCount: number }
  function buildBookSummary(books, recentText, s) {
    const previewChars   = s?.entryPreviewChars ?? 1000;
    const doRelevance    = s?.relevanceSorting ?? true;
    const recentLower    = recentText ? recentText.toLowerCase() : '';

    const lines          = [];
    let   truncatedCount = 0;

    for (const [name, data] of Object.entries(books)) {
      const active = Object.values(data?.entries || {}).filter(e => !e.disable);
      const meta   = getBookMeta(name);
      lines.push(`\n[Lorebook: "${name}" — ${active.length} active entries]`);
      if (meta.description) lines.push(`  Purpose: ${meta.description}`);
      if (meta.tags)        lines.push(`  Tags: ${meta.tags}`);

      // Feature AI-2: split into relevant vs. other
      let sorted = active;
      if (doRelevance && recentLower) {
        const scored = active.map(e => ({ e, score: scoreEntryRelevance(e, recentLower) }));
        const relevant = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
        const other    = scored.filter(x => x.score === 0);
        sorted = [...relevant.map(x => x.e), ...other.map(x => x.e)];

        if (relevant.length && other.length) {
          // We'll inject a separator later — mark boundary
          sorted._boundary = relevant.length;
        }
      }

      sorted.forEach((e, idx) => {
        // Feature AI-2: separator between relevant and other
        if (sorted._boundary && idx === sorted._boundary) {
          lines.push(`  --- entries below were NOT triggered by recent chat ---`);
        }

        const keys    = (e.key || []).slice(0, 5).join(', ') || '—';
        const content = (e.content || '').trim();

        // Feature AI-3: apply configurable preview limit
        const limit   = previewChars > 0 ? previewChars : Infinity;
        const shown   = content.slice(0, limit);
        const clipped = previewChars > 0 && content.length > previewChars;
        if (clipped) truncatedCount++;

        lines.push(`  UID ${e.uid} | "${e.comment || '(no title)'}" | keys: [${keys}]`);
        if (shown) {
          shown.split('\n').forEach(l => lines.push(`    ${l}`));
          if (clipped) lines.push(`    …(truncated — ${content.length - previewChars} chars hidden)`);
        }
      });
    }

    return {
      summary:        lines.join('\n').trim() || '(no entries yet)',
      truncatedCount,
    };
  }

  function buildFullPrompt(customPrompt, charContext, bookSummary, msgs, msgLabel) {
    const contextBlock = charContext
      ? `\n=== SESSION CONTEXT ===\n${charContext}\n`
      : '';
    return `${customPrompt}
${contextBlock}
=== EXISTING LOREBOOK ENTRIES ===
${bookSummary}

=== RECENT CHAT (${msgLabel}) ===
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
    showReopenBtn(false);

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

      // ── Step 2: Get chat messages (Feature AI-4: scanOnlyNew support) ─────
      const c    = ctx();
      const chat = c.chat || [];

      // chatId key — use character + chat file name if available, else fallback
      const chatId = String(c.chatId || c.characterId || 'global');

      let msgSlice;
      let msgLabel;

      if (s.scanOnlyNew && s.lastScans[chatId] != null) {
        const lastIdx = s.lastScans[chatId];
        const newMsgs = chat.slice(lastIdx);
        if (!newMsgs.length) {
          setScanInfo('ℹ️ No new messages since last scan.', 'info');
          updateLastScanUI(chatId);
          return;
        }
        msgSlice = newMsgs;
        msgLabel = `${newMsgs.length} new message(s) since last scan`;
      } else {
        const count = Math.max(1, s.messageScanCount);
        msgSlice    = chat.slice(-count);
        msgLabel    = `last ${count} messages`;
      }

      const isGroup = !!c.groupId;
      const msgs = msgSlice
        .filter(m => m?.mes && !m.is_system)
        .map(m => {
          let role;
          if (m.is_user) {
            role = c.name1 || 'User';
          } else if (isGroup) {
            role = m.name || 'AI';
          } else {
            role = m.name || c.name2 || 'AI';
          }
          return `${role}: ${m.mes}`;
        });

      if (!msgs.length) {
        setScanInfo('⚠️ No chat messages to scan yet.', 'warn');
        return;
      }

      setStats({ books: bookCount, entries: totalEntries, msgs: msgs.length, suggested: null });
      setScanInfo(`🤖 Asking AI… (${totalEntries} entries · ${msgs.length} msgs)`, 'info');

      // ── Step 3: Build prompt & call AI ────────────────────────────────────
      // Feature AI-1: character context
      const charContext = s.includeCharContext ? buildCharacterContext(c) : '';

      // Feature AI-2+3: relevance sorting + configurable preview
      const recentText = msgs.join(' ');
      const { summary, truncatedCount } = buildBookSummary(books, recentText, s);

      const fullPrompt = buildFullPrompt(s.prompt, charContext, summary, msgs, msgLabel);
      const raw        = await aiGenerate(fullPrompt);

      if (!raw) {
        setScanInfo('⚠️ AI returned empty response.', 'warn');
        return;
      }

      // ── Step 4: Parse response ────────────────────────────────────────────
      const ops = parseResponse(raw, books, s);

      // Feature AI-4: save last scanned position after successful parse
      s.lastScans[chatId] = chat.length;   // next scan starts from here
      save();
      updateLastScanUI(chatId);

      if (!ops.length) {
        setScanInfo(
          truncatedCount
            ? `ℹ️ Nothing to update. ⚠️ ${truncatedCount} entr${truncatedCount > 1 ? 'ies were' : 'y was'} truncated in prompt — consider raising Entry preview limit.`
            : 'ℹ️ AI found nothing to add or update.',
          truncatedCount ? 'warn' : 'info'
        );
        setStats({ books: bookCount, entries: totalEntries, msgs: msgs.length, suggested: 0 });
        return;
      }

      previewData     = ops;
      previewBooks    = books;
      lastBookOptHtml = Object.keys(books)
        .map(n => `<option value="${n}">${n}</option>`).join('');

      const counts = countByAction(ops);
      setStats({ books: bookCount, entries: totalEntries, msgs: msgs.length, suggested: ops.length });

      // Feature AI-3: surface truncation warning alongside results
      const truncWarn = truncatedCount
        ? ` ⚠️ ${truncatedCount} truncated`
        : '';
      setScanInfo(
        `✅ ${counts.create} new · ${counts.update} updated · ${counts.merge} merged · ` +
        `${counts.forget} forgotten · ${counts.summarize} summarized${truncWarn}`,
        truncatedCount ? 'warn' : 'ok'
      );

      showReopenBtn(true);
      openPopup();

    } catch (err) {
      setScanInfo('❌ ' + err.message, 'err');
      console.error('[LAU] Scan error:', err);
    } finally {
      scanning = false;
      setScanBtn(true);
    }
  }

  // Feature AI-4: refresh the "last scan" status line in settings panel
  function updateLastScanUI(chatId) {
    const s      = getSettings();
    const idx    = s.lastScans[chatId];
    const $el    = $('#lau-last-scan-info');
    if (!$el.length) return;
    if (idx != null) {
      const total = (ctx().chat || []).length;
      $el.text(`Last scan: msg #${idx} of ${total}`).css('color', '#4ade80');
    } else {
      $el.text('Not scanned yet').css('color', '#475569');
    }
  }

  function countByAction(ops) {
    return ops.reduce((acc, op) => {
      acc[op.action] = (acc[op.action] || 0) + 1;
      return acc;
    }, { create: 0, update: 0, merge: 0, forget: 0, summarize: 0 });
  }

  // Feature 14: find existing entries whose keys overlap with the given list
  function findKeyConflicts(keys) {
    const lowerKeys = (keys || []).map(k => String(k).toLowerCase());
    if (!lowerKeys.length) return [];
    const hits = [];
    for (const [bName, bData] of Object.entries(previewBooks)) {
      for (const e of Object.values(bData.entries || {})) {
        if (e.disable) continue;
        const eKeys = (e.key || []).map(k => String(k).toLowerCase());
        const shared = lowerKeys.filter(k => eKeys.includes(k));
        if (shared.length) {
          hits.push({ uid: e.uid, title: e.comment || `UID ${e.uid}`, book: bName, keys: shared });
        }
      }
    }
    return hits;
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

    // uidBook is our ground truth — ALWAYS overrides AI's target_book for uid-based ops
    const resolveBook = (uid) =>
      (uid != null && uidBook[uid] != null) ? uidBook[uid] : (defaultBook);

    for (let i = 0; i < arr.length; i++) {
      const op = arr[i];
      if (!op || !VALID_ACTIONS.has(op.action)) continue;

      const base = {
        _id:     `lau_${Date.now()}_${i}`,
        action:  op.action,
        reason:  String(op.reason || ''),
        applied: false,
      };

      if (op.action === 'create' || op.action === 'summarize') {
        if (!op.comment?.trim() || !op.content?.trim()) continue;
        ops.push({
          ...base,
          targetBook: op.target_book || defaultBook,
          comment: String(op.comment).slice(0, 200),
          content: String(op.content).slice(0, 5000),
          keys:    Array.isArray(op.keys) ? op.keys.map(String).slice(0, 10) : [],
        });

      } else if (op.action === 'update') {
        if (op.uid == null) continue;
        const uid = Number(op.uid);
        if (!isFinite(uid)) continue;
        ops.push({
          ...base,
          uid,
          targetBook: resolveBook(uid),   // always our map, not AI's guess
          comment: op.comment?.trim() ? String(op.comment).slice(0, 200) : null,
          content: op.content?.trim() ? String(op.content).slice(0, 5000) : null,
          keys:    Array.isArray(op.keys) ? op.keys.map(String).slice(0, 10) : null,
        });

      } else if (op.action === 'merge') {
        if (op.keep_uid == null || op.remove_uid == null) continue;
        const keepUid   = Number(op.keep_uid);
        const removeUid = Number(op.remove_uid);
        if (!isFinite(keepUid) || !isFinite(removeUid) || keepUid === removeUid) continue;
        ops.push({
          ...base,
          keepUid,
          removeUid,
          targetBook: resolveBook(keepUid),   // always our map
          comment: op.comment?.trim() ? String(op.comment).slice(0, 200) : null,
          content: op.content?.trim() ? String(op.content).slice(0, 5000) : null,
        });

      } else if (op.action === 'forget') {
        if (op.uid == null) continue;
        const uid = Number(op.uid);
        if (!isFinite(uid)) continue;
        ops.push({
          ...base,
          uid,
          targetBook: resolveBook(uid),   // always our map
        });
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

  // Search previewBooks for an entry by uid (used by diff view in cards)
  function findEntryInAllBooks(uid) {
    for (const data of Object.values(previewBooks)) {
      const e = findEntryByUid(data.entries || {}, uid);
      if (e) return e;
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
      const ed    = getSettings().entryDefaults;
      entry.comment   = op.comment;
      entry.content   = op.content;
      entry.key       = op.keys || [];
      entry.disable   = false;
      entry.constant  = !!ed.constant;
      entry.selective = !!ed.selective;
      entry.addMemo   = !!op.comment;
      entry.order     = ed.order ?? 100;
      entry.position  = ed.position ?? 0;
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

      <!-- Feature AI-1/2/3/4: AI quality settings -->
      <div class="lau-field">
        <div class="lau-field-label">🧠 AI context &amp; prompt quality</div>

        <div class="lau-frow" style="margin-top:4px; flex-wrap:wrap; gap:8px">

          <!-- AI-1 -->
          <label class="lau-ed-check" title="Adds character name, description, scenario and persona to the prompt so AI understands who is who">
            <input type="checkbox" id="lau-char-ctx"> Include character context
          </label>

          <!-- AI-2 -->
          <label class="lau-ed-check" title="Entries whose keywords appear in recent messages are shown first so AI prioritises them">
            <input type="checkbox" id="lau-relevance"> Relevance sorting
          </label>

        </div>

        <!-- AI-3 -->
        <div class="lau-frow" style="margin-top:8px; align-items:center; gap:6px">
          <span class="lau-lbl">Entry preview limit</span>
          <input type="number" class="lau-num" id="lau-preview-chars" min="0" max="9999" style="width:64px" title="Max chars per entry sent to AI. 0 = unlimited.">
          <span class="lau-lbl">chars &nbsp;<em style="color:#334155">(0 = unlimited)</em></span>
        </div>

        <!-- AI-4 -->
        <div style="margin-top:8px; display:flex; flex-direction:column; gap:4px">
          <label class="lau-ed-check" title="Only scan messages that arrived after the last successful scan">
            <input type="checkbox" id="lau-scan-only-new"> Scan only new messages
          </label>
          <div style="display:flex; align-items:center; gap:6px; padding-left:2px">
            <span class="lau-scan-info" id="lau-last-scan-info" style="font-style:normal; font-size:0.74em; color:#475569">Not scanned yet</span>
            <button class="lau-btn lau-btn-xs" id="lau-reset-scan-pos" title="Forget last scan position — next scan will use the full message window">↺ Reset</button>
          </div>
        </div>

      </div>

      <!-- Feature 7: Prompt presets -->
      <div class="lau-field">
        <div class="lau-field-label">💾 Prompt presets</div>
        <div class="lau-presets-row">
          <select class="lau-preset-sel" id="lau-preset-sel">
            <option value="">— select preset —</option>
          </select>
          <button class="lau-btn lau-btn-xs" id="lau-preset-load" title="Load selected preset into editor">📂 Load</button>
          <button class="lau-btn lau-btn-xs" id="lau-preset-save" title="Save current prompt as a new preset">💾 Save as…</button>
          <button class="lau-btn lau-btn-xs lau-btn-del" id="lau-preset-del" title="Delete selected preset">🗑️</button>
        </div>
      </div>

      <div class="lau-field">
        <div class="lau-field-label">🤖 AI Prompt</div>
        <textarea class="lau-textarea" id="lau-prompt"></textarea>
        <button class="lau-btn" id="lau-reset-prompt" style="margin-top:5px">↩️ Reset to default</button>
      </div>

      <!-- Feature 8: Entry defaults -->
      <div class="lau-field">
        <div class="lau-field-label">🆕 Defaults for new entries</div>
        <div class="lau-frow" style="margin-top:4px">
          <div class="lau-fg">
            <div class="lau-fl">Insertion order</div>
            <input type="number" class="lau-fi" id="lau-ed-order" min="0" max="999" style="width:70px">
          </div>
          <div class="lau-fg">
            <div class="lau-fl">Position</div>
            <select class="lau-fs" id="lau-ed-position">
              <option value="0">↑ Before char</option>
              <option value="1">↓ After char</option>
              <option value="2">↑ Before AN</option>
              <option value="3">↓ After AN</option>
              <option value="4">↑ Before EM</option>
              <option value="5">↓ After EM</option>
            </select>
          </div>
        </div>
        <div class="lau-frow" style="margin-top:6px">
          <label class="lau-ed-check">
            <input type="checkbox" id="lau-ed-constant"> Constant (always inject)
          </label>
          <label class="lau-ed-check">
            <input type="checkbox" id="lau-ed-selective"> Selective (needs secondary keys)
          </label>
        </div>
      </div>

    </div>

  </div>
</div>`);

    // Restore saved settings to UI
    const s = getSettings();
    $('#lau-count').val(s.messageScanCount);
    $('#lau-prompt').val(s.prompt);
    // Feature 8: entry defaults
    $('#lau-ed-order').val(s.entryDefaults.order);
    $('#lau-ed-position').val(s.entryDefaults.position);
    $('#lau-ed-constant').prop('checked', s.entryDefaults.constant);
    $('#lau-ed-selective').prop('checked', s.entryDefaults.selective);
    // Feature 7: presets
    populatePresetSelect();
    // Features AI-1/2/3/4
    $('#lau-char-ctx').prop('checked', s.includeCharContext);
    $('#lau-relevance').prop('checked', s.relevanceSorting);
    $('#lau-preview-chars').val(s.entryPreviewChars);
    $('#lau-scan-only-new').prop('checked', s.scanOnlyNew);
    // Refresh last-scan label
    const chatId0 = String(ctx().chatId || ctx().characterId || 'global');
    updateLastScanUI(chatId0);

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
      const on   = s.selectedBooks.includes(name);
      const meta = getBookMeta(name);
      const hasDesc = !!(meta.description || meta.tags);

      const $wrap = $(`<div class="lau-book-wrap"></div>`);

      // ── Main row ──────────────────────────────────────────────
      const $row = $(`<div class="lau-book-row${on ? ' lau-on' : ''}${hasDesc ? ' lau-has-meta' : ''}">
        <span class="lau-ck">${on ? '☑' : '☐'}</span>
        <span class="lau-bname">${esc(name)}</span>
        <button class="lau-meta-btn" title="Description &amp; tags for AI">✏️</button>
      </div>`);
      $row[0]._lauName = name;

      // Toggle selection on row click (not on ✏️ button)
      $row.on('click', function (e) {
        if ($(e.target).hasClass('lau-meta-btn')) return; // handled separately
        const n  = this._lauName;
        const sl = getSettings().selectedBooks;
        const i  = sl.indexOf(n);
        if (i === -1) { sl.push(n);    $(this).addClass('lau-on').find('.lau-ck').text('☑'); }
        else          { sl.splice(i,1); $(this).removeClass('lau-on').find('.lau-ck').text('☐'); }
        save();
        updateSelCount();
      });

      // ── Meta editor (hidden by default) ──────────────────────
      const activeTags = meta.tags ? meta.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      const $meta = $(`<div class="lau-meta-form" style="display:none">
        <div class="lau-meta-field">
          <label class="lau-meta-label">📝 Description for AI</label>
          <input class="lau-meta-input lau-meta-desc" type="text"
            placeholder="e.g. Gasil — demon character, personality and history"
            value="${esc(meta.description)}" />
        </div>
        <div class="lau-meta-field">
          <label class="lau-meta-label">🏷️ Category tags</label>
          <div class="lau-tag-chips" id="lau-chips-${esc(name)}"></div>
        </div>
      </div>`);
      $meta[0]._lauName = name;

      // Render tag chips
      const PRESET_TAGS = [
        'main character', 'npc', 'faction', 'location',
        'world', 'race', 'item', 'lore', 'event', 'summary', 'relationship',
      ];
      const $chips = $meta.find('.lau-tag-chips');
      PRESET_TAGS.forEach(tag => {
        const on = activeTags.includes(tag);
        const $chip = $(`<span class="lau-chip${on ? ' lau-chip-on' : ''}">${esc(tag)}</span>`);
        $chip[0]._lauTag = tag;
        $chip.on('click', function () {
          $(this).toggleClass('lau-chip-on');
          _saveChipsAndDesc($meta, $row, name);
        });
        $chips.append($chip);
      });

      function _saveChipsAndDesc($m, $r, n) {
        const tags = $m.find('.lau-chip-on').map(function () { return this._lauTag; }).get().join(',');
        const desc = $m.find('.lau-meta-desc').val();
        setBookMeta(n, desc, tags);
        const hasMeta = !!(desc.trim() || tags.trim());
        $r.toggleClass('lau-has-meta', hasMeta);
      }

      // Save description on input
      $meta.on('input', '.lau-meta-desc', function () {
        _saveChipsAndDesc($meta, $row, name);
      });

      // Toggle meta form on ✏️ click
      $row.find('.lau-meta-btn').on('click', function (e) {
        e.stopPropagation();
        const isOpen = $meta.is(':visible');
        $meta.slideToggle(140);
        $(this).text(isOpen ? '✏️' : '✕');
      });

      $wrap.append($row).append($meta);
      $list.append($wrap);
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

  // Feature 7: populate the preset <select>
  function populatePresetSelect() {
    const presets = getSettings().promptPresets;
    const $sel = $('#lau-preset-sel').empty();
    $sel.append('<option value="">— select preset —</option>');
    for (const name of Object.keys(presets).sort()) {
      $sel.append(`<option value="${esc(name)}">${esc(name)}</option>`);
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

    // Feature 7: preset controls
    $('#lau-preset-load').on('click', () => {
      const name    = $('#lau-preset-sel').val();
      const presets = getSettings().promptPresets;
      if (!name || !presets[name]) return;
      getSettings().prompt = presets[name];
      $('#lau-prompt').val(presets[name]);
      save();
    });

    $('#lau-preset-save').on('click', () => {
      const name = prompt('Save current prompt as preset:\nEnter a name:');
      if (!name?.trim()) return;
      const n = name.trim();
      const s = getSettings();
      s.promptPresets[n] = s.prompt;
      save();
      populatePresetSelect();
      $('#lau-preset-sel').val(n);
    });

    $('#lau-preset-del').on('click', () => {
      const name = $('#lau-preset-sel').val();
      if (!name) return;
      if (!confirm(`Delete preset "${name}"?`)) return;
      delete getSettings().promptPresets[name];
      save();
      populatePresetSelect();
    });

    // Feature 8: entry defaults
    $('#lau-ed-order').on('input', function () {
      deb('edo', () => { getSettings().entryDefaults.order = Math.max(0, parseInt(this.value) || 100); save(); });
    });
    $('#lau-ed-position').on('change', function () {
      getSettings().entryDefaults.position = parseInt(this.value) || 0; save();
    });
    $('#lau-ed-constant').on('change', function () {
      getSettings().entryDefaults.constant = this.checked; save();
    });
    $('#lau-ed-selective').on('change', function () {
      getSettings().entryDefaults.selective = this.checked; save();
    });

    // Feature AI-1
    $('#lau-char-ctx').on('change', function () {
      getSettings().includeCharContext = this.checked; save();
    });

    // Feature AI-2
    $('#lau-relevance').on('change', function () {
      getSettings().relevanceSorting = this.checked; save();
    });

    // Feature AI-3
    $('#lau-preview-chars').on('input', function () {
      deb('pvc', () => {
        const v = parseInt(this.value);
        getSettings().entryPreviewChars = isNaN(v) || v < 0 ? 1000 : v;
        save();
      });
    });

    // Feature AI-4
    $('#lau-scan-only-new').on('change', function () {
      getSettings().scanOnlyNew = this.checked; save();
    });
    $('#lau-reset-scan-pos').on('click', () => {
      const s  = getSettings();
      const id = String(ctx().chatId || ctx().characterId || 'global');
      delete s.lastScans[id];
      save();
      updateLastScanUI(id);
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

  function showReopenBtn(show) {
    if (show && previewData.length) {
      if (!$('#lau-reopen-btn').length) {
        const $btn = $('<button class="lau-btn lau-btn-reopen" id="lau-reopen-btn">📋 Reopen last scan</button>');
        $btn.on('click', () => {
          if (previewData.length && lastBookOptHtml) openPopup();
        });
        $('#lau-scan-btn').after($btn);
      }
      $('#lau-reopen-btn').show();
    } else {
      $('#lau-reopen-btn').hide();
    }
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

    // Feature 18: build book meta info bar
    const bookMetaHtml = bookNames.map(name => {
      const meta = getBookMeta(name);
      const tags = meta.tags ? meta.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      return `<div class="lau-pop-book-meta">
        <span class="lau-pop-book-name">📚 ${esc(name)}</span>
        ${meta.description ? `<span class="lau-pop-book-desc">${esc(meta.description)}</span>` : ''}
        ${tags.map(t => `<span class="lau-pop-book-tag">${esc(t)}</span>`).join('')}
      </div>`;
    }).join('');

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

    ${bookMetaHtml ? `<div class="lau-pop-books-bar">${bookMetaHtml}</div>` : ''}

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
      // Feature 14: check for keyword conflicts
      const conflicts = findKeyConflicts(op.keys);
      const conflictHtml = conflicts.length
        ? `<div class="lau-conflict-warn">
            ⚠️ Keywords overlap with <b>${conflicts.length}</b> existing entr${conflicts.length > 1 ? 'ies' : 'y'}:
            ${conflicts.map(c =>
              `<span class="lau-conflict-pill" title="Book: ${esc(c.book)}">
                UID ${c.uid} "${esc(c.title)}" [${c.keys.map(esc).join(', ')}]
              </span>`
            ).join('')}
          </div>`
        : '';
      bodyHtml = `
        ${conflictHtml}
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
      // Feature 2: show old content for diff
      const oldEntry   = findEntryInAllBooks(op.uid);
      const oldContent = oldEntry?.content ?? '';
      const oldKeys    = (oldEntry?.key || []).join(', ');
      const diffHtml   = oldEntry
        ? `<div class="lau-diff-wrap">
            <div class="lau-diff-col">
              <div class="lau-diff-label">📄 Current content</div>
              <div class="lau-diff-old">${esc(oldContent) || '<em style="color:#475569">empty</em>'}</div>
              ${oldKeys ? `<div class="lau-diff-label" style="margin-top:6px">🔑 Current keys</div>
              <div class="lau-diff-keys-old">${esc(oldKeys)}</div>` : ''}
            </div>
            <div class="lau-diff-col">
              <div class="lau-diff-label">✏️ New content</div>`
        : '';
      const diffClose  = oldEntry ? `</div></div>` : '';

      bodyHtml = `
        <div class="lau-info-pill">Updating UID <b>${op.uid}</b>${oldEntry?.comment ? ` — "${esc(oldEntry.comment)}"` : ''}</div>
        ${diffHtml}
        <div class="lau-fg"><div class="lau-fl">New title <em>(optional — leave blank to keep)</em></div>
          <input class="lau-fi f-comment" type="text" value="${esc(op.comment || '')}"></div>
        <div class="lau-fg"><div class="lau-fl">Full updated content</div>
          <textarea class="lau-ft f-content">${esc(op.content || '')}</textarea></div>
        ${diffClose}
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
