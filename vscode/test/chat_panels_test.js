'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const config = { notesPosition: undefined, newChatPosition: undefined };
const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ path: [base?.path || '', ...parts].join('/') }) },
    workspace: { getConfiguration: () => ({ get: key => config[key] }) },
};
const repo_colors = [0, 1, 2, 3, 4, 5].map(slot => ({ icon: `repo_${slot}.svg`, theme: `theme_${slot}`, hex: `#${slot}` }));
const workspace = {
    make_repo_colors(memento, in_use) {
        const assigned = { ...(memento.get('monarch.repoColors') || {}) };
        const slot = name => {
            const key = name.toLowerCase();
            if (Object.hasOwn(assigned, key)) return assigned[key];
            const used = new Set(in_use().map(repo => assigned[repo.toLowerCase()]).filter(Number.isInteger));
            const next = repo_colors.findIndex((_, index) => !used.has(index));
            assigned[key] = next < 0 ? 0 : next;
            memento.update('monarch.repoColors', assigned);
            return assigned[key];
        };
        return { slot, color: name => repo_colors[slot(name)], peek: name => Object.hasOwn(assigned, name.toLowerCase()) ? repo_colors[assigned[name.toLowerCase()]] : null };
    },
};

class FakeChatView {
    constructor(context, client, oauth, options = {}) {
        this.options = options;
        this.id = `chat-${FakeChatView.next++}`;
        this.agent_id = options.agent_id || null;
        this.repo = options.repo || { name: 'A', uri: { fsPath: '/r/A' } };
        this.sessions = new Map();
        this.attached_ports = [];
        this.received = [];
        this.value = { id: this.id, repo: this.repo.name, title: null, thread_id: null, state: 'idle', agent_id: this.agent_id };
        this.notes = { id: this.id, repo: this.repo.name, hex: '#0', title: this.id, text: '', rev: 0 };
        this.dispose_calls = 0;
        this.apply_calls = [];
        this.stop_calls = [];
        this.apply_result = true;
    }
    attach(port) {
        this.attached_ports.push(port);
        this.port = port;
        port.webview.onDidReceiveMessage(message => this.received.push(message));
    }
    summary() { return { ...this.value }; }
    current_repo() { return this.repo; }
    notes_entry() { return this.notes; }
    apply_notes(text, rev) { this.apply_calls.push([text, rev]); return this.apply_result; }
    _repo_info(session) { return { can_change: session?.can_change ?? true }; }
    new_chat() { this.new_chat_calls = (this.new_chat_calls || 0) + 1; }
    stop() { this.stop_chat_calls = (this.stop_chat_calls || 0) + 1; }
    dispose() { this.dispose_calls += 1; }
}
FakeChatView.next = 1;

const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    if (request === './workspace' && parent?.filename.endsWith('/chat_panels.js')) return workspace;
    if (request === './chat_view' && parent?.filename.endsWith('/chat_panels.js')) return { ChatView: FakeChatView };
    if (request === './chat_html' && parent?.filename.endsWith('/chat_panels.js')) return { chat_html: () => '<html></html>' };
    if (request === './log' && parent?.filename.endsWith('/chat_panels.js')) return { log: () => {} };
    return original_load.call(this, request, parent, is_main);
};
let ChatPanels;
try {
    ({ ChatPanels } = require('../src/chat_panels'));
} finally {
    Module._load = original_load;
}

function make_context() {
    const stored = {};
    return {
        extensionUri: { path: '/extension' },
        globalState: {
            get: key => stored[key],
            update: async (key, value) => { stored[key] = value; },
            stored,
        },
    };
}

function make_view() {
    const sent = [];
    const message_listeners = new Set();
    const visibility_listeners = new Set();
    const dispose_listeners = new Set();
    const view = {
        visible: true,
        webview: {
            postMessage: message => { sent.push(message); return Promise.resolve(true); },
            onDidReceiveMessage: listener => {
                message_listeners.add(listener);
                return { dispose: () => message_listeners.delete(listener) };
            },
        },
        onDidChangeVisibility: listener => {
            visibility_listeners.add(listener);
            return { dispose: () => visibility_listeners.delete(listener) };
        },
        onDidDispose: listener => {
            dispose_listeners.add(listener);
            return { dispose: () => dispose_listeners.delete(listener) };
        },
        sent,
        receive: message => [...message_listeners].map(listener => listener(message)),
        dispose: () => [...dispose_listeners].map(listener => listener()),
    };
    return view;
}

function make_manager() {
    FakeChatView.next = 1;
    const context = make_context();
    return { context, manager: new ChatPanels(context, {}, {}, { ChatViewClass: FakeChatView }) };
}

async function main() {
    config.notesPosition = undefined;
    config.newChatPosition = undefined;
    {
        const { manager } = make_manager();
        const view = make_view();
        manager.resolveWebviewView(view);
        const first = manager.entries[0].chat;
        const second = manager.add_chat();
        view.sent.length = 0;
        view.receive({ type: 'message', chat_id: second.id, text: 'for second' });
        assert.deepEqual(first.received, []);
        assert.deepEqual(second.received, [{ type: 'message', chat_id: second.id, text: 'for second' }]);
        view.receive({ type: 'message', chat_id: 'closed-chat' });
        assert.deepEqual(first.received, []);
        assert.deepEqual(second.received, [{ type: 'message', chat_id: second.id, text: 'for second' }]);
    }
    {
        const { manager } = make_manager();
        const view = make_view();
        manager.resolveWebviewView(view);
        let latest = manager.entries[0].chat;
        for (let index = 0; index < 3; index += 1) latest = manager.add_chat();
        view.sent.length = 0;
        manager.add_chat();
        assert.deepEqual(view.sent.at(-1), { type: 'error', chat_id: latest.id, text: 'Max. 4 chats open.', transient: true });
        assert.equal(manager.entries.length, 4);
    }
    {
        const { manager } = make_manager();
        const view = make_view();
        manager.resolveWebviewView(view);
        const first = manager.entries[0].chat;
        view.sent.length = 0;
        const right = manager.add_chat();
        assert.deepEqual(manager.entries.map(entry => entry.chat), [first, right]);
        assert.deepEqual(view.sent.filter(message => message.type === 'add_area').at(-1), { type: 'add_area', chat_id: right.id, index: 1 });
        manager.set_new_chat_position('left');
        view.sent.length = 0;
        const left = manager.add_chat();
        assert.deepEqual(manager.entries.map(entry => entry.chat), [left, first, right]);
        assert.deepEqual(view.sent.find(message => message.type === 'add_area'), { type: 'add_area', chat_id: left.id, index: 0 });
    }
    {
        const { manager } = make_manager();
        const view = make_view();
        manager.resolveWebviewView(view);
        const first = manager.entries[0].chat;
        const second = manager.add_chat();
        assert.equal(first.options.window_idle(), true);
        first.agent_id = 'empty-agent';
        first._repo_info = () => { throw new Error('window_idle must not create or inspect a missing session'); };
        assert.equal(first.options.window_idle(), true);
        assert.equal(first.sessions.size, 0);
        second.agent_id = 'agent-2';
        second.sessions.set('agent-2', { can_change: false });
        assert.equal(first.options.window_idle(), false);
        second.sessions.clear();
        assert.equal(first.options.window_idle(), true);
    }
    {
        const { manager } = make_manager();
        const view = make_view();
        manager.resolveWebviewView(view);
        const first = manager.entries[0].chat;
        assert.equal(manager.close_area(first.id), false);
        const second = manager.add_chat();
        const busy = { can_change: false, busy: true, state: { staged: {} } };
        second.agent_id = 'agent-2';
        second.sessions.set('agent-2', busy);
        assert.equal(manager.close_area(second.id), false);
        assert.deepEqual(view.sent.at(-1), { type: 'error', chat_id: second.id, text: 'Close the chat when the agent has finished and no files are staged.', transient: true });
        second.sessions.clear();
        manager.focus_area(second.id);
        view.sent.length = 0;
        assert.equal(manager.close_area(second.id), true);
        assert.equal(second.dispose_calls, 1);
        assert.deepEqual(manager.entries.map(entry => entry.chat), [first]);
        assert.deepEqual(view.sent.map(message => message.type), ['remove_area', 'focus_area', 'notes_groups']);
        assert.deepEqual(view.sent[1], { type: 'focus_area', chat_id: first.id });
    }
    {
        const { manager } = make_manager();
        const view = make_view();
        manager.resolveWebviewView(view);
        const first = manager.entries[0].chat;
        const second = manager.add_chat();
        first.notes = { id: first.id, text: 'first' };
        second.notes = { id: second.id, text: 'second' };
        view.sent.length = 0;
        first.options.on_change();
        assert.deepEqual(view.sent.filter(message => message.type === 'notes_groups'), [{ type: 'notes_groups', groups: [first.notes, second.notes] }]);
        view.sent.length = 0;
        manager.set_notes(second.id, 'updated', 7);
        assert.deepEqual(second.apply_calls, [['updated', 7]]);
    }
    {
        const { context, manager } = make_manager();
        const view = make_view();
        manager.resolveWebviewView(view);
        const active = manager.entries[0].chat;
        const second = manager.add_chat();
        manager.focus_area(second.id);
        view.sent.length = 0;
        const old_port = manager.entries[0].port;
        view.dispose();
        assert.equal(manager.view, null);
        const old_message_count = view.sent.length;
        old_port.webview.postMessage({ type: 'late' });
        view.receive({ type: 'message', chat_id: active.id, text: 'stale view message' });
        assert.equal(view.sent.length, old_message_count);
        assert.deepEqual(active.received, []);
        const replacement = make_view();
        manager.resolveWebviewView(replacement);
        replacement.receive({ type: 'host_ready' });
        assert.deepEqual(replacement.sent.filter(message => message.type === 'add_area').map(message => message.chat_id), [active.id, second.id]);
        assert.deepEqual(replacement.sent.find(message => message.type === 'host_init'), {
            type: 'host_init', notes_visible: false, notes_width: null, notes_position: 'left', new_chat_position: 'right', max_areas: 4, input_height: null,
        });
        assert.deepEqual(replacement.sent.filter(message => message.type === 'focus_area').at(-1), { type: 'focus_area', chat_id: second.id });
        assert.doesNotThrow(() => manager.entries[0].port.webview.postMessage({ type: 'x' }));
        replacement.receive({ type: 'set_notes', chat_id: second.id, text: 'n', rev: 4 });
        assert.deepEqual(second.apply_calls.at(-1), ['n', 4]);
        replacement.receive({ type: 'notes_visible', visible: true });
        replacement.receive({ type: 'notes_width', width: 321.6 });
        replacement.receive({ type: 'notes_width', width: 0 });
        replacement.receive({ type: 'notes_width', width: 'abc' });
        replacement.receive({ type: 'notes_width', width: -1 });
        replacement.receive({ type: 'notes_width', width: Infinity });
        await Promise.resolve();
        assert.equal(context.globalState.get('monarch.notesVisible'), true);
        assert.deepEqual(context.globalState.get('monarch.notesWidth'), null);
        for (const [input, expected] of [[321.6, 322], [0, null], ['abc', null], [-1, null], [Infinity, null]]) {
            replacement.receive({ type: 'notes_width', width: input });
            await Promise.resolve();
            assert.equal(context.globalState.get('monarch.notesWidth'), expected);
        }
    }
    {
        const { manager } = make_manager();
        const view = make_view();
        manager.resolveWebviewView(view);
        const chat = manager.entries[0].chat;
        chat.agent_id = 'agent';
        chat.sessions.set('agent', { busy: true, stop: () => { chat.stop_calls.push('manual'); return new Promise(() => {}); } });
        manager.dispose();
        assert.deepEqual(chat.stop_calls, ['manual']);
        assert.equal(chat.dispose_calls, 1);
    }
    {
        const { manager } = make_manager();
        const view = make_view();
        manager.resolveWebviewView(view);
        const first = manager.entries[0].chat;
        const without_agent = manager.add_chat();
        without_agent._repo_info = () => { throw new Error('must not check a missing agent'); };
        assert.equal(manager.close_area(without_agent.id), true);
        const without_session = manager.add_chat();
        without_session.agent_id = 'agent-without-session';
        without_session._repo_info = () => { throw new Error('must not create or check a missing session'); };
        assert.equal(manager.close_area(without_session.id), true);
        assert.equal(first.dispose_calls, 0);
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
