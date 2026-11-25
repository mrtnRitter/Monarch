'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { JSDOM } = require('jsdom');
const layout = require('../media/chat_layout');

const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') {
        return {
            Uri: {
                joinPath(base, ...parts) {
                    return { path: path.posix.join(base.path, ...parts.map(part => part.path || part)) };
                },
            },
        };
    }
    return original_load.call(this, request, parent, is_main);
};
const { chat_html } = require('../src/chat_html');
Module._load = original_load;

const webview = { cspSource: 'vscode-resource:', asWebviewUri: uri => uri.path };
const html = chat_html({ webview, extension_uri: { path: '/extension' } });
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const posted = [];
const instances = new Map();
let acquire_count = 0;
window.monarch_layout = layout;
window.acquireVsCodeApi = () => {
    acquire_count += 1;
    return { postMessage: message => posted.push(JSON.parse(JSON.stringify(message))) };
};
window.monarch_chat = {
    create(options) {
        const instance = {
            options,
            messages: [],
            disposed: false,
            focus_count: 0,
            on_message(message) { this.messages.push(message); },
            focus() { this.focus_count += 1; },
            dispose() { this.disposed = true; },
        };
        instances.set(options.chat_id, instance);
        return instance;
    },
};
const post = message => options_message(message);
function options_message(message) {
    window.dispatchEvent(new window.MessageEvent('message', { data: message }));
}
function click_item(menu, label) {
    const item = [...menu.querySelectorAll('.menu-item')].find(node => node.querySelector('.item-label')?.textContent === label);
    assert.ok(item, `missing menu item ${label}`);
    item.click();
    return item;
}
function pointer_event(target, type, axis_value, pointer_id = 1, axis = 'clientX') {
    const event = new window.Event(type, { bubbles: true });
    Object.defineProperties(event, { [axis]: { value: axis_value }, pointerId: { value: pointer_id } });
    target.dispatchEvent(event);
}

try {
    const source = fs.readFileSync(path.join(__dirname, '../media/chat_host.js'), 'utf8');
    window.eval(source);
    assert.equal(acquire_count, 1, 'the host acquires the VS Code API once');
    assert.deepEqual(posted[0], { type: 'host_ready' });
    assert.equal(posted.filter(message => message.type === 'host_ready').length, 1);

    const template_root = window.document.querySelector('#area_template').content.firstElementChild;
    assert.equal(template_root.dataset.el, 'chat');
    assert.ok(template_root.querySelector('[data-el="messages"]'));
    assert.ok(template_root.querySelector('[data-el="statusbar"] [data-el="attach_menu"]'));
    assert.ok(template_root.querySelector('[data-el="close"]'));
    assert.ok(template_root.querySelector('[data-el="new_answer"]'));
    assert.ok(template_root.querySelector('[data-el="repo_menu"] [data-el="repo_filter"]'));
    assert.ok(template_root.querySelector('[data-el="repo_menu"] .repo-list'));
    assert.match(template_root.querySelector('[data-el="input"]').placeholder, /Enter = send, Shift\+Enter = new line/);
    for (const forbidden of ['header', 'agents', 'agent', 'notes', 'notes_pane']) assert.equal(template_root.querySelector(`[data-el="${forbidden}"]`), null);
    const scripts = [...window.document.querySelectorAll('script[src]')].map(script => script.getAttribute('src').split('/').at(-1));
    assert.deepEqual(scripts, ['markdown.js', 'chat_time.js', 'chat_scroll.js', 'chat_layout.js', 'chat.js', 'chat_host.js']);
    assert.match(html, /default-src 'none'; style-src vscode-resource:; img-src data:; script-src 'nonce-[0-9a-f]{32}';/);

    post({ type: 'host_init', notes_visible: false, notes_width: 220, notes_position: 'left', new_chat_position: 'left', input_height: 84 });
    assert.equal(window.document.body.classList.contains('notes-left'), true);
    assert.equal(window.document.getElementById('notes_pane').style.flexBasis, '220px');
    post({ type: 'add_area', chat_id: 'chat-a', index: 0 });
    assert.equal(instances.get('chat-a').options.input_height, 84);
    post({ type: 'init', chat_id: 'chat-a', current: 'agent-a', input_height: 999 });
    assert.ok(instances.get('chat-a').messages.some(message => message.type === 'init'));
    const focus_posts_before_add = posted.filter(message => message.type === 'focus_area').length;
    post({ type: 'add_area', chat_id: 'chat-b', index: 1 });
    assert.equal(posted.filter(message => message.type === 'focus_area').length, focus_posts_before_add, 'adding an area does not announce a new active area');
    post({ type: 'error', text: 'Still active in chat A' });
    assert.equal(instances.get('chat-a').messages.at(-1).text, 'Still active in chat A');
    assert.equal(instances.get('chat-b').messages.some(message => message.text === 'Still active in chat A'), false);
    assert.equal(instances.get('chat-b').options.input_height, 84, 'area init messages do not replace the host input height');
    instances.get('chat-a').options.post({ type: 'input_height', height: 126 });
    assert.deepEqual(posted.at(-1), { chat_id: 'chat-a', type: 'input_height', height: 126 });
    post({ type: 'add_area', chat_id: 'chat-c', index: 2 });
    assert.equal(instances.get('chat-c').options.input_height, 126, 'new areas receive the most recently reported input height');
    post({ type: 'focus_area', chat_id: 'chat-b' });
    const area_roots = ['chat-a', 'chat-b', 'chat-c'].map(id => instances.get(id).options.root);
    area_roots.forEach(root => Object.defineProperty(root, 'getBoundingClientRect', { configurable: true, value: () => ({ width: 400, height: 500 }) }));
    const area_sash = window.document.querySelector('#areas .area-sash');
    pointer_event(area_sash, 'pointerdown', 100);
    pointer_event(area_sash, 'pointermove', 150);
    assert.ok(Number(area_roots[0].style.flexGrow) > Number(area_roots[1].style.flexGrow));
    assert.equal(Number(area_roots[2].style.flexGrow), 1 / 3);
    pointer_event(area_sash, 'pointerup', 150);

    const note_group = { id: 'chat-a', repo: 'Repo A', hex: '#abc', title: 'Notes A', text: 'Initial', rev: 7 };
    post({ type: 'notes_groups', groups: [note_group] });
    let notes = window.document.getElementById('notes');
    assert.equal(notes.value, 'Initial');
    notes.focus();
    notes.setSelectionRange(2, 5);
    notes.value = 'Edited';
    notes.setSelectionRange(2, 5);
    notes.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.deepEqual(posted.at(-1), { type: 'set_notes', chat_id: 'chat-a', text: 'Edited', rev: 7 });
    post({ type: 'notes', chat_id: 'chat-a', agent: 'other-agent', text: 'Wrong note', rev: 8 });
    assert.equal(notes.value, 'Edited');

    post({ type: 'notes_groups', groups: [
        { ...note_group, text: 'Edited' },
        { id: 'chat-b', repo: 'Repo B', hex: null, title: 'Notes B', text: 'Second', rev: 9 },
        { id: 'chat-c', repo: 'Repo C', hex: '#def', title: 'Notes C', text: 'Third', rev: 11 },
    ] });
    const note_nodes = [...window.document.querySelectorAll('#notes_groups .notes-group')];
    assert.deepEqual(note_nodes.map(node => node.querySelector('.notes-group-repo').textContent), ['Repo A', 'Repo B', 'Repo C']);
    assert.equal(window.document.querySelectorAll('#notes_groups .notes-group-head').length, 3);
    assert.equal(window.document.querySelectorAll('#notes_groups .group-sash').length, 2);
    assert.equal(window.document.activeElement, notes, 'rebuilding note groups preserves textarea focus');
    assert.equal(notes.selectionStart, 2);
    assert.equal(notes.selectionEnd, 5);
    const group_sash = window.document.querySelector('#notes_groups .group-sash');
    [...window.document.querySelectorAll('#notes_groups .notes-group')].forEach(node => Object.defineProperty(node, 'getBoundingClientRect', { configurable: true, value: () => ({ height: 100 }) }));
    pointer_event(group_sash, 'pointerdown', 100, 2, 'clientY');
    pointer_event(group_sash, 'pointermove', 130, 2, 'clientY');
    assert.ok(Number(note_nodes[0].style.flexGrow) > Number(note_nodes[1].style.flexGrow));
    pointer_event(group_sash, 'pointerup', 130, 2, 'clientY');
    const notes_b = note_nodes[1].querySelector('textarea');
    notes_b.value = 'Edited B';
    notes_b.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.deepEqual(posted.at(-1), { type: 'set_notes', chat_id: 'chat-b', text: 'Edited B', rev: 9 });

    post({ type: 'notes', chat_id: 'chat-b', text: 'Fresh B', rev: 10 });
    assert.equal(instances.get('chat-b').messages.some(message => message.type === 'notes'), false);
    post({ type: 'chats', chat_id: 'chat-a', items: [
        { thread_id: 'open-a', title: 'Open A', repo: 'Repo A', updated: Date.now(), current: false },
        { thread_id: 'shared', title: 'Shared', repo: 'Repo A', updated: Date.now(), current: true },
        { thread_id: 'old', title: 'Old thread', repo: 'Repo A', updated: Date.now(), current: false },
    ] });
    post({ type: 'chats', chat_id: 'chat-b', items: [
        { thread_id: 'active-b', title: 'Active B', repo: 'Repo B', updated: Date.now(), current: true },
        { thread_id: 'shared', title: 'Shared', repo: 'Repo B', updated: Date.now(), current: false },
        { thread_id: 'other', title: 'Other thread', repo: 'Repo B', updated: Date.now(), current: false },
    ] });
    assert.equal(instances.get('chat-a').messages.some(message => message.type === 'chats'), false);
    post({ type: 'status', chat_id: 'missing', status: {} });
    assert.equal(instances.get('chat-a').messages.some(message => message.type === 'status'), false);
    post({ type: 'status', chat_id: 'chat-a', status: { busy: false } });
    assert.equal(instances.get('chat-a').messages.at(-1).type, 'status');
    post({ type: 'error', text: 'Host error' });
    assert.equal(instances.get('chat-b').messages.at(-1).type, 'error');

    const close_a = instances.get('chat-a').options.root.querySelector('[data-el="close"]');
    post({ type: 'repo', chat_id: 'chat-a', repo: { can_change: false } });
    assert.equal(close_a.title, 'Close the chat when the agent has finished and no files are staged.');
    assert.equal(close_a.disabled, true);
    post({ type: 'repo', chat_id: 'chat-a', repo: { can_change: true } });
    assert.equal(close_a.title, 'Close this chat (it stays in History)');
    assert.equal(close_a.disabled, false);
    close_a.click();
    assert.deepEqual(posted.at(-1), { type: 'close_area', chat_id: 'chat-a' });

    const history = window.document.getElementById('history');
    const history_menu = window.document.getElementById('history_menu');
    history.click();
    assert.equal(history_menu.classList.contains('hidden'), false);
    click_item(history_menu, 'Shared');
    assert.equal(instances.get('chat-a').focus_count, 1, 'history activates a thread already current in another area');
    assert.equal(posted.at(-1).type, 'focus_area');
    assert.equal(posted.at(-1).chat_id, 'chat-a');
    history.click();
    click_item(history_menu, 'Old thread');
    assert.deepEqual(posted.at(-1), { chat_id: 'chat-a', type: 'open_chat', thread_id: 'old' });
    history.click();
    const remove = history_menu.querySelector('.item-remove');
    remove.click();
    assert.equal(posted.at(-1).type, 'remove_chat');
    assert.equal(posted.at(-1).chat_id, 'chat-a');

    const new_button = window.document.getElementById('new_chat');
    new_button.click();
    assert.deepEqual(posted.at(-1), { type: 'add_chat' });
    new_button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, metaKey: true }));
    assert.deepEqual(posted.at(-1), { chat_id: 'chat-a', type: 'import_chat' });
    post({ type: 'host_init', notes_visible: false, notes_width: 220, notes_position: 'right', new_chat_position: 'right', input_height: 84 });
    assert.equal(window.document.body.classList.contains('notes-right'), true);
    post({ type: 'host_init', notes_visible: true, notes_width: 220, notes_position: 'right', new_chat_position: 'right', input_height: 84 });
    assert.equal(window.document.getElementById('notes_pane').classList.contains('hidden'), false);
    notes_toggle_click();
    assert.deepEqual(posted.at(-1), { type: 'notes_visible', visible: false });

    const copy_before = posted.filter(message => message.type === 'copy').length;
    notes.focus();
    notes.setSelectionRange(1, 4);
    const notes_copy = new window.KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'c' });
    notes.dispatchEvent(notes_copy);
    const copy_messages = posted.filter(message => message.type === 'copy');
    assert.equal(copy_messages.length, copy_before + 1, 'a notes selection is copied once by the host');
    assert.deepEqual(copy_messages.at(-1), { chat_id: 'chat-a', type: 'copy', text: 'dit' });
    const area_input = instances.get('chat-a').options.root.querySelector('[data-el="input"]');
    area_input.value = 'area text';
    area_input.focus();
    area_input.setSelectionRange(0, area_input.value.length);
    area_input.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'c' }));
    assert.equal(posted.filter(message => message.type === 'copy').length, copy_before + 1, 'area selections are left to chat.js');

    const pane = window.document.getElementById('notes_pane');
    Object.defineProperty(pane, 'offsetWidth', { configurable: true, get: () => Number.parseFloat(pane.style.flexBasis) || 0 });
    set_notes_width_for_test(pane, 220);
    const splitter = window.document.getElementById('notes_splitter');
    pointer_event(splitter, 'pointerdown', 300);
    pointer_event(splitter, 'pointermove', 250);
    assert.equal(pane.style.flexBasis, '270px');
    pointer_event(splitter, 'pointerup', 250);
    assert.deepEqual(posted.at(-1), { type: 'notes_width', width: 270 });

    window.document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    post({ type: 'remove_area', chat_id: 'chat-a' });
    assert.equal(instances.get('chat-a').disposed, true);
    assert.equal(window.document.querySelector('#areas [data-el="chat"]').dataset.el, 'chat');
    assert.equal(posted.at(-1).type, 'focus_area');
    assert.equal(posted.at(-1).chat_id, 'chat-b');

    const css = fs.readFileSync(path.join(__dirname, '../media/chat.css'), 'utf8');
    assert.match(css, /\.areas\s*\{[^}]*overflow-x:\s*auto/s);
    assert.match(css, /\.area-sash, \.group-sash\s*\{[^}]*flex:\s*0 0 4px/s);
    assert.match(css, /\.area.active\s*\{[^}]*inset 0 2px 0 var\(--vscode-focusBorder\)/);
    assert.doesNotMatch(css, /\.adjust-/);
    assert.doesNotMatch(css, /\.notes-group-arrow|\.notes-group\.expanded/);

    console.log('PASS chat HTML template and script order');
    console.log('PASS host startup, routing, active areas, history, new chat and input height');
    console.log('PASS notes groups, revisions, focus, visibility and width');
    console.log('PASS layout styles and removed legacy selectors');
} finally {
    dom.window.close();
}

function notes_toggle_click() {
    window.document.getElementById('notes_toggle').click();
}
function set_notes_width_for_test(pane, width) {
    pane.style.flexBasis = `${width}px`;
}
