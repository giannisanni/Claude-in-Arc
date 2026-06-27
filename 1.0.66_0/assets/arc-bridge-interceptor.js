/**
 * Arc Bridge Interceptor
 * Intercepts MCP tool_call messages from the bridge WebSocket and executes
 * them using Arc-compatible Chrome APIs, bypassing the official handler
 * which silently fails in Arc.
 *
 * The shim (arc-sidepanel-shim.js) detects tool_call messages and dispatches
 * them here via self._arcBridgeInterceptor.handleBridgeToolCall().
 */

const _INTERCEPTOR_VERSION = '0.3.1';
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
      const out = await _execInPage(id, async (code) => {
        let val;
        try { val = await (0, eval)('(async () => (' + code + '\n))()'); }
        catch (e) {
          if (e instanceof SyntaxError) val = await (0, eval)('(async () => {' + code + '\n})()');
          else throw e;
        }
        if (val === undefined) return '__undefined__';
        if (typeof val === 'string') return val;
        try { return JSON.stringify(val); } catch { return String(val); }
      }, [text]);
      return _ok(out === '__undefined__' ? 'undefined' : String(out));
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

  async computer(args) {
    const { action } = args || {};
    let id;
    try { id = await _resolveTabId(args && args.tabId); } catch (e) { return _err(e.message); }
    const shot = async () => _imageResult(await _captureBase64(id));

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
          const o = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
          if (act === 'hover') { el.dispatchEvent(new MouseEvent('mousemove', o)); el.dispatchEvent(new MouseEvent('mouseover', o)); return true; }
          el.dispatchEvent(new MouseEvent('mousedown', o));
          // Trusted clicks move focus on mousedown; synthetic events don't, so
          // do it explicitly. This is what makes a click→type flow land in the
          // field the user just clicked (focusable element or its closest one).
          const focusable = el.closest('input,textarea,select,button,a[href],[contenteditable=""],[contenteditable="true"],[tabindex]') || el;
          if (typeof focusable.focus === 'function') { try { focusable.focus(); } catch (e) {} }
          el.dispatchEvent(new MouseEvent('mouseup', o));
          if (act === 'right_click') { el.dispatchEvent(new MouseEvent('contextmenu', o)); return true; }
          el.dispatchEvent(new MouseEvent('click', o));
          if (act === 'double_click') el.dispatchEvent(new MouseEvent('dblclick', o));
          else if (typeof el.click === 'function') el.click();
          return true;
        }, [action, args.ref || null, args.coordinate || null]);
        if (!did) return _err('No element found at the given ref/coordinate.');
        await new Promise(r => setTimeout(r, 250));
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
          const el = document.activeElement || document.body;
          for (const combo of String(keys).split(' ')) {
            const key = combo.split('+').pop();
            el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
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
