/**
 * Arc Bridge Interceptor
 * Intercepts MCP tool_call messages from the bridge WebSocket and executes
 * them using Arc-compatible Chrome APIs, bypassing the official handler
 * which silently fails in Arc.
 *
 * The shim (arc-sidepanel-shim.js) detects tool_call messages and dispatches
 * them here via self._arcBridgeInterceptor.handleBridgeToolCall().
 */

const _INTERCEPTOR_VERSION = '0.5.0';
const _MAX_PAGE_TEXT = 50000;
const _STORAGE_KEY = 'claude_arc_mcp_group';

function _ok(text) {
  return { content: [{ type: 'text', text }] };
}

function _err(text) {
  return { content: [{ type: 'text', text }], is_error: true };
}

async function _queryUserTabs() {
  const all = await chrome.tabs.query({});
  return all.filter(t => {
    const u = t.url || '';
    return !u.startsWith('chrome://') &&
           !u.startsWith('chrome-extension://') &&
           !u.startsWith('arc://') &&
           !u.startsWith('about:');
  });
}

async function _buildTabContext(selectedTabId) {
  const tabs = await _queryUserTabs();
  const ctx = {
    availableTabs: tabs.map(t => ({
      tabId: t.id,
      title: t.title || '',
      url: t.url || ''
    }))
  };
  if (selectedTabId !== undefined) {
    ctx.selectedTabId = selectedTabId;
  }
  return _ok(JSON.stringify(ctx));
}

async function _getActiveTabId() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active?.id;
}

// ── Arc-compatible action helpers (v0.3) ────────────────────────────────
// These let us run page-side work via chrome.scripting (MAIN world) instead
// of the Chrome Debugger Protocol, which Arc blocks.
async function _resolveTabId(tabId) {
  let id = (typeof tabId === 'number') ? tabId : await _getActiveTabId();
  if (!id) throw new Error('No tab available.');
  await chrome.tabs.get(id); // throws if the tab is gone
  return id;
}
async function _captureBase64(targetTabId) {
  const tab = await chrome.tabs.get(targetTabId);
  await chrome.tabs.update(targetTabId, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  await new Promise(r => setTimeout(r, 250));
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
function _imageResult(base64) {
  return { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] };
}
// Like _imageResult, but flags the Arc gotcha: captureVisibleTab returns a
// stale frame for a tab that isn't the foreground tab, so a screenshot of a
// backgrounded tab can silently look "unchanged". DOM ops still work; the note
// tells the caller to trust read_page/javascript_tool over the pixels.
async function _captureWithNote(tabId) {
  const base64 = await _captureBase64(tabId);
  const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }];
  let hidden = false;
  try { hidden = await _execInPage(tabId, () => document.visibilityState === 'hidden'); } catch (e) {}
  if (hidden) content.push({ type: 'text', text: '[arc] This tab is not the foreground tab, so the screenshot may be a stale frame. Verify live state with read_page or javascript_tool.' });
  return { content };
}
async function _execInPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: 'MAIN' });
  return res ? res.result : undefined;
}

const TOOL_HANDLERS = {
  async tabs_context_mcp(args) {
    const { createIfEmpty } = args || {};
    const tabs = await _queryUserTabs();
    if (tabs.length === 0 && createIfEmpty) {
      const newTab = await chrome.tabs.create({ active: false, url: 'about:blank' });
      return _buildTabContext(newTab.id);
    }
    const activeId = await _getActiveTabId();
    return _buildTabContext(activeId);
  },

  async tabs_create_mcp(_args) {
    const newTab = await chrome.tabs.create({ active: false, url: 'about:blank' });
    return _buildTabContext(newTab.id);
  },

  async tabs_close_mcp(args) {
    const { tabId } = args || {};
    if (typeof tabId !== 'number' || !Number.isInteger(tabId)) {
      return _err('tabId must be an integer.');
    }
    try {
      await chrome.tabs.get(tabId);
    } catch {
      return _err(`Tab ${tabId} does not exist.`);
    }
    await chrome.tabs.remove(tabId);
    return _buildTabContext(await _getActiveTabId());
  },

  async navigate(args) {
    const { url, tabId, force } = args || {};
    if (!url) return _err('url is required.');
    let targetTabId = tabId;
    if (typeof targetTabId !== 'number') {
      targetTabId = await _getActiveTabId();
      if (!targetTabId) {
        const t = await chrome.tabs.create({ url, active: true });
        return _ok(`Navigated new tab ${t.id} to ${url}`);
      }
    }
    try {
      await chrome.tabs.get(targetTabId);
    } catch {
      return _err(`Tab ${targetTabId} does not exist.`);
    }
    await chrome.tabs.update(targetTabId, { url });
    if (force !== false) {
      await chrome.tabs.update(targetTabId, { active: true });
    }
    return _ok(`Navigated tab ${targetTabId} to ${url}`);
  },

  async get_page_text(args) {
    const { tabId, max_chars } = args || {};
    const limit = typeof max_chars === 'number' ? max_chars : _MAX_PAGE_TEXT;
    let targetTabId = tabId;
    if (typeof targetTabId !== 'number') {
      targetTabId = await _getActiveTabId();
    }
    if (!targetTabId) return _err('No tab available to read.');
    try {
      await chrome.tabs.get(targetTabId);
    } catch {
      return _err(`Tab ${targetTabId} does not exist.`);
    }
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: () => document.body?.innerText || '',
        world: 'MAIN'
      });
      let text = result?.result || '';
      if (text.length > limit) {
        text = text.slice(0, limit) + `\n\n[Truncated at ${limit} characters]`;
      }
      return _ok(text);
    } catch (e) {
      return _err(`Failed to read page text: ${e.message}`);
    }
  },

  // Run arbitrary JS in the page (MAIN world). Mirrors the official
  // javascript_tool's REPL semantics: the last expression's value is
  // returned, and top-level await works. Subject to the page's CSP for
  // eval() — the debugger path that bypasses CSP isn't available in Arc.
  async javascript_tool(args) {
    const { text, tabId } = args || {};
    if (!text) return _err('text (the JS to run) is required.');
    let id;
    try { id = await _resolveTabId(tabId); } catch (e) { return _err(e.message); }
    try {
      // SECURITY: eval() is intentional and load-bearing here — this tool IS an
      // arbitrary-JS REPL (same contract as the official javascript_tool); its
      // only input is the code the MCP caller explicitly asked to run.
      // The func returns ['ok'|'err', payload] so a throw inside the page never
      // surfaces as a silent null result (Chrome maps MAIN-world throws to null).
      const runner = async (code) => {
        try {
          let val;
          try { val = await (0, eval)('(async () => (' + code + '\n))()'); }
          catch (e) {
            if (e instanceof SyntaxError) val = await (0, eval)('(async () => {' + code + '\n})()');
            else throw e;
          }
          if (val === undefined) return ['ok', '__undefined__'];
          if (typeof val === 'string') return ['ok', val];
          try { return ['ok', JSON.stringify(val)]; } catch { return ['ok', String(val)]; }
        } catch (e) { return ['err', (e && e.message) || String(e)]; }
      };
      let out = await _execInPage(id, runner, [text]);
      let note = '';
      const cspBlocked = !out || (out[0] === 'err' && /unsafe-eval|Content Security Policy/i.test(out[1]));
      if (cspBlocked) {
        // Page CSP kills MAIN-world eval (e.g. docs.google.com). The ISOLATED
        // world isn't bound by page CSP: full DOM access, but no page JS vars.
        const [res] = await chrome.scripting.executeScript({ target: { tabId: id }, func: runner, args: [text], world: 'ISOLATED' });
        out = res ? res.result : null;
        note = '\n[arc] Page CSP blocked MAIN-world eval; ran in ISOLATED world instead (DOM available, page JS variables are not).';
      }
      if (!out) return _err('JS returned no result (page CSP may block eval in both worlds).');
      if (out[0] === 'err') return _err('JS threw: ' + out[1]);
      return _ok((out[1] === '__undefined__' ? 'undefined' : String(out[1])) + note);
    } catch (e) {
      return _err('JS failed: ' + (e.message || e) +
        ' — the page CSP may block eval() (the debugger path that avoids CSP is unavailable in Arc).');
    }
  },

  // Lightweight accessibility/DOM snapshot: visible interactive (or all)
  // elements with text + a stable data-arc-ref the click/hover actions can
  // target without pixel coordinates.
  async read_page(args) {
    const { tabId, filter, max_chars } = args || {};
    let id;
    try { id = await _resolveTabId(tabId); } catch (e) { return _err(e.message); }
    const cap = typeof max_chars === 'number' ? max_chars : _MAX_PAGE_TEXT;
    try {
      const items = await _execInPage(id, (flt) => {
        const sel = flt === 'interactive'
          ? 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[onclick]'
          : 'a,button,input,select,textarea,summary,label,h1,h2,h3,[role],[onclick]';
        const out = []; let i = 0;
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const ref = 'ref_' + (++i);
          el.setAttribute('data-arc-ref', ref);
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
            .replace(/\s+/g, ' ').trim().slice(0, 100);
          out.push({ ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined,
            text: text || undefined, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
          if (out.length >= 250) break;
        }
        return out;
      }, [filter || 'all']);
      let json = JSON.stringify(items);
      if (json.length > cap) json = json.slice(0, cap) + '…[truncated]';
      return _ok(json);
    } catch (e) {
      return _err('read_page failed: ' + (e.message || e));
    }
  },

  // Natural-language-ish element finder. We can't run a model in the page, so
  // we score visible elements by how well the query tokens match their text,
  // role, type, name, aria-label and placeholder, with light boosts for intent
  // words (button/link/search/input/field/checkbox). Returns up to 20 matches
  // with data-arc-ref ids usable by computer/form_input.
  async find(args) {
    const { query, tabId } = args || {};
    if (!query) return _err('query is required.');
    let id;
    try { id = await _resolveTabId(tabId); } catch (e) { return _err(e.message); }
    try {
      const items = await _execInPage(id, (q) => {
        const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
        const intent = {
          button: ['button', '[role="button"]', 'input[type="submit"]', 'input[type="button"]'],
          link: ['a[href]', '[role="link"]'],
          search: ['input[type="search"]', 'input[name*="search" i]', 'input[placeholder*="search" i]', '[role="searchbox"]'],
          input: ['input', 'textarea', 'select', '[contenteditable="true"]'],
          field: ['input', 'textarea', 'select'],
          checkbox: ['input[type="checkbox"]'],
        };
        const els = new Set(document.querySelectorAll('a,button,input,select,textarea,summary,label,[role],[onclick],[contenteditable="true"],h1,h2,h3'));
        for (const k of Object.keys(intent)) {
          if (tokens.includes(k)) for (const sel of intent[k]) document.querySelectorAll(sel).forEach(e => els.add(e));
        }
        const scored = []; let i = 0;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const tag = el.tagName.toLowerCase();
          const type = (el.type || '').toLowerCase();
          const hay = [el.innerText || el.value || '', el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '',
            el.getAttribute('name') || '', el.getAttribute('title') || '', el.getAttribute('role') || '', tag, type].join(' ').toLowerCase();
          let score = 0;
          for (const t of tokens) if (t.length > 1 && hay.includes(t)) score += 1;
          if (tokens.includes('button') && (tag === 'button' || el.getAttribute('role') === 'button' || /submit|button/.test(type))) score += 1.5;
          if (tokens.includes('link') && (tag === 'a' || el.getAttribute('role') === 'link')) score += 1.5;
          if (tokens.includes('search') && /search/.test(hay)) score += 1.5;
          if ((tokens.includes('input') || tokens.includes('field')) && /^(input|textarea|select)$/.test(tag)) score += 1;
          if (tokens.includes('checkbox') && type === 'checkbox') score += 1.5;
          if (score <= 0) continue;
          const ref = 'ref_f' + (++i);
          el.setAttribute('data-arc-ref', ref);
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 100);
          scored.push({ ref, score, tag, role: el.getAttribute('role') || undefined, text: text || undefined, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 20).map(({ score, ...rest }) => rest);
      }, [query]);
      if (!items || !items.length) return _ok('No matching elements found for: ' + query);
      return _ok(JSON.stringify(items));
    } catch (e) { return _err('find failed: ' + (e.message || e)); }
  },

  // Set a value on a form element by its data-arc-ref (from read_page/find).
  // Uses the native value setter so frameworks (React etc.) register the change.
  async form_input(args) {
    const { ref, value, tabId } = args || {};
    if (!ref) return _err('ref is required (get one from read_page or find).');
    let id;
    try { id = await _resolveTabId(tabId); } catch (e) { return _err(e.message); }
    try {
      const res = await _execInPage(id, (ref, value) => {
        const el = document.querySelector('[data-arc-ref="' + ref + '"]');
        if (!el) return { ok: false, msg: 'no element for ' + ref + ' (re-run read_page/find)' };
        const tag = el.tagName.toLowerCase();
        const type = (el.type || '').toLowerCase();
        const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        if (type === 'checkbox' || type === 'radio') {
          const want = (value === true || value === 'true' || value === 'on' || value === 1 || value === '1');
          if (el.checked !== want) { el.checked = want; fire(); }
          return { ok: true, set: el.checked };
        }
        if (tag === 'select') {
          const v = String(value); let matched = false;
          for (const opt of el.options) { if (opt.value === v || opt.text.trim() === v.trim()) { el.value = opt.value; matched = true; break; } }
          if (!matched) return { ok: false, msg: 'no option matching "' + v + '"' };
          fire(); return { ok: true, set: el.value };
        }
        if (el.isContentEditable) { el.focus(); el.textContent = String(value); fire(); return { ok: true, set: String(value) }; }
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (setter && setter.set) setter.set.call(el, String(value)); else el.value = String(value);
        fire();
        return { ok: true, set: el.value };
      }, [ref, value]);
      if (!res || !res.ok) return _err('form_input: ' + (res ? res.msg : 'failed'));
      return _ok('Set ' + ref + ' = ' + JSON.stringify(res.set));
    } catch (e) { return _err('form_input failed: ' + (e.message || e)); }
  },

  // Read console output. CDP's Runtime events aren't available in Arc, so we
  // install a console/error collector in the page on first call and read its
  // ring buffer. LIMITATION: messages emitted before this first call on a given
  // page (e.g. early page-load logs) are not retained — call it early, or
  // re-trigger the action you want to observe and read again.
  async read_console_messages(args) {
    const { tabId, pattern, onlyErrors, limit, clear } = args || {};
    let id;
    try { id = await _resolveTabId(tabId); } catch (e) { return _err(e.message); }
    try {
      await _execInPage(id, () => {
        if (window.__arcConsoleInstalled) return;
        window.__arcConsoleInstalled = true;
        const buf = window.__arcConsole = window.__arcConsole || [];
        const MAX = 500;
        const push = (type, text) => { buf.push({ type, text, ts: Date.now() }); if (buf.length > MAX) buf.shift(); };
        for (const t of ['log', 'info', 'warn', 'error', 'debug']) {
          const orig = console[t];
          if (typeof orig === 'function') console[t] = function (...a) {
            try { push(t, a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); } }).join(' ')); } catch (e) {}
            return orig.apply(this, a);
          };
        }
        window.addEventListener('error', e => push('error', (e.message || 'Error') + (e.filename ? ' @ ' + e.filename + ':' + e.lineno : '')));
        window.addEventListener('unhandledrejection', e => push('error', 'Unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)));
      });
      const msgs = await _execInPage(id, (clr) => {
        const buf = window.__arcConsole || [];
        const copy = buf.slice();
        if (clr) buf.length = 0;
        return copy;
      }, [!!clear]);
      let list = msgs || [];
      if (onlyErrors) list = list.filter(m => m.type === 'error');
      if (pattern) { let re; try { re = new RegExp(pattern, 'i'); } catch (e) { re = null; } if (re) list = list.filter(m => re.test(m.text)); }
      const lim = typeof limit === 'number' ? limit : 100;
      list = list.slice(-lim);
      if (!list.length) return _ok('(no matching console messages. Note: the Arc collector retains messages from its first invocation on this page forward; earlier page-load messages are not available.)');
      return _ok(list.map(m => '[' + m.type + '] ' + m.text).join('\n'));
    } catch (e) { return _err('read_console_messages failed: ' + (e.message || e)); }
  },

  async computer(args) {
    const { action } = args || {};
    let id;
    try { id = await _resolveTabId(args && args.tabId); } catch (e) { return _err(e.message); }
    const shot = async () => _captureWithNote(id);

    if (action === 'screenshot') {
      try { return await shot(); } catch (e) { return _err('Screenshot failed: ' + e.message); }
    }
    if (action === 'wait') {
      const s = Math.min(10, Math.max(0, Number(args.duration) || 1));
      await new Promise(r => setTimeout(r, s * 1000));
      return _ok(`Waited ${s}s.`);
    }
    if (action === 'scroll') {
      const dir = args.scroll_direction || 'down';
      const amt = (Number(args.scroll_amount) || 3) * 100;
      try {
        await _execInPage(id, (d, a) => {
          const dx = d === 'left' ? -a : d === 'right' ? a : 0;
          const dy = d === 'up' ? -a : d === 'down' ? a : 0;
          window.scrollBy(dx, dy);
        }, [dir, amt]);
        await new Promise(r => setTimeout(r, 200));
        return await shot();
      } catch (e) { return _err('Scroll failed: ' + e.message); }
    }
    if (action === 'scroll_to') {
      if (!args.ref) return _err('scroll_to needs a ref (from read_page or find).');
      try {
        const found = await _execInPage(id, (ref) => {
          const el = document.querySelector('[data-arc-ref="' + ref + '"]');
          if (!el) return false;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          return true;
        }, [args.ref]);
        if (!found) return _err('No element for ' + args.ref + ' (re-run read_page/find).');
        await new Promise(r => setTimeout(r, 300));
        return await shot();
      } catch (e) { return _err('scroll_to failed: ' + e.message); }
    }
    if (action === 'zoom') {
      try {
        const b64 = await _captureBase64(id);
        const reg = args.region || [];
        if (reg.length !== 4) return _imageResult(b64);
        const [x0, y0, x1, y1] = reg;
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const sw = Math.max(1, x1 - x0), sh = Math.max(1, y1 - y0);
        const canvas = new OffscreenCanvas(sw * 2, sh * 2);
        canvas.getContext('2d').drawImage(bmp, x0, y0, sw, sh, 0, 0, sw * 2, sh * 2);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = ''; for (let k = 0; k < buf.length; k++) bin += String.fromCharCode(buf[k]);
        return _imageResult(btoa(bin));
      } catch (e) { return _err('Zoom failed: ' + e.message); }
    }
    // Pointer + keyboard: best-effort SYNTHETIC events (isTrusted=false).
    // Works for many standard buttons/links/inputs; sites that demand
    // trusted input won't react — that requires the Chrome Debugger
    // Protocol, which Arc blocks. Pass a `ref` from read_page for the most
    // reliable targeting; otherwise screenshot coordinates are scaled by
    // devicePixelRatio.
    if (['left_click', 'right_click', 'double_click', 'hover'].includes(action)) {
      try {
        const did = await _execInPage(id, (act, ref, coord) => {
          let el = null, cx, cy;
          if (ref) { el = document.querySelector('[data-arc-ref="' + ref + '"]'); if (el) { const r = el.getBoundingClientRect(); cx = r.x + r.width / 2; cy = r.y + r.height / 2; } }
          if (!el && coord && coord.length === 2) { cx = coord[0] / (window.devicePixelRatio || 1); cy = coord[1] / (window.devicePixelRatio || 1); el = document.elementFromPoint(cx, cy); }
          if (!el) return false;
          // Emulate the full trusted-input sequence. Modern UIs (Google jsaction,
          // React 17+, Cloudflare dash) listen for POINTER events and/or check
          // event.detail/button(s); bare MouseEvents with detail:0 get ignored.
          const btn = act === 'right_click' ? 2 : 0;
          const base = { bubbles: true, cancelable: true, composed: true, view: window,
            clientX: cx, clientY: cy, button: btn, detail: 1,
            pointerId: 1, pointerType: 'mouse', isPrimary: true };
          const fire = (type, extra) => {
            const o = Object.assign({}, base, extra);
            const ev = type.startsWith('pointer') && window.PointerEvent
              ? new PointerEvent(type, o) : new MouseEvent(type, o);
            el.dispatchEvent(ev);
          };
          fire('pointermove', { buttons: 0 }); fire('mousemove', { buttons: 0 });
          fire('pointerover', { buttons: 0 }); fire('mouseover', { buttons: 0 });
          fire('pointerenter', { bubbles: false, buttons: 0 }); fire('mouseenter', { bubbles: false, buttons: 0 });
          if (act === 'hover') return true;
          const clickOnce = (detail) => {
            fire('pointerdown', { buttons: btn === 2 ? 2 : 1, detail });
            fire('mousedown', { buttons: btn === 2 ? 2 : 1, detail });
            // Trusted clicks move focus on mousedown; synthetic events don't, so
            // do it explicitly. This is what makes a click→type flow land in the
            // field the user just clicked (focusable element or its closest one).
            const focusable = el.closest('input,textarea,select,button,a[href],[contenteditable=""],[contenteditable="true"],[tabindex]') || el;
            if (typeof focusable.focus === 'function') { try { focusable.focus(); } catch (e) {} }
            fire('pointerup', { buttons: 0, detail });
            fire('mouseup', { buttons: 0, detail });
            if (btn === 2) { fire('contextmenu', { buttons: 0, detail }); return; }
            fire('click', { buttons: 0, detail });
          };
          clickOnce(1);
          if (act === 'double_click') { clickOnce(2); fire('dblclick', { buttons: 0, detail: 2 }); }
          else if (act === 'left_click' && typeof el.click === 'function') el.click();
          return true;
        }, [action, args.ref || null, args.coordinate || null]);
        if (!did) return _err('No element found at the given ref/coordinate.');
        // 450ms: dropdowns/menus animate open after click; 250ms returned
        // pre-render frames (popup invisible in the screenshot).
        await new Promise(r => setTimeout(r, 450));
        return await shot();
      } catch (e) { return _err(action + ' failed: ' + e.message); }
    }
    if (action === 'type') {
      try {
        await _execInPage(id, (txt) => {
          const el = document.activeElement;
          if (!el) return;
          if ('value' in el) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (setter && setter.set) setter.set.call(el, (el.value || '') + txt);
            else el.value = (el.value || '') + txt;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.isContentEditable) {
            document.execCommand('insertText', false, txt);
          }
        }, [args.text || '']);
        await new Promise(r => setTimeout(r, 150));
        return await shot();
      } catch (e) { return _err('type failed: ' + e.message); }
    }
    if (action === 'key') {
      try {
        await _execInPage(id, (keys) => {
          // Normalize CDP/xdotool-style names to DOM key values and include
          // keyCode/code — Google/Cloudflare handlers switch on keyCode, and
          // "Down" (instead of "ArrowDown") silently matches nothing.
          const NAME = { down: 'ArrowDown', up: 'ArrowUp', left: 'ArrowLeft', right: 'ArrowRight',
            esc: 'Escape', return: 'Enter', space: ' ', pgdn: 'PageDown', pgup: 'PageUp',
            del: 'Delete', ins: 'Insert', bs: 'Backspace' };
          const CODE = { Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
            ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Backspace: 8, Tab: 9 };
          const el = document.activeElement || document.body;
          for (const combo of String(keys).split(' ')) {
            const parts = combo.split('+');
            const raw = parts.pop();
            const key = NAME[raw.toLowerCase()] || raw;
            const mods = parts.map(m => m.toLowerCase());
            const o = { key, bubbles: true, cancelable: true, composed: true,
              keyCode: CODE[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0),
              which: CODE[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0),
              code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
              ctrlKey: mods.includes('ctrl'), shiftKey: mods.includes('shift'),
              altKey: mods.includes('alt'), metaKey: mods.includes('cmd') || mods.includes('meta') };
            el.dispatchEvent(new KeyboardEvent('keydown', o));
            if (key.length === 1) el.dispatchEvent(new KeyboardEvent('keypress', o));
            el.dispatchEvent(new KeyboardEvent('keyup', o));
          }
        }, [args.text || '']);
        await new Promise(r => setTimeout(r, 150));
        return await shot();
      } catch (e) { return _err('key failed: ' + e.message); }
    }
    return _err(`Action "${action}" isn't supported by the Arc interceptor yet.`);
  }
};

const INTERCEPTED_TOOL_NAMES = new Set(Object.keys(TOOL_HANDLERS));

self._arcBridgeInterceptor = {
  canHandle(toolName) {
    return INTERCEPTED_TOOL_NAMES.has(toolName);
  },

  async handleBridgeToolCall(parsed, sendFn) {
    const toolUseId = parsed.tool_use_id;
    const toolName = parsed.tool;
    const args = parsed.args ?? {};

    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      const msg = { type: 'tool_result', tool_use_id: toolUseId, ..._err(`Unknown tool: ${toolName}`) };
      sendFn(JSON.stringify(msg));
      return;
    }

    try {
      const result = await handler(args);
      const msg = { type: 'tool_result', tool_use_id: toolUseId, ...result };
      sendFn(JSON.stringify(msg));
    } catch (e) {
      const msg = { type: 'tool_result', tool_use_id: toolUseId, ..._err(e.message || String(e)) };
      sendFn(JSON.stringify(msg));
    }
  }
};

console.log(
  `[Arc Bridge Interceptor] v${_INTERCEPTOR_VERSION} loaded. Handling tools:`,
  [...INTERCEPTED_TOOL_NAMES].join(', ')
);
