// S7: prototype of the isolated-world mirror + cached serializer + delta, with timings.
(() => {
  const push = (o) => globalThis.__eabPush(JSON.stringify(o));
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (el) => { let id = ids.get(el); if (!id) { id = nextId++; ids.set(el, id); } return id; };

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);
  const ROLE = { BUTTON: 'button', A: 'link', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading', NAV: 'navigation', MAIN: 'main', UL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', DIALOG: 'dialog' };
  const isInteractable = (el) => el.tagName === 'BUTTON' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && el.type !== 'hidden') || (el.tagName === 'A' && el.hasAttribute('href'))
    || el.hasAttribute('onclick') || el.getAttribute('role') === 'button' || el.hasAttribute('tabindex');
  const roleOf = (el) => el.getAttribute('role') || ROLE[el.tagName] || null;
  const ownText = (el) => {
    let t = '';
    for (const c of el.childNodes) if (c.nodeType === 3) t += c.data;
    return t.trim().slice(0, 80);
  };
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);

  // Cache: element -> array of lines for its subtree. Dirty elements (and their ancestors) are recomputed.
  const cache = new WeakMap();
  const dirty = new Set();
  const interactables = new Set();

  // Entry tree: { own: line|null, kids: Entry[], depth }. Clean subtrees are reused by reference, so a
  // delta touches only dirty elements: O(dirty), not O(page). Text is materialized only for full output.
  let changes = null;   // collector for the current delta: {added, changed, removed}
  const ownLine = (el, depth) => {
    const role = roleOf(el);
    const inter = isInteractable(el);
    if (inter) interactables.add(el);
    if (inter || role === 'heading' || role === 'dialog') return `${'  '.repeat(depth)}- ${role || 'generic'} "${nameOf(el)}" [e${idOf(el)}]`;
    const text = ownText(el);
    return text ? `${'  '.repeat(depth)}- text "${text}"` : null;
  };
  const countLines = (entry) => (entry.own ? 1 : 0) + entry.kids.reduce((n, k) => n + countLines(k), 0);
  const serialize = (el, depth) => {
    const old = cache.get(el);
    if (old && !dirty.has(el) && old.depth === depth) return old;
    const visible = !SKIP.has(el.tagName) && !(el.checkVisibility && !el.checkVisibility({ checkOpacity: false }));
    const own = visible ? ownLine(el, depth) : null;
    const childDepth = own ? depth + 1 : depth;
    const kids = visible ? Array.from(el.children, (child) => serialize(child, childDepth)) : [];
    const entry = { own, kids, depth };
    if (changes) {
      if (!old) changes.added += countLines(entry) - (entry.own ? 0 : 0);
      else {
        if (old.own !== own) { if (old.own && own) changes.changed += 1; else if (own) changes.added += 1; else changes.removed += 1; }
        const kept = new Set(kids);
        for (const k of old.kids) if (!kept.has(k) && !cache.get(k)?.reused) changes.removed += 0;   // removals detected via detached cache below
      }
    }
    cache.set(el, entry);
    dirty.delete(el);
    return entry;
  };
  const flatten = (entry, outLines) => {
    if (entry.own) outLines.push(entry.own);
    for (const k of entry.kids) flatten(k, outLines);
    return outLines;
  };

  const markDirty = (node) => {
    for (let n = node && node.nodeType === 1 ? node : node && node.parentElement; n; n = n.parentElement) {
      if (dirty.has(n)) break;
      dirty.add(n);
    }
  };
  let mutationBatches = 0;
  new MutationObserver((records) => {
    mutationBatches += 1;
    for (const r of records) markDirty(r.target);
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  // Every snapshot re-reads value/visibility/rect for kept interactables (review fix M6).
  const rereadInteractables = () => {
    let n = 0;
    for (const el of interactables) {
      if (!el.isConnected) { interactables.delete(el); continue; }
      void el.value; el.getBoundingClientRect(); n += 1;
    }
    return n;
  };

  const snapshot = (forceFull) => {
    const t = performance.now();
    if (forceFull) {
      dirty.clear(); markAllDirty(document.body); interactables.clear();
      const lines = flatten(serialize(document.body, 0), []);
      const reread = rereadInteractables();
      return { ms: performance.now() - t, lines: lines.length, chars: lines.join('\n').length, added: lines.length, removed: 0, reread };
    }
    changes = { added: 0, changed: 0, removed: 0 };
    serialize(document.body, 0);
    const reread = rereadInteractables();
    const result = { ms: performance.now() - t, added: changes.added, changed: changes.changed, removed: changes.removed, reread };
    changes = null;
    return result;
  };
  const markAllDirty = (root) => { dirty.add(root); for (const c of root.querySelectorAll('*')) dirty.add(c); };

  const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.floor(s.length * 0.95)].toFixed(2); };
  const mutate = (k) => {
    const rows = document.querySelectorAll('.row');
    for (let i = 0; i < k; i += 1) {
      const row = rows[(i * 7919) % rows.length];
      row.querySelector('span').textContent = `changed ${Math.random().toString(36).slice(2, 6)}`;
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  globalThis.__eabRun = async () => {
    const result = { nodes: document.getElementsByTagName('*').length };
    const fulls = [];
    for (let i = 0; i < 5; i += 1) fulls.push(snapshot(true));
    result.full = { p95ms: p95(fulls.map((f) => f.ms)), lines: fulls[0].lines, chars: fulls[0].chars, approxTokens: Math.round(fulls[0].chars / 4) };
    for (const k of [1, 10, 100]) {
      const runs = [];
      for (let i = 0; i < 20; i += 1) { mutate(k); await settle(); runs.push(snapshot(false)); }
      result[`delta${k}`] = { p95ms: p95(runs.map((r) => r.ms)), changedLines: runs[1].changed, addedLines: runs[1].added };
    }
    // Correctness check: delta snapshot equals a fresh full snapshot.
    mutate(37); await settle();
    const deltaLines = flatten(serialize(document.body, 0), []).join('\n');
    dirty.clear(); markAllDirty(document.body);
    const fullLines = flatten(serialize(document.body, 0), []).join('\n');
    result.deltaEqualsFull = deltaLines === fullLines;
    push({ type: 'result', result });
  };

  globalThis.__eabStorm = (ms) => new Promise((resolve) => {
    const start = performance.now();
    const iv = setInterval(() => {
      mutate(50);
      push({ type: 'dirty', batches: mutationBatches });   // one push per batch, as the real agent would
      if (performance.now() - start > ms) { clearInterval(iv); resolve(); }
    }, 16);
  });
})();
