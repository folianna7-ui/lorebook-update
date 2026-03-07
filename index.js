/**
 * Lorebook Auto-Updater v2.0
 * SillyTavern Extension — IIFE, no ES imports
 *
 * Features:
 *  - Lorebook role tags + descriptions (World / NPC / Main Characters / Race Lore / Memories / Custom)
 *  - Per-book AI scan (Precise mode) or one-shot (Fast mode)
 *  - Diff view on update cards (green = added, red = removed)
 *  - Confidence score from AI (high / medium / low)
 *  - Entry lock flag (🔒) — locked entries never suggested for update
 *  - Scan history (last 10 scans, stored in localStorage)
 */

(() => {
  'use strict';

  const EXT_KEY      = 'lau_lorebook_updater';
  const HISTORY_KEY  = 'lau_scan_history';
  const MAX_HISTORY  = 10;

  // ─── Book role tags ───────────────────────────────────────────────────────
  const BOOK_TAGS = {
    world:    { emoji: '🌍', label: 'World',            hint: 'Geography, magic rules, history, organizations, locations. DO NOT place character entries here.' },
    npc:      { emoji: '👤', label: 'NPC',              hint: 'Secondary / supporting characters only. NOT main heroes.' },
    main:     { emoji: '⭐', label: 'Main Characters',  hint: 'Main protagonists, their development, relationships, inner states.' },
    race:     { emoji: '🔥', label: 'Race / Lore',      hint: 'Race biology, culture, history, politics for a specific race.' },
    memories: { emoji: '💭', label: 'Memories',         hint: 'Key scenes and memories. Create new entries, rarely update old ones.' },
    custom:   { emoji: '📝', label: 'Custom',           hint: 'Custom category — see the description field below.' },
  };

  // ─── Default prompt (used per-book, with role injected automatically) ─────
  const BASE_PROMPT = `You are a lorebook assistant for a roleplay session.

You are processing ONE lorebook called "{BOOK_NAME}" with role: {BOOK_ROLE_LABEL}.
{BOOK_ROLE_HINT}
{BOOK_DESCRIPTION}

Analyze the RECENT CHAT below and the existing entries of THIS lorebook only.
Find entities relevant to this lorebook's role that either:
  a) Are NEW and not yet in this lorebook — suggest "create"
  b) Already exist AND have genuinely new information in the chat — suggest "update"
  c) Nothing meaningful is new — return empty entries array

═══ CONTENT & LANGUAGE ═══
- Entry "content" MUST be in ENGLISH only.
- Entry "comment" (title) MUST be in ENGLISH only.
- NEVER place entries that belong to a different lorebook role (e.g. don't put character info in a World lorebook).

═══ PARAGRAPH / NEWLINE PRESERVATION ═══
Existing entries are shown with newlines encoded as [NL].
In your "content" field you MUST use [NL] wherever a newline belongs.
Example: "[LOCATION: City][NL][NL][District 1]: Cold alleys.[NL][District 2]: Warm harbor."
For UPDATE entries: copy the FULL_CONTENT exactly (with [NL]) and only INSERT new information.

═══ KEYWORDS — NEW ENTRIES ONLY (RUSSIAN DECLENSION CLUSTERS) ═══
For UPDATE entries: omit "keys" entirely — original keywords are preserved automatically.
For CREATE entries: generate 10–20 Russian keywords.

STRICT FORMAT — each keyword = ONE string with ALL 6 grammatical forms:
  "nom, gen, dat, acc, inst, prep"
  ✓ "башня, башни, башне, башню, башней, о башне"
  ✓ "кабинет директора, кабинета директора, кабинету директора, кабинет директора, кабинетом директора, о кабинете директора"
  ✗ "башня, кабинет" — WRONG, mixes two concepts into one string

Keywords MUST be concrete: locations, objects, proper nouns, unique actions, named magic, physical items.
Keywords MUST NOT be abstract: близость, доверие, власть, динамика, тоска.
Keywords MUST NOT be names of the two main RP characters.

═══ CRITICAL RULE FOR UPDATES ═══
Before proposing any update, verify:
  "Is this entry's topic EXPLICITLY mentioned in the recent chat messages?"
  If NO — omit it entirely from your response.

For "update" content:
1. COPY the FULL_CONTENT from ENTRY_START uid:N … ENTRY_END uid:N EXACTLY.
   Use ONLY that uid's content — NEVER mix content from different entries.
2. APPEND / INTEGRATE new facts from chat only.
3. NEVER delete or shorten existing text. Result must be longer or equal.
4. PRESERVE formatting style: [Section]: headers, bullet points, markdown.
5. Keep all [NL] tokens from original. Add [NL][NL] before new sections.

ANTI-HALLUCINATION:
— Each uid refers to exactly ONE entry. Content for uid:42 must come from ENTRY_START uid:42.
— CRITICAL ERROR: mixing content from different uids, or inventing facts not in the chat.
— If no new info for an entry — omit it entirely.

═══ ORDER / DEPTH / POSITION FOR NEW ENTRIES ═══
Analyze existing entries (each shows order/depth/position). Assign values matching the semantic category.
Defaults if unsure: order:500, depth:4, position:0.

═══ CONFIDENCE ═══
For each entry include a "confidence" field:
  "high"   — clear, explicit evidence in recent chat
  "medium" — implied or indirect evidence
  "low"    — weak inference, not directly stated

Respond ONLY with this exact JSON (no markdown, no extra text):
{
  "entries": [
    {
      "action": "create",
      "comment": "Entry title in English",
      "content": "Full text in English.[NL][NL][Section]: detail.",
      "keys": [
        "башня, башни, башне, башню, башней, о башне",
        "шпиль, шпиля, шпилю, шпиль, шпилём, о шпиле"
      ],
      "order": 500,
      "depth": 4,
      "position": 0,
      "confidence": "high",
      "reason": "Why this entry is being created"
    },
    {
      "action": "update",
      "uid": 42,
      "content": "Copy FULL_CONTENT from ENTRY_START uid:42 here.[NL][NL][New Section]: new fact.",
      "confidence": "medium",
      "reason": "What new info was added and which messages mention this entry's topic"
    }
  ]
}

Rules:
- Content and titles in ENGLISH only.
- For "create": include "keys" with Russian declension clusters.
- For "update": omit "keys" and "comment" — taken from existing entry automatically.
- For "update": MUST include uid.
- Never duplicate entries unless genuinely updating.
- If unsure — skip. Only suggest when evidence is in the chat.`;

  const DEFAULTS = {
    selectedBooks:    [],
    messageScanCount: 20,
    autoEnabled:      false,
    autoInterval:     5,
    scanMode:         'precise', // 'precise' | 'fast'
    bookMeta:         {},        // { [bookName]: { tag, description, lockedUids } }
    prompt:           BASE_PROMPT,
  };

  let scanning    = false;
  let autoCounter = 0;
  let previewData = [];
  let snapBooks   = {};
  let collapsed   = true;

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getHeaders() {
    try { const c=ctx(); if(typeof c.getRequestHeaders==='function') return c.getRequestHeaders(); } catch{}
    if(typeof window.getRequestHeaders==='function'){try{return window.getRequestHeaders();}catch{}}
    const m=document.querySelector('meta[name="csrf-token"]')?.content;
    if(m) return {'Content-Type':'application/json','X-CSRF-Token':m};
    const ck=document.cookie.match(/(?:^|;\s*)_csrf=([^;]*)/);
    if(ck) return {'Content-Type':'application/json','X-CSRF-Token':decodeURIComponent(ck[1])};
    console.warn('[LAU] No CSRF token found');
    return {'Content-Type':'application/json'};
  }

  function getSettings() {
    const ext=ctx().extensionSettings;
    if(!ext[EXT_KEY]) ext[EXT_KEY]={...DEFAULTS,selectedBooks:[],bookMeta:{}};
    const s=ext[EXT_KEY];
    Object.entries(DEFAULTS).forEach(([k,v])=>{if(s[k]===undefined) s[k]=typeof v==='object'&&!Array.isArray(v)?{...v}:v;});
    if(!s.bookMeta) s.bookMeta={};
    return s;
  }

  function save() { ctx().saveSettingsDebounced(); }

  function getBookMeta(name) {
    const s=getSettings();
    if(!s.bookMeta[name]) s.bookMeta[name]={tag:'world',description:'',lockedUids:[]};
    return s.bookMeta[name];
  }

  function isLocked(bookName, uid) {
    return (getBookMeta(bookName).lockedUids||[]).includes(uid);
  }

  function toggleLock(bookName, uid) {
    const m=getBookMeta(bookName);
    const arr=m.lockedUids||[];
    const i=arr.indexOf(uid);
    if(i===-1) arr.push(uid); else arr.splice(i,1);
    m.lockedUids=arr;
    save();
    return arr.includes(uid);
  }

  // ─── World Info ───────────────────────────────────────────────────────────

  async function serverGetNames() {
    try {
      const r=await fetch('/api/worldinfo/all',{method:'POST',headers:getHeaders(),body:'{}'});
      if(r.ok){const d=await r.json();const a=Array.isArray(d)?d:(d?.entries||d?.names||d?.worlds);if(Array.isArray(a)&&a.length&&typeof a[0]==='string'){console.log('[LAU] Names via /api/worldinfo/all:',a.length);return a;}}
    }catch(e){console.warn('[LAU] /api/worldinfo/all:',e.message);}
    try {
      const r=await fetch('/getsettings',{method:'POST',headers:getHeaders(),body:'{}'});
      if(r.ok){const d=await r.json();if(Array.isArray(d?.world_names)&&d.world_names.length){console.log('[LAU] Names via /getsettings:',d.world_names.length);return d.world_names;}}
    }catch(e){console.warn('[LAU] /getsettings:',e.message);}
    for(const p of['../../../../world-info.js','../../../world-info.js','/scripts/world-info.js']){
      try{const m=await import(p);if(Array.isArray(m?.world_names)&&m.world_names.length){return[...m.world_names];}}catch{}
    }
    try{
      const c=ctx();
      if(Array.isArray(c.world_names)&&c.world_names.length) return c.world_names;
      for(const k of['worldInfoData','worldInfo','world_info']){const o=c[k];if(o&&!Array.isArray(o)){const ks=Object.keys(o).filter(x=>typeof o[x]==='object');if(ks.length) return ks;}}
    }catch{}
    console.error('[LAU] Could not get book names!');
    return[];
  }

  async function serverGetBook(name) {
    try{const r=await fetch('/api/worldinfo/get',{method:'POST',headers:getHeaders(),body:JSON.stringify({name})});if(r.ok){const d=await r.json();if(d?.entries){return d;}}}catch(e){console.warn('[LAU] /api/worldinfo/get:',e.message);}
    try{const r=await fetch('/getworldinfo',{method:'POST',headers:getHeaders(),body:JSON.stringify({name})});if(r.ok){const d=await r.json();if(d?.entries){return d;}}}catch(e){console.warn('[LAU] /getworldinfo:',e.message);}
    for(const p of['../../../../world-info.js','../../../world-info.js','/scripts/world-info.js']){
      try{const m=await import(p);if(m?.world_info?.[name]) return m.world_info[name];}catch{}
    }
    try{const c=ctx();for(const k of['worldInfoData','worldInfo','world_info']){if(c[k]?.[name]) return c[k][name];}}catch{}
    console.error('[LAU] Could not load book:',name);
    return null;
  }

  // ─── AI generation ────────────────────────────────────────────────────────

  function extractText(d) {
    if(d?.choices?.[0]?.message?.content!=null) return d.choices[0].message.content;
    if(d?.choices?.[0]?.text!=null) return d.choices[0].text;
    if(typeof d?.response==='string') return d.response;
    if(Array.isArray(d?.content)){const t=d.content.find(b=>b.type==='text');return t?.text??null;}
    if(typeof d?.content==='string') return d.content;
    return null;
  }

  async function aiGenerate(fullPrompt) {
    const c=ctx();
    if(typeof c.generateRaw==='function'){try{const r=await c.generateRaw(fullPrompt,'',false,false,'','normal');if(r?.trim()) return r;}catch(e){console.warn('[LAU] generateRaw:',e.message);}}
    if(typeof c.generateQuietPrompt==='function'){try{const r=await c.generateQuietPrompt(fullPrompt,false,false);if(r?.trim()) return r;}catch(e){console.warn('[LAU] generateQuietPrompt:',e.message);}}
    for(const{url,body}of[
      {url:'/api/backends/chat-completions/generate',body:{messages:[{role:'user',content:fullPrompt}],stream:false}},
      {url:'/api/generate',body:{prompt:fullPrompt,max_new_tokens:2000,stream:false}},
    ]){
      try{const r=await fetch(url,{method:'POST',headers:getHeaders(),body:JSON.stringify(body)});if(!r.ok) continue;const t=extractText(await r.json());if(t?.trim()) return t;}catch{}
    }
    throw new Error('No active AI connection. Set one up in SillyTavern first.');
  }

  // ─── Prompt builder ───────────────────────────────────────────────────────

  function buildBookPrompt(bookName, bookData, msgs, meta, allBooks) {
    const tag      = meta?.tag || 'world';
    const tagInfo  = BOOK_TAGS[tag] || BOOK_TAGS.world;
    const desc     = meta?.description?.trim();
    const locked   = meta?.lockedUids || [];

    let prompt = (getSettings().prompt || BASE_PROMPT)
      .replace('{BOOK_NAME}',        bookName)
      .replace('{BOOK_ROLE_LABEL}',  `${tagInfo.emoji} ${tagInfo.label}`)
      .replace('{BOOK_ROLE_HINT}',   `Role guidance: ${tagInfo.hint}`)
      .replace('{BOOK_DESCRIPTION}', desc ? `Additional context: "${desc}"` : '');

    const entries = Object.values(bookData?.entries || {});
    const lines = [`\n====== LOREBOOK: "${bookName}" [${tagInfo.emoji} ${tagInfo.label}] (${entries.length} entries) ======`];

    entries.forEach(e => {
      const lockMark = locked.includes(e.uid) ? ' 🔒 LOCKED — DO NOT SUGGEST UPDATES' : '';
      lines.push(`\n>>>>> ENTRY_START uid:${e.uid} <<<<<`);
      lines.push(`TITLE: ${e.comment||'(no title)'}${lockMark}`);
      lines.push(`META: order:${e.order??'?'} depth:${e.depth??'?'} position:${e.position??'?'}`);
      if((e.key||[]).length) lines.push(`EXISTING_KEYS (preserved on update, do NOT change): ${JSON.stringify(e.key)}`);
      if(e.content){
        const encoded=e.content.replace(/\r\n/g,'[NL]').replace(/\n/g,'[NL]');
        lines.push(`FULL_CONTENT (newlines=[NL]):`);
        lines.push(encoded);
      }
      lines.push(`<<<<< ENTRY_END uid:${e.uid} >>>>>`);
    });

    // Cross-book index: tell AI about entries in OTHER books so it won't recreate them
    let crossBookSection = '';
    if (allBooks && Object.keys(allBooks).length > 1) {
      const otherEntries = [];
      Object.entries(allBooks).forEach(([oBook, oData]) => {
        if (oBook === bookName) return;
        Object.values(oData?.entries || {}).forEach(oe => {
          if (oe.comment) otherEntries.push(`  - "${oe.comment}" (uid:${oe.uid} in "${oBook}")`);
        });
      });
      if (otherEntries.length) {
        crossBookSection = `=== ENTRIES THAT ALREADY EXIST IN OTHER LOREBOOKS (do NOT recreate) ===\n${otherEntries.join('\n')}`;
      }
    }

    return `${prompt}

${lines.join('\n')}

${crossBookSection ? crossBookSection + '\n\n' : ''}=== RECENT CHAT (last ${msgs.length} messages) ===
${msgs.join('\n\n')}

Based on the chat above, suggest lorebook actions for "${bookName}". Respond with JSON only.`;
  }

  // ─── Validation + parse ───────────────────────────────────────────────────

  function buildUidMaps(books) {
    const uidBook={};
    const uidEntry={};
    Object.entries(books).forEach(([name,data])=>{
      Object.values(data?.entries||{}).forEach(ex=>{uidBook[ex.uid]=name;uidEntry[ex.uid]=ex;});
    });
    return{uidBook,uidEntry};
  }

  function validateUpdates(arr, uidEntry, bookName) {
    return arr.filter(e=>{
      if(e.action!=='update') return true;
      const uid=e.uid;
      const existing=uid!=null?uidEntry[uid]:null;
      if(!existing){console.warn(`[LAU] Dropped update: uid ${uid} not found.`);return false;}
      // If bookName provided, ensure uid belongs to this book
      if(bookName){const entries=Object.values(snapBooks[bookName]?.entries||{});const belongs=entries.some(x=>x.uid===uid);if(!belongs){console.warn(`[LAU] Dropped update uid ${uid}: not in book "${bookName}"`);return false;}}
      const rawContent=(e.content||'').replace(/\[NL\]/g,'\n').trim();
      if(!rawContent){console.warn(`[LAU] Dropped update uid ${uid}: empty content.`);return false;}
      const origLen=(existing.content||'').trim().length;
      if(origLen>100&&rawContent.length<origLen*0.8){console.warn(`[LAU] Dropped update uid ${uid}: content shrank (${origLen}→${rawContent.length}).`);return false;}
      const origStart=(existing.content||'').trim().slice(0,60).toLowerCase();
      if(origStart.length>20&&!rawContent.toLowerCase().includes(origStart)){console.warn(`[LAU] Dropped update uid ${uid}: opening of original not found in new content.`);return false;}
      return true;
    });
  }

  function parseRaw(raw) {
    let text=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```\s*$/i,'');
    try{return JSON.parse(text);}catch{}
    const m=text.match(/\{[\s\S]*\}/);
    if(!m) throw new Error('AI did not return valid JSON. Got: '+text.slice(0,300));
    return JSON.parse(m[0]);
  }

  function parseResponse(raw, books, bookName) {
    const parsed=parseRaw(raw);
    const arr=parsed.entries||parsed;
    if(!Array.isArray(arr)) throw new Error('AI response has no "entries" array.');
    const{uidBook,uidEntry}=buildUidMaps(books);
    const s=getSettings();
    const validated=validateUpdates(arr, uidEntry, bookName||null);

    return validated.map((e,i)=>{
      const existing=(e.action==='update'&&e.uid!=null)?(uidEntry[e.uid]||null):null;

      // Decode [NL] tokens; also strip any [NL= prefix artifact from a malformed prompt
      let decodedContent=(e.content||'').replace(/^\[NL=/,'').replace(/\[NL\]/g,'\n');

      // Safety: recover collapsed paragraph structure
      if(existing&&e.action==='update'&&decodedContent){
        const origNL=(existing.content||'').split('\n').length-1;
        const newNL=decodedContent.split('\n').length-1;
        if(origNL>=3&&newNL===0){
          decodedContent=decodedContent.replace(/\s*(\[[^\]]+\]:?)/g,'\n\n$1').replace(/^\n+/,'');
          console.warn('[LAU] Recovered paragraph structure for uid',e.uid);
        }
      }

      // For updates: always preserve original comment + keys from existing entry
      const useComment=existing?(existing.comment||e.comment||`Entry ${i+1}`):(e.comment||`Entry ${i+1}`).replace(/\[NL\]/g,' ');
      const useKeys=existing?(existing.key||[]):(Array.isArray(e.keys)?e.keys:[]);
      const useSecondaryKeys=existing?(existing.secondary_key||[]):[];

      return {
        _id:`lau_${Date.now()}_${i}`,
        action:e.action||'create', uid:e.uid??null,
        comment:useComment, content:decodedContent,
        originalContent: existing?existing.content:null,
        keys:useKeys, secondary_keys:useSecondaryKeys,
        order:   existing?(existing.order??100)  :(e.order??500),
        depth:   existing?(existing.depth??4)    :(e.depth??4),
        position:existing?(existing.position??0) :(e.position??0),
        confidence: e.confidence||'medium',
        _existingMeta: existing?{
          constant:existing.constant, selective:existing.selective,
          addMemo:existing.addMemo, disable:existing.disable,
          role:existing.role, strategy:existing.strategy,
          secondary_key:existing.secondary_key,
        }:null,
        reason:e.reason||'',
        targetBook: bookName||(e.uid!=null&&uidBook[e.uid])?
          (bookName||uidBook[e.uid]):(s.selectedBooks[0]||''),
        applied:false,
      };
    });
  }

  // ─── Diff ─────────────────────────────────────────────────────────────────

  function computeDiff(original, updated) {
    if(!original) return `<span class="lau-diff-add">${esc(updated)}</span>`;
    if(original === updated) return `<span class="lau-diff-same">${esc(updated)}</span>`;

    const origLines = original.split('\n');
    const newLines  = updated.split('\n');

    // Find longest common prefix (line-by-line)
    let pi = 0;
    while(pi < origLines.length && pi < newLines.length && origLines[pi] === newLines[pi]) pi++;

    // Find longest common suffix (not overlapping the prefix)
    let si = 0;
    const maxSi = Math.min(origLines.length - pi, newLines.length - pi);
    while(si < maxSi && origLines[origLines.length-1-si] === newLines[newLines.length-1-si]) si++;

    const commonPrefixLines = origLines.slice(0, pi);
    const commonSuffixLines = si > 0 ? origLines.slice(origLines.length - si) : [];
    const removedMid        = origLines.slice(pi, si > 0 ? origLines.length - si : origLines.length);
    const addedMid          = newLines.slice(pi, si > 0 ? newLines.length - si : newLines.length);

    const parts = [];

    // Common prefix — shown dimmed
    if(commonPrefixLines.length) {
      // Only show last 3 lines of prefix to save space
      const shown = commonPrefixLines.slice(-3);
      if(commonPrefixLines.length > 3) parts.push('<span class="lau-diff-same" style="color:#334155">… (unchanged) …\n</span>');
      parts.push(`<span class="lau-diff-same">${esc(shown.join('\n'))}\n</span>`);
    }

    // Removed lines (only show if the content genuinely shrank — shouldn't happen but show for safety)
    if(removedMid.length && addedMid.length === 0) {
      parts.push(`<span class="lau-diff-del">${esc(removedMid.join('\n'))}</span>`);
    }

    // Added/changed lines — the interesting part
    if(addedMid.length) {
      if(removedMid.length > 0) {
        // Lines were changed: show word-level diff
        const wordD = wordLevelDiff(removedMid.join('\n'), addedMid.join('\n'));
        parts.push(wordD);
      } else {
        // Pure additions: highlight everything green
        parts.push(`<span class="lau-diff-add">${esc(addedMid.join('\n'))}</span>`);
      }
    }

    // Common suffix — shown dimmed (first 2 lines only)
    if(commonSuffixLines.length) {
      const shown = commonSuffixLines.slice(0, 2);
      parts.push(`\n<span class="lau-diff-same">${esc(shown.join('\n'))}${commonSuffixLines.length > 2 ? '\n… (unchanged)' : ''}</span>`);
    }

    // If nothing changed visually (edge case), show the whole new content
    if(!parts.length) return `<span class="lau-diff-same">${esc(updated)}</span>`;

    return parts.join('');
  }

  function wordLevelDiff(oldText, newText) {
    // Simple: highlight words in newText that aren't in oldText
    const oldWords = new Set(oldText.split(/\s+/).filter(Boolean));
    const newWords = newText.split(/(\s+)/);
    return newWords.map(w => {
      if(/^\s+$/.test(w)) return w;
      if(!oldWords.has(w)) return `<span class="lau-diff-add">${esc(w)}</span>`;
      return `<span class="lau-diff-same">${esc(w)}</span>`;
    }).join('');
  }

  // ─── Scan history ─────────────────────────────────────────────────────────

  function loadHistory() {
    try{ return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]'); }catch{ return []; }
  }

  function saveHistory(scans) {
    try{ localStorage.setItem(HISTORY_KEY, JSON.stringify(scans.slice(-MAX_HISTORY))); }catch{}
  }

  function pushHistory(entry) {
    const h = loadHistory();
    h.push(entry);
    saveHistory(h);
  }

  // ─── Core scan ────────────────────────────────────────────────────────────

  async function runScan() {
    if(scanning) return;
    scanning=true;
    setScanBtn(false);
    resetStats();
    setScanInfo('','');

    try {
      const s=getSettings();
      if(!s.selectedBooks.length){ setScanInfo('⚠️ No lorebooks selected.','warn'); return; }

      setScanInfo('📂 Loading lorebooks…','info');
      const books={};
      const failed=[];
      for(const name of s.selectedBooks){
        const data=await serverGetBook(name);
        if(data) books[name]=data;
        else failed.push(name);
      }
      const bookCount=Object.keys(books).length;
      const totalEntries=Object.values(books).reduce((n,b)=>n+Object.keys(b.entries||{}).length,0);
      if(!bookCount){ setScanInfo('❌ Could not load lorebooks.','err'); return; }
      if(failed.length) setScanInfo(`⚠️ Loaded ${bookCount} book(s). Failed: ${failed.join(', ')}`,'warn');

      const c=ctx();
      const chat=c.chat||[];
      const count=Math.max(1,s.messageScanCount);
      const msgs=chat.slice(-count).filter(m=>m&&m.mes&&!m.is_system)
        .map(m=>`${m.is_user?(c.name1||'User'):(m.name||c.name2||'AI')}: ${m.mes}`);
      if(!msgs.length){ setScanInfo('⚠️ No chat messages found.','warn'); return; }

      setStats({books:bookCount,entries:totalEntries,msgs:msgs.length,suggested:null});

      let entries=[];
      if(s.scanMode==='precise'){
        entries=await runScanPrecise(books,msgs,bookCount);
      } else {
        entries=await runScanFast(books,msgs);
      }

      if(!entries.length){ setScanInfo('ℹ️ Nothing new to add or update.','info'); return; }

      previewData=entries;
      snapBooks=books;
      renderMemoryPanel();

      const cn=entries.filter(e=>e.action==='create').length;
      const un=entries.filter(e=>e.action==='update').length;
      const low=entries.filter(e=>e.confidence==='low').length;

      setStats({books:bookCount,entries:totalEntries,msgs:msgs.length,suggested:entries.length});
      setScanInfo(`✅ ${cn} new · ${un} updated${low?` · ⚠️ ${low} low-confidence`:''}`,  'ok');
      updateReopenBtn();
      openPopup();

      pushHistory({
        date:new Date().toISOString(),
        books:Object.keys(books),
        msgs:msgs.length,
        created:cn, updated:un,
        applied:0,
      });

    } catch(err) {
      setScanInfo('❌ '+err.message,'err');
      console.error('[LAU]',err);
    } finally {
      scanning=false;
      setScanBtn(true);
    }
  }

  async function runScanPrecise(books, msgs, bookCount) {
    const s=getSettings();
    const all=[];
    let i=0;
    for(const[bookName,bookData]of Object.entries(books)){
      i++;
      setScanInfo(`🤖 Scanning book ${i}/${bookCount}: "${bookName}"…`,'info');
      const meta=getBookMeta(bookName);
      const prompt=buildBookPrompt(bookName,bookData,msgs,meta,books);
      try{
        const raw=await aiGenerate(prompt);
        if(!raw?.trim()) continue;
        const entries=parseResponse(raw,books,bookName);
        all.push(...entries);
      }catch(err){
        console.error(`[LAU] Book "${bookName}" scan failed:`,err);
        setScanInfo(`⚠️ Book "${bookName}" failed: ${err.message}`,'warn');
      }
    }
    return all;
  }

  async function runScanFast(books, msgs) {
    const s=getSettings();
    setScanInfo('🤖 Asking AI (fast mode)…','info');

    // Build a combined prompt for all books
    const lines=[s.prompt||BASE_PROMPT];
    for(const[bookName,bookData]of Object.entries(books)){
      const meta=getBookMeta(bookName);
      const tag=meta?.tag||'world';
      const tagInfo=BOOK_TAGS[tag]||BOOK_TAGS.world;
      const locked=meta?.lockedUids||[];
      const entries=Object.values(bookData?.entries||{});
      lines.push(`\n====== LOREBOOK: "${bookName}" [${tagInfo.emoji} ${tagInfo.label}] — ${tagInfo.hint} ======`);
      entries.forEach(e=>{
        const lockMark=locked.includes(e.uid)?' 🔒 LOCKED':'' ;
        lines.push(`\n>>>>> ENTRY_START uid:${e.uid} <<<<<`);
        lines.push(`TITLE: ${e.comment||'(no title)'}${lockMark}`);
        lines.push(`META: order:${e.order??'?'} depth:${e.depth??'?'} position:${e.position??'?'}`);
        if((e.key||[]).length) lines.push(`EXISTING_KEYS: ${JSON.stringify(e.key)}`);
        if(e.content){const enc=e.content.replace(/\r\n/g,'[NL]').replace(/\n/g,'[NL]');lines.push('FULL_CONTENT (newlines=[NL]):');lines.push(enc);}
        lines.push(`<<<<< ENTRY_END uid:${e.uid} >>>>>`);
      });
    }
    lines.push(`\n=== RECENT CHAT (last ${msgs.length} messages) ===`);
    lines.push(msgs.join('\n\n'));
    lines.push('\nSuggest lorebook actions. Respond with JSON only.');

    const raw=await aiGenerate(lines.join('\n'));
    if(!raw?.trim()) return[];
    return parseResponse(raw,books,null);
  }

  // ─── Auto-scan ────────────────────────────────────────────────────────────

  function onMessage(){
    const s=getSettings();
    if(!s.autoEnabled) return;
    autoCounter++;
    if(autoCounter>=s.autoInterval){autoCounter=0;runScan();}
  }

  // ─── Mount UI ─────────────────────────────────────────────────────────────

  function mountUI() {
    if($('#lau-block').length) return;
    const $ext=$('#extensions_settings2, #extensions_settings').first();
    if(!$ext.length){console.error('[LAU] #extensions_settings not found');return;}

    $ext.append(`
<div class="lau-block" id="lau-block">

  <div class="lau-hdr" id="lau-hdr">
    <span>📖</span>
    <span class="lau-hdr-title">Lorebook Auto-Updater</span>
    <span id="lau-chev" class="lau-hdr-chev">▾</span>
  </div>

  <div class="lau-body" id="lau-body">

    <div class="lau-main-row">

      <!-- Left: lorebook list -->
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

      <!-- Right: scan controls -->
      <div class="lau-col-scan">
        <div class="lau-sec-label">🚀 Scan</div>
        <div class="lau-scan-msg-row">
          <span class="lau-scan-lbl">Last</span>
          <input type="number" class="lau-num-input" id="lau-count" min="1" max="500"/>
          <span class="lau-scan-lbl">msgs</span>
        </div>
        <div class="lau-check-row" style="margin-bottom:4px;font-size:0.78em">
          <input type="radio" name="lau-mode" id="lau-mode-precise" value="precise"/>
          <label for="lau-mode-precise" title="One AI call per book — more accurate">🎯 Precise</label>
          <input type="radio" name="lau-mode" id="lau-mode-fast" value="fast" style="margin-left:8px"/>
          <label for="lau-mode-fast" title="One AI call for all books — faster">⚡ Fast</label>
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
      <div id="lau-memory-list" style="font-size:0.75em;color:#64748b;padding:4px 2px;max-height:160px;overflow-y:auto;line-height:1.7">
        <em>No data in memory yet.</em>
      </div>
      <div class="lau-btn-row" style="margin-top:4px">
        <button class="lau-btn lau-btn-xs" id="lau-memory-reload">🔄 Reload</button>
        <button class="lau-btn lau-btn-xs" id="lau-memory-clear" style="color:#f87171">🗑 Clear</button>
      </div>
    </div>

    <!-- History panel -->
    <div class="lau-settings-toggle" id="lau-history-hdr">
      🕓 History <span id="lau-history-chev">▾</span>
    </div>
    <div id="lau-history-body" style="display:none;padding:4px 0 6px 0">
      <div id="lau-history-list" style="font-size:0.75em;color:#64748b;padding:4px 2px;max-height:160px;overflow-y:auto"></div>
    </div>

    <!-- Settings toggle -->
    <div class="lau-settings-toggle" id="lau-settings-hdr">
      ⚙️ Settings <span id="lau-settings-chev">▾</span>
    </div>
    <div id="lau-settings-body" style="display:none;padding:8px 0">
      <div class="lau-check-row" style="margin-bottom:6px">
        <input type="checkbox" id="lau-auto"/>
        <label for="lau-auto">Auto-scan every</label>
        <input type="number" class="lau-num-input" id="lau-interval" min="1" max="200" style="width:52px"/>
        <label>messages</label>
      </div>
      <div class="lau-sec-label">🤖 AI Prompt (base)</div>
      <textarea class="lau-prompt-area" id="lau-prompt"></textarea>
      <div class="lau-btn-row" style="margin-top:5px">
        <button class="lau-btn lau-btn-xs" id="lau-reset-prompt">↩️ Reset to default</button>
      </div>
    </div>

  </div>
</div>`);

    const s=getSettings();
    $('#lau-count').val(s.messageScanCount);
    $('#lau-interval').val(s.autoInterval);
    $('#lau-auto').prop('checked',!!s.autoEnabled);
    $('#lau-prompt').val(s.prompt||BASE_PROMPT);
    $(`#lau-mode-${s.scanMode||'precise'}`).prop('checked',true);
    if(collapsed) $('#lau-body').hide();

    populateBookList();
    wireUI();
    resetStats();
  }

  // ─── Book list with tags ──────────────────────────────────────────────────

  async function populateBookList() {
    const $list=$('#lau-books-list');
    $list.html('<div class="lau-books-msg">🔄 Loading…</div>');
    const names=await serverGetNames();
    const s=getSettings();
    $list.empty();
    if(!names.length){
      $list.html('<div class="lau-books-msg lau-books-err">No lorebooks found.<br><small>Check console F12</small></div>');
      return;
    }
    names.forEach(name=>{
      const on=s.selectedBooks.includes(name);
      const meta=getBookMeta(name);
      const tag=meta.tag||'world';
      const tagInfo=BOOK_TAGS[tag]||BOOK_TAGS.world;
      const desc=meta.description||'';
      const $r=$(`
<div class="lau-book-row${on?' lau-on':''}" data-n="${esc(name)}">
  <span class="lau-ck">${on?'☑':'☐'}</span>
  <span class="lau-bname">${esc(name)}</span>
  <span class="lau-book-tag" data-book="${esc(name)}" title="Click to change role">${tagInfo.emoji}</span>
</div>`);

      // Expand row to show tag/description editor
      const $editor=$(`
<div class="lau-book-editor" data-book="${esc(name)}" style="display:none;padding:6px 8px 8px 28px;border-bottom:1px solid rgba(255,255,255,0.05)">
  <div style="font-size:0.72em;color:#64748b;margin-bottom:4px">Role</div>
  <select class="lau-f-select lau-book-tag-sel" data-book="${esc(name)}" style="margin-bottom:6px;font-size:0.8em">
    ${Object.entries(BOOK_TAGS).map(([k,v])=>`<option value="${k}" ${tag===k?'selected':''}>${v.emoji} ${v.label}</option>`).join('')}
  </select>
  <div style="font-size:0.72em;color:#64748b;margin-bottom:4px">Description (optional)</div>
  <input type="text" class="lau-f-input lau-book-desc-inp" data-book="${esc(name)}" placeholder="E.g.: Contains lore about the demon race only" value="${esc(desc)}" style="font-size:0.78em"/>
</div>`);

      $r.find('.lau-book-tag').on('click',function(ev){
        ev.stopPropagation();
        $editor.slideToggle(140);
      });
      $r.on('click',function(ev){
        if($(ev.target).hasClass('lau-book-tag')) return;
        const n=String($(this).data('n'));
        const sl=getSettings().selectedBooks;
        const i=sl.indexOf(n);
        if(i===-1){sl.push(n);$(this).addClass('lau-on').find('.lau-ck').text('☑');}
        else{sl.splice(i,1);$(this).removeClass('lau-on').find('.lau-ck').text('☐');}
        save();
      });
      $list.append($r).append($editor);
    });

    // Tag selector change
    $list.find('.lau-book-tag-sel').on('change',function(){
      const n=String($(this).data('book'));
      const m=getBookMeta(n);
      m.tag=$(this).val();
      save();
      // Update emoji in row
      const tagInfo=BOOK_TAGS[m.tag]||BOOK_TAGS.world;
      $(`.lau-book-row[data-n="${esc(n)}"] .lau-book-tag`).text(tagInfo.emoji);
    });

    // Description input change
    let descDb={};
    $list.find('.lau-book-desc-inp').on('input',function(){
      const n=String($(this).data('book'));
      const val=$(this).val();
      clearTimeout(descDb[n]);
      descDb[n]=setTimeout(()=>{getBookMeta(n).description=val;save();},400);
    });
  }

  // ─── Wire UI ──────────────────────────────────────────────────────────────

  function wireUI(){
    let _db={};
    const deb=(k,fn,ms=380)=>{clearTimeout(_db[k]);_db[k]=setTimeout(fn,ms);};

    $('#lau-hdr').on('click',()=>{collapsed=!collapsed;$('#lau-body').slideToggle(180);$('#lau-chev').text(collapsed?'▾':'▴');});

    let settingsOpen=false;
    $('#lau-settings-hdr').on('click',()=>{settingsOpen=!settingsOpen;$('#lau-settings-body').slideToggle(160);$('#lau-settings-chev').text(settingsOpen?'▴':'▾');});

    let memOpen=false;
    $('#lau-memory-hdr').on('click',()=>{memOpen=!memOpen;$('#lau-memory-body').slideToggle(160);$('#lau-memory-chev').text(memOpen?'▴':'▾');if(memOpen) renderMemoryPanel();});
    $('#lau-memory-reload').on('click',async()=>{
      const s=getSettings();
      if(!s.selectedBooks.length){alert('Select lorebooks first.');return;}
      const $btn=$('#lau-memory-reload').text('Loading…').prop('disabled',true);
      snapBooks={};
      for(const name of s.selectedBooks){const data=await serverGetBook(name);if(data) snapBooks[name]=data;}
      renderMemoryPanel();
      $btn.text('🔄 Reload').prop('disabled',false);
    });
    $('#lau-memory-clear').on('click',()=>{snapBooks={};previewData=[];renderMemoryPanel();updateReopenBtn();$('#lau-memory-count').text('');});

    let histOpen=false;
    $('#lau-history-hdr').on('click',()=>{histOpen=!histOpen;$('#lau-history-body').slideToggle(160);$('#lau-history-chev').text(histOpen?'▴':'▾');if(histOpen) renderHistoryPanel();});

    $('#lau-refresh').on('click',()=>populateBookList());
    $('#lau-all').on('click',async()=>{const names=await serverGetNames();getSettings().selectedBooks=[...names];save();$('#lau-books-list .lau-book-row').addClass('lau-on').find('.lau-ck').text('☑');});
    $('#lau-none').on('click',()=>{getSettings().selectedBooks=[];save();$('#lau-books-list .lau-book-row').removeClass('lau-on').find('.lau-ck').text('☐');});

    $('#lau-count').on('input',function(){deb('c',()=>{getSettings().messageScanCount=parseInt(this.value)||20;save();});});
    $('#lau-auto').on('change',function(){getSettings().autoEnabled=this.checked;autoCounter=0;save();});
    $('#lau-interval').on('input',function(){deb('i',()=>{getSettings().autoInterval=parseInt(this.value)||5;autoCounter=0;save();});});
    $('#lau-prompt').on('input',function(){deb('p',()=>{getSettings().prompt=this.value||BASE_PROMPT;save();});});
    $('#lau-reset-prompt').on('click',()=>{getSettings().prompt=BASE_PROMPT;$('#lau-prompt').val(BASE_PROMPT);save();});
    $('input[name="lau-mode"]').on('change',function(){getSettings().scanMode=$(this).val();save();});
    $('#lau-scan-btn').on('click',()=>{if(!scanning) runScan();});
  }

  // ─── Scan UI helpers ──────────────────────────────────────────────────────

  function setScanBtn(e){$('#lau-scan-btn').prop('disabled',!e).text(e?'🔍 Scan':'⏳ Scanning…');}

  function setScanInfo(msg,type){
    const colors={info:'#94a3b8',warn:'#f59e0b',err:'#f87171',ok:'#4ade80'};
    $('#lau-scan-info').css('color',colors[type]||'#94a3b8').text(msg);
  }

  function resetStats(){$('#lau-s-books').text('📚 —');$('#lau-s-entries').text('📝 —');$('#lau-s-msgs').text('💬 —');$('#lau-s-suggested').text('✨ —').removeClass('lau-s-highlight-on');}

  function setStats(d){
    if(d.books!=null) $('#lau-s-books').text(`📚 ${d.books} book(s) loaded`);
    if(d.entries!=null) $('#lau-s-entries').text(`📝 ${d.entries} existing entries`);
    if(d.msgs!=null) $('#lau-s-msgs').text(`💬 ${d.msgs} messages scanned`);
    if(d.suggested!=null) $('#lau-s-suggested').text(`✨ ${d.suggested} suggestion(s)`).addClass('lau-s-highlight-on');
  }

  // ─── Memory panel ─────────────────────────────────────────────────────────

  function renderMemoryPanel(){
    const books=Object.entries(snapBooks);
    const $list=$('#lau-memory-list');
    if(!books.length){
      $list.html('<em style="color:#64748b">No data in memory yet. Run a scan or click Reload.</em>');
      $('#lau-memory-count').text('');
      return;
    }
    let total=0;
    const lines=[];
    books.forEach(([name,data])=>{
      const entries=Object.values(data?.entries||{});
      const meta=getBookMeta(name);
      const tag=meta?.tag||'world';
      const tagInfo=BOOK_TAGS[tag]||BOOK_TAGS.world;
      const locked=meta?.lockedUids||[];
      total+=entries.length;
      lines.push(`<div style="margin-bottom:4px"><span style="color:#93c5fd;font-weight:bold">${tagInfo.emoji} ${esc(name)}</span> <span style="color:#475569">(${entries.length})</span></div>`);
      entries.forEach(e=>{
        const isLock=locked.includes(e.uid);
        lines.push(`<div style="padding-left:10px;display:flex;align-items:center;gap:6px">
          <button class="lau-lock-btn" data-book="${esc(name)}" data-uid="${e.uid}" title="${isLock?'Unlock':'Lock — never suggest updates'}" style="background:none;border:none;cursor:pointer;font-size:0.9em;padding:0;color:${isLock?'#f59e0b':'#475569'}">${isLock?'🔒':'🔓'}</button>
          <span style="color:${isLock?'#64748b':'#cbd5e1'};font-size:0.8em">${esc(e.comment||'—')}</span>
          <span style="color:#334155;font-size:0.72em">uid:${e.uid}</span>
        </div>`);
      });
    });
    $list.html(lines.join(''));
    $('#lau-memory-count').text(`(${books.length} books, ${total} entries)`);

    // Wire lock buttons
    $list.find('.lau-lock-btn').on('click',function(){
      const bookName=String($(this).data('book'));
      const uid=Number($(this).data('uid'));
      const nowLocked=toggleLock(bookName,uid);
      $(this).css('color',nowLocked?'#f59e0b':'#475569').text(nowLocked?'🔒':'🔓');
      $(this).next('span').css('color',nowLocked?'#64748b':'#cbd5e1');
    });
  }

  // ─── History panel ────────────────────────────────────────────────────────

  function renderHistoryPanel(){
    const history=loadHistory().reverse();
    const $list=$('#lau-history-list');
    if(!history.length){$list.html('<em style="color:#64748b">No scans recorded yet.</em>');return;}
    const lines=history.map((h,i)=>{
      const d=new Date(h.date);
      const dateStr=`${d.toLocaleDateString()} ${d.toHours?d.toLocaleTimeString():''}`;
      return `<div style="padding:5px 2px;border-bottom:1px solid rgba(255,255,255,0.05)">
        <span style="color:#64748b;font-size:0.78em">${d.toLocaleString()}</span><br>
        <span style="color:#94a3b8;font-size:0.8em">📚 ${(h.books||[]).join(', ')||'—'}</span><br>
        <span style="color:#4ade80;font-size:0.78em">+${h.created} new</span>
        <span style="color:#60a5fa;font-size:0.78em;margin-left:6px">↺ ${h.updated} updated</span>
        <span style="color:#64748b;font-size:0.78em;margin-left:6px">💬 ${h.msgs} msgs</span>
      </div>`;
    });
    $list.html(lines.join(''));
  }

  // ─── Reopen button ────────────────────────────────────────────────────────

  function updateReopenBtn(){
    const has=previewData.length>0;
    let $btn=$('#lau-reopen-btn');
    if(!has){$btn.remove();return;}
    const unapplied=previewData.filter(e=>!e.applied&&e.action!=='skip').length;
    const label=unapplied>0?`📋 Show last results (${unapplied} pending)`:'📋 Show last results';
    if(!$btn.length){
      $btn=$(`<button class="lau-btn lau-btn-xs" id="lau-reopen-btn" style="width:100%;margin-top:4px"></button>`);
      $btn.on('click',()=>openPopup());
      $('#lau-scan-info').before($btn);
    }
    $btn.text(label);
  }

  // ─── Preview popup ────────────────────────────────────────────────────────

  function openPopup(){
    $('#lau-overlay').remove();
    const bookOptHtml=Object.keys(snapBooks).map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');
    const cn=previewData.filter(e=>e.action==='create').length;
    const un=previewData.filter(e=>e.action==='update').length;
    const sn=previewData.filter(e=>e.action==='skip').length;
    const low=previewData.filter(e=>e.confidence==='low').length;

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
      ${low?`<div class="lau-tab" data-f="low">⚠️ Low conf (${low})</div>`:''}
    </div>
    <div class="lau-stats">
      <div class="lau-stat"><b class="g">${cn}</b> new</div>
      <div class="lau-stat"><b class="b">${un}</b> updated</div>
      <div class="lau-stat"><b class="gr">${sn}</b> skipped</div>
      ${low?`<div class="lau-stat"><b style="color:#f59e0b">${low}</b> low-conf</div>`:''}
    </div>
    <div class="lau-sort-bar">Sort: <select id="lau-sort"><option value="action">Action type</option><option value="name">Name A–Z</option><option value="confidence">Confidence</option></select></div>
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

    renderCards('all',bookOptHtml);
    wirePopup(bookOptHtml);
  }

  function renderCards(filter,bookOptHtml){
    const $list=$('#lau-list').empty();
    let items;
    if(filter==='low') items=previewData.filter(e=>e.confidence==='low');
    else if(filter==='all') items=previewData;
    else items=previewData.filter(e=>e.action===filter);
    if(!items.length){$list.html('<div class="lau-empty">Nothing here.</div>');return;}
    items.forEach(e=>$list.append(buildCard(e,bookOptHtml)));
    enableDrag($list[0]);
  }

  function buildCard(entry,bookOptHtml){
    const badge=entry.applied?'done':entry.action;
    const bLabel=entry.applied?'✅ applied':entry.action;
    const cClass=`c-${entry.applied?'done':entry.action}`;
    const bOpts=bookOptHtml.replace(`value="${esc(entry.targetBook)}"`,`value="${esc(entry.targetBook)}" selected`);

    const confColor={high:'#4ade80',medium:'#f59e0b',low:'#f87171'}[entry.confidence||'medium']||'#94a3b8';
    const confBadge=`<span style="font-size:0.65em;padding:1px 5px;border-radius:8px;background:rgba(0,0,0,0.3);color:${confColor};border:1px solid ${confColor}40">${entry.confidence||'?'}</span>`;

    // Build diff HTML for updates
    let diffHtml='';
    if(entry.action==='update'&&entry.originalContent!=null){
      diffHtml=`<div class="lau-diff-wrap">
        <div class="lau-f-label" style="margin-bottom:4px">📊 Diff <span style="font-size:0.8em;color:#475569">(green = added)</span></div>
        <div class="lau-diff-view">${computeDiff(entry.originalContent,entry.content)}</div>
      </div>`;
    }

    return $(`
<div class="lau-card ${cClass}" data-id="${entry._id}" draggable="true">
  <div class="lau-card-hdr">
    <span class="lau-drag-h">⠿</span>
    <span class="lau-badge b-${badge}">${bLabel}</span>
    ${confBadge}
    <span class="lau-card-name">${esc(entry.comment)}</span>
    <span class="lau-card-keys">${esc(entry.keys.slice(0,2).join(' · ')||'—')}</span>
    <span class="lau-chevron">▼</span>
  </div>
  <div class="lau-card-body">
    <div class="lau-f-group"><div class="lau-f-label">Entry title</div><input class="lau-f-input f-comment" type="text" value="${esc(entry.comment)}"/></div>
    <div class="lau-f-group"><div class="lau-f-label">Content</div><textarea class="lau-f-textarea f-content">${esc(entry.content)}</textarea></div>
    ${diffHtml}
    <div class="lau-f-row">
      <div class="lau-f-group"><div class="lau-f-label">Primary keywords</div><input class="lau-f-input f-keys" type="text" value="${esc(entry.keys.join(', '))}"/></div>
      <div class="lau-f-group"><div class="lau-f-label">Secondary keywords</div><input class="lau-f-input f-seckeys" type="text" value="${esc(entry.secondary_keys.join(', '))}"/></div>
    </div>
    <div class="lau-f-row">
      <div class="lau-f-group" style="max-width:72px"><div class="lau-f-label">Order</div><input class="lau-f-input f-order" type="number" value="${entry.order}"/></div>
      <div class="lau-f-group" style="max-width:60px"><div class="lau-f-label">Depth</div><input class="lau-f-input f-depth" type="number" value="${entry.depth??4}"/></div>
      <div class="lau-f-group" style="max-width:68px"><div class="lau-f-label">Position</div><input class="lau-f-input f-position" type="number" value="${entry.position??0}"/></div>
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

  function wirePopup(bookOptHtml){
    let af='all';
    $(document).on('click.lau','#lau-close-pop,#lau-discard',closePopup);
    $('#lau-overlay').on('click',e=>{if(e.target.id==='lau-overlay') closePopup();});
    $(document).on('click.lau','.lau-tab',function(){
      $('.lau-tab').removeClass('active');$(this).addClass('active');
      af=$(this).data('f');syncToData();renderCards(af,bookOptHtml);
    });
    $(document).on('click.lau','.lau-card-hdr',function(){$(this).closest('.lau-card').toggleClass('open');});
    $(document).on('click.lau','#lau-expand-all',()=>$('#lau-list .lau-card').addClass('open'));
    $(document).on('click.lau','#lau-collapse-all',()=>$('#lau-list .lau-card').removeClass('open'));
    $(document).on('change.lau','#lau-sort',function(){
      syncToData();
      const v=this.value;
      if(v==='name') previewData.sort((a,b)=>a.comment.localeCompare(b.comment));
      else if(v==='confidence'){const o={high:0,medium:1,low:2};previewData.sort((a,b)=>(o[a.confidence]||1)-(o[b.confidence]||1));}
      else{const o={create:0,update:1,skip:2};previewData.sort((a,b)=>(o[a.action]||0)-(o[b.action]||0));}
      renderCards(af,bookOptHtml);
    });
    $(document).on('click.lau','.lau-del',function(){
      const id=$(this).data('id'),i=previewData.findIndex(e=>e._id===id);
      if(i!==-1) previewData.splice(i,1);
      $(`#lau-list .lau-card[data-id="${id}"]`).remove();
      updateTabCounts();
    });
    $(document).on('click.lau','.lau-apply-one',async function(){
      syncToData();
      const id=$(this).data('id'),entry=previewData.find(e=>e._id===id);
      if(!entry) return;
      const $b=$(this).text('Saving…').prop('disabled',true);
      try{
        await saveEntry(entry);entry.applied=true;
        $b.text('✅ Saved');
        $(`#lau-list .lau-card[data-id="${id}"]`).removeClass('c-new c-update c-skip').addClass('c-done');
        updateReopenBtn();
      }catch(err){$b.text('❌ Error').prop('disabled',false);alert('Error: '+err.message);}
    });
    $(document).on('click.lau','#lau-apply-all',async function(){
      syncToData();
      const toApply=previewData.filter(e=>e.action!=='skip'&&!e.applied);
      if(!toApply.length){alert('Nothing to apply.');return;}
      const $b=$(this).text('Saving…').prop('disabled',true);
      let ok=0,fail=0;
      for(const e of toApply){try{await saveEntry(e);e.applied=true;ok++;}catch(err){fail++;console.error('[LAU]',e.comment,err);}}
      // Update history: mark applied count
      try{const h=loadHistory();if(h.length){h[h.length-1].applied=(h[h.length-1].applied||0)+ok;saveHistory(h);}}catch{}
      if(!fail){setScanInfo(`✅ Applied ${ok} entries.`,'ok');updateReopenBtn();closePopup();}
      else{$b.text('Retry').prop('disabled',false);alert(`Applied: ${ok} ✅  Failed: ${fail} ❌`);}
    });
  }

  function syncToData(){
    $('#lau-list .lau-card').each(function(){
      const id=$(this).data('id'),e=previewData.find(x=>x._id===id);
      if(!e) return;
      const g=s=>$(this).find(s).val();
      e.comment=g('.f-comment')||e.comment;
      e.content=g('.f-content')||e.content;
      e.keys=(g('.f-keys')||'').split(',').map(s=>s.trim()).filter(Boolean);
      e.secondary_keys=(g('.f-seckeys')||'').split(',').map(s=>s.trim()).filter(Boolean);
      e.order=parseInt(g('.f-order'))||500;
      e.depth=parseInt(g('.f-depth'))||4;
      e.position=parseInt(g('.f-position'))||0;
      e.targetBook=g('.f-book')||e.targetBook;
      e.action=g('.f-action')||e.action;
    });
  }

  function updateTabCounts(){
    $('.lau-tab').each(function(){
      const f=$(this).data('f');
      if(f==='all') $(this).text(`All (${previewData.length})`);
      else if(f==='low') $(this).text(`⚠️ Low conf (${previewData.filter(e=>e.confidence==='low').length})`);
      else $(this).text(`${f.charAt(0).toUpperCase()+f.slice(1)} (${previewData.filter(e=>e.action===f).length})`);
    });
  }

  function closePopup(){$(document).off('.lau');$('#lau-overlay').remove();}

  // ─── Save entry ───────────────────────────────────────────────────────────

  async function saveEntry(entry){
    if(entry.action==='skip') return;
    const bookName=entry.targetBook||getSettings().selectedBooks[0];
    if(!bookName) throw new Error('No target lorebook.');
    const c=ctx();
    let data=snapBooks[bookName];
    if(!data){data=await serverGetBook(bookName);if(data) snapBooks[bookName]=data;}
    if(!data) throw new Error(`Could not load "${bookName}".`);
    if(!data.entries) data.entries={};

    if(entry.action==='update'&&entry.uid!=null&&data.entries[entry.uid]){
      const ex=data.entries[entry.uid];
      ex.comment=entry.comment;
      ex.content=entry.content;
      ex.key=entry.keys;
      if(entry.secondary_keys&&entry.secondary_keys.length) ex.secondary_key=entry.secondary_keys;
      // Preserve everything else: order, depth, position, strategy, constant, etc.
    } else {
      let ne;
      if(typeof c.createWorldInfoEntry==='function') ne=c.createWorldInfoEntry(bookName,data);
      if(!ne){
        const uids=Object.keys(data.entries).map(Number).filter(n=>!isNaN(n));
        const uid=uids.length?Math.max(...uids)+1:0;
        ne={uid,key:[],secondary_key:[],comment:'',content:'',constant:false,selective:false,addMemo:false,order:500,position:0,disable:false,depth:4,role:0};
        data.entries[uid]=ne;
      }
      ne.key=entry.keys;
      ne.comment=entry.comment;
      ne.content=entry.content;
      ne.addMemo=!!entry.comment;
      ne.order=entry.order??500;
      ne.depth=entry.depth??4;
      ne.position=entry.position??0;
      if(entry._existingMeta){
        const m=entry._existingMeta;
        if(m.constant!=null)  ne.constant =m.constant;
        if(m.selective!=null) ne.selective=m.selective;
        if(m.role!=null)      ne.role     =m.role;
        if(m.strategy!=null)  ne.strategy =m.strategy;
      }
      if(entry.secondary_keys&&entry.secondary_keys.length) ne.secondary_key=entry.secondary_keys;
    }

    await c.saveWorldInfo(bookName,data);
    if(typeof c.reloadWorldInfoEditor==='function') c.reloadWorldInfoEditor(bookName,true);
    console.log('[LAU] Saved:',entry.comment,'→',bookName);
  }

  // ─── Drag sort ────────────────────────────────────────────────────────────

  function enableDrag(list){
    let dragId=null;
    list.querySelectorAll('.lau-card').forEach(card=>{
      card.addEventListener('dragstart',e=>{dragId=card.dataset.id;setTimeout(()=>card.style.opacity='0.45',0);e.dataTransfer.effectAllowed='move';});
      card.addEventListener('dragend',()=>{card.style.opacity='';list.querySelectorAll('.lau-card').forEach(c=>c.style.outline='');});
      card.addEventListener('dragover',e=>{e.preventDefault();list.querySelectorAll('.lau-card').forEach(c=>c.style.outline='');if(card.dataset.id!==dragId) card.style.outline='2px solid #3b82f6';});
      card.addEventListener('drop',e=>{
        e.preventDefault();const toId=card.dataset.id;if(dragId===toId) return;
        const fi=previewData.findIndex(x=>x._id===dragId),ti=previewData.findIndex(x=>x._id===toId);
        if(fi<0||ti<0) return;const[m]=previewData.splice(fi,1);previewData.splice(ti,0,m);
        const $d=$(`#lau-list .lau-card[data-id="${dragId}"]`),$t=$(`#lau-list .lau-card[data-id="${toId}"]`);
        if(fi<ti) $t.after($d); else $t.before($d);
        list.querySelectorAll('.lau-card').forEach(c=>c.style.outline='');
      });
    });
  }

  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  // ─── Boot ─────────────────────────────────────────────────────────────────

  jQuery(function(){
    try{
      const{eventSource,event_types}=ctx();
      eventSource.on(event_types.APP_READY,()=>mountUI());
      eventSource.on(event_types.MESSAGE_RECEIVED,onMessage);
      eventSource.on(event_types.MESSAGE_SENT,onMessage);
      console.log('[Lorebook Auto-Updater v2.0] loaded ✓');
    }catch(e){console.error('[LAU] Boot failed:',e);}
  });

})();
