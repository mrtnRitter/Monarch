const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = `<!doctype html><html><body>
  <div id="notes_pane" class="notes-pane hidden"><div id="notes_splitter" class="notes-splitter"></div><textarea id="notes" placeholder="Notes for this chat …" spellcheck="false"></textarea></div>
  <div class="chat" id="chat">
    <div class="header" id="header">
      <select id="agent"></select><div id="agents"></div>
      <button id="notes_toggle" class="icon-btn" aria-pressed="false"></button>
      <div class="menu-wrap"><button id="history" class="icon-btn"></button><div id="history_menu" class="menu hidden"></div></div>
      <button id="new_chat"></button><button id="model"></button><div id="model_menu" class="menu hidden"></div>
      <button id="stop"></button><button id="send"></button><button id="attach"></button>
      <div id="attach_menu" class="menu hidden"></div><div id="co_agents"></div>
      <div id="co_credits"></div><div id="credits"></div><div id="statusbar"></div>
    </div>
    <div id="messages" class="messages"></div>
    <div class="input-area"><div id="attachments"></div><div id="splitter"></div><textarea id="input"></textarea></div>
  </div>
</body></html>`;
const timers = new Set();
const passed = [];
const failed = [];
let dom;
let posted;
let dispatch;

function check(name, callback) {
  try {
    callback();
    passed.push(name);
  } catch (error) {
    failed.push({ name, error });
  }
}

try {
  dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const original_set_interval = window.setInterval.bind(window);
  window.setInterval = (callback, delay, ...args) => {
    const timer = original_set_interval(callback, delay, ...args);
    timers.add(timer);
    return timer;
  };
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: message => posted.push(JSON.parse(JSON.stringify(message))) });
  dispatch = data => window.dispatchEvent(new window.MessageEvent('message', { data }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
  const notes_pane = window.document.getElementById('notes_pane');
  const notes_splitter = window.document.getElementById('notes_splitter');
  let notes_offset_width = 300;
  Object.defineProperty(notes_pane, 'offsetWidth', { configurable: true, get: () => notes_offset_width });
  notes_splitter.setPointerCapture = () => {};
  const pointer_event = (type, clientX, pointerId = 1) => {
    const event = new window.Event(type, { bubbles: true });
    Object.defineProperties(event, { clientX: { value: clientX }, pointerId: { value: pointerId } });
    return event;
  };
  window.eval(fs.readFileSync(path.join(__dirname, '../media/markdown.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../media/chat.js'), 'utf8'));

  const init = {
    type: 'init', agents: [{ id: 'agent-1', name: 'Agent', initials: 'A' }], current: 'agent-1',
    current_name: 'Agent', user: null, signed_in: false, notes_visible: false, notes_position: 'left', notes_width: 300,
  };
  check('notes pane fixture matches production markup', () => {
    const pane_pattern = /<div id="notes_pane"[^>]*><div id="notes_splitter"[^>]*><\/div><textarea id="notes"[^>]*><\/textarea><\/div>/;
    const production_html = fs.readFileSync(path.join(__dirname, '../src/chat_view.js'), 'utf8');
    assert.equal(html.match(pane_pattern)?.[0], production_html.match(pane_pattern)?.[0]);
  });
  check('notes pane sizing and splitter styles preserve controls', () => {
    const css = fs.readFileSync(path.join(__dirname, '../media/chat.css'), 'utf8');
    assert.match(css, /\.notes-pane\s*\{[^}]*flex:\s*0 0 40%;[^}]*min-width:\s*120px;[^}]*background:\s*var\(--vscode-sideBar-background\)/s);
    assert.match(css, /\.notes-splitter\s*\{[^}]*position:\s*absolute;[^}]*width:\s*7px;[^}]*left:\s*-4px;[^}]*z-index:\s*2;/s);
    assert.match(css, /body\.notes-left \.notes-splitter\s*\{[^}]*right:\s*-4px;/);
    assert.match(css, /\.hidden\s*\{[^}]*display:\s*none\s*!important;/);
    assert.match(css, /#notes\s*\{[^}]*padding:\s*var\(--pad\)/s);
  });
  dispatch(init);
  check('init hides notes when notes_visible is false', () => {
    assert.equal(window.document.getElementById('notes_pane').classList.contains('hidden'), true);
  });
  check('notes input is ignored until a notes revision arrives', () => {
    const notes = window.document.getElementById('notes');
    notes.value = 'early edit';
    notes.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(posted.some(message => message.type === 'set_notes'), false);
  });
  check('init applies the left notes position', () => {
    assert.equal(window.document.body.classList.contains('notes-left'), true);
    assert.equal(window.document.body.classList.contains('notes-right'), false);
  });
  check('init applies notes width', () => {
    assert.equal(notes_pane.style.flexBasis, '300px');
  });
  check('right notes splitter resizes, saves width, and stops after capture loss', () => {
    dispatch({ type: 'notes_position', position: 'right' });
    notes_splitter.dispatchEvent(pointer_event('pointerdown', 500));
    notes_splitter.dispatchEvent(pointer_event('pointermove', 450));
    assert.equal(notes_pane.style.flexBasis, '350px');
    notes_offset_width = 347;
    notes_splitter.dispatchEvent(pointer_event('lostpointercapture', 450));
    assert.deepEqual(posted.filter(message => message.type === 'notes_width').at(-1), { type: 'notes_width', width: 347 });
    assert.equal(notes_splitter.classList.contains('dragging'), false);
    notes_splitter.dispatchEvent(pointer_event('pointermove', 400));
    assert.equal(notes_pane.style.flexBasis, '347px');
  });
  check('left notes splitter resizes in the opposite direction', () => {
    dispatch({ ...init, notes_width: 300 });
    notes_offset_width = 300;
    notes_splitter.dispatchEvent(pointer_event('pointerdown', 500, 2));
    notes_splitter.dispatchEvent(pointer_event('pointermove', 450, 2));
    assert.equal(notes_pane.style.flexBasis, '250px');
    notes_offset_width = 250;
    notes_splitter.dispatchEvent(pointer_event('lostpointercapture', 450, 2));
  });
  check('notes width is capped initially and after resizing the window', () => {
    dispatch({ ...init, notes_width: 800 });
    assert.equal(notes_pane.style.flexBasis, '700px');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(notes_pane.style.flexBasis, '420px');
  });
  check('pointerup and pointercancel clear active drag listeners', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    dispatch({ ...init, notes_width: 300, notes_position: 'right' });
    notes_offset_width = 300;
    for (const [pointerId, endType] of [[3, 'pointerup'], [4, 'pointercancel']]) {
      const posts_before = posted.filter(message => message.type === 'notes_width').length;
      notes_splitter.dispatchEvent(pointer_event('pointerdown', 500, pointerId));
      assert.equal(notes_splitter.classList.contains('dragging'), true);
      notes_splitter.dispatchEvent(pointer_event(endType, 500, pointerId));
      assert.equal(notes_splitter.classList.contains('dragging'), false);
      const posts_after = posted.filter(message => message.type === 'notes_width').length;
      assert.equal(posts_after, posts_before + 1);
      notes_splitter.dispatchEvent(pointer_event('lostpointercapture', 500, pointerId));
      assert.equal(posted.filter(message => message.type === 'notes_width').length, posts_after);
      const width = notes_pane.style.flexBasis;
      notes_splitter.dispatchEvent(pointer_event('pointermove', 450, pointerId));
      assert.equal(notes_pane.style.flexBasis, width);
    }
  });
  check('toggle shows notes and reports visibility', () => {
    window.document.getElementById('notes_toggle').click();
    const toggle = window.document.getElementById('notes_toggle');
    assert.equal(window.document.getElementById('notes_pane').classList.contains('hidden'), false);
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(toggle.classList.contains('active'), true);
    assert.deepEqual(posted.filter(message => message.type === 'notes_visible').at(-1), { type: 'notes_visible', visible: true });
    assert.equal(window.document.activeElement.id, 'notes');
  });
  check('notes message fills the textarea and edits use its revision', () => {
    dispatch({ type: 'notes', text: 'Saved note', rev: 7, agent: 'agent-1' });
    const notes = window.document.getElementById('notes');
    assert.equal(notes.value, 'Saved note');
    notes.value = 'Updated note';
    notes.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.deepEqual(posted.filter(message => message.type === 'set_notes').at(-1), { type: 'set_notes', text: 'Updated note', rev: 7 });
  });
  check('notes for another agent are ignored', () => {
    dispatch({ type: 'notes', text: 'Wrong agent', rev: 8, agent: 'agent-2' });
    const notes = window.document.getElementById('notes');
    assert.equal(notes.value, 'Updated note');
    notes.value = 'After ignored note';
    notes.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.deepEqual(posted.filter(message => message.type === 'set_notes').at(-1), { type: 'set_notes', text: 'After ignored note', rev: 7 });
  });
  check('notes position message switches to right only', () => {
    dispatch({ type: 'notes_position', position: 'right' });
    assert.equal(window.document.body.classList.contains('notes-left'), false);
    assert.equal(window.document.body.classList.contains('notes-right'), true);
  });
  check('model rows do not expose a credit-factor tooltip', () => {
    dispatch({ type: 'models', default: { provider: 'demo', name: 'model', reasoning: 'high' }, models: [{ provider: 'demo', name: 'model', display: 'Demo model', provider_name: 'Demo', factor: 2, levels: ['high'] }] });
    window.document.getElementById('model').click();
    const row = window.document.querySelector('#model_menu .model-row');
    assert.ok(row);
    assert.equal(row.hasAttribute('title'), false);
    assert.equal(row.querySelector('.item-factor').textContent, '2×');
  });
} catch (error) {
  failed.push({ name: 'test setup', error });
} finally {
  for (const timer of timers) clearInterval(timer);
  if (dom) dom.window.close();
}

for (const name of passed) console.log(`PASS ${name}`);
for (const { name, error } of failed) console.error(`FAIL ${name}: ${error.message}`);
console.log(`${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
