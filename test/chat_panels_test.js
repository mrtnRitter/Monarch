'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const panels = [];
const executed = [];
const vscode = {
    ViewColumn: { Active: -1, Beside: 2 },
    Uri: { joinPath: (base, ...parts) => ({ path: [base?.path || '', ...parts].join('/') }) },
    window: {
        createWebviewPanel(...args) {
            const panel = {
                args, webview: {}, active: false, title: args[1], reveal_calls: 0,
                onDidChangeViewState(callback) { this.view_state = callback; return { dispose: () => { this.view_state_disposed = true; } }; },
                onDidDispose(callback) { this.disposed = callback; return { dispose: () => { this.dispose_listener_disposed = true; } }; },
                reveal() { this.reveal_calls += 1; },
            };
            panels.push(panel);
            return panel;
        },
    },
    commands: { executeCommand: (...args) => executed.push(args) },
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
        return {
            slot,
            color: name => repo_colors[slot(name)],
            peek: name => Object.hasOwn(assigned, name.toLowerCase()) ? repo_colors[assigned[name.toLowerCase()]] : null,
        };
    },
};
class FakeChatView {
    constructor(context, client, oauth, options = {}) {
        this.options = options;
        this.value = { id: `id-${FakeChatView.next++}`, repo: options.repo?.name || 'A', title: null, thread_id: null, state: 'idle' };
        this.notes = { id: this.value.id, repo: this.value.repo, hex: '#0', title: this.value.id, text: '', rev: 0 };
        this.dispose_calls = 0;
        this.groups = [];
        this.apply_calls = [];
        this.apply_result = true;
    }
    resolveWebviewView(host) { this.host = host; }
    summary() { return { ...this.value }; }
    current_repo() { return this.options.repo || { name: 'A', uri: { fsPath: '/r/A' } }; }
    notes_entry() { if (this.notes_error) throw new Error('notes failed'); return this.notes; }
    post_notes_groups(groups) { if (this.groups_error) throw new Error('group delivery failed'); this.groups.push(groups); }
    apply_notes(text, rev) { this.apply_calls.push([text, rev]); if (this.apply_error) throw new Error('apply failed'); return this.apply_result; }
    dispose() { this.dispose_calls += 1; }
}
FakeChatView.next = 1;
const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    if (request === './workspace' && parent?.filename.endsWith('/chat_panels.js')) return workspace;
    if (request === './chat_view' && parent?.filename.endsWith('/chat_panels.js')) return { ChatView: FakeChatView };
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
        globalState: { get: key => stored[key], update: async (key, value) => { stored[key] = value; } },
    };
}

async function main() {
    panels.length = 0;
    executed.length = 0;
    FakeChatView.next = 1;
    const manager = new ChatPanels(make_context(), {}, {}, { ChatViewClass: FakeChatView });
    const sidebar = manager.sidebar;
    assert.equal(manager.colors.color('A').icon, 'repo_0.svg');
    const repo_b = { name: 'B', uri: { fsPath: '/r/B' } };
    const chat = manager.open(repo_b);
    const panel = panels[0];
    assert.equal(panel.args[0], 'monarch.chatPanel');
    assert.equal(panel.args[1], 'B · New chat');
    assert.equal(panel.args[2], vscode.ViewColumn.Beside);
    assert.equal(panel.args[3].enableScripts, true);
    assert.equal(panel.args[3].retainContextWhenHidden, true);
    assert.equal(panel.iconPath.path, '/extension/media/repo_1.svg');
    assert.deepEqual(chat.options.repo, repo_b);
    assert.equal(chat.options.colors, manager.colors);
    assert.equal(typeof chat.options.open_beside, 'function');
    assert.equal(typeof chat.options.set_notes, 'function');
    assert.equal(chat.options.on_change, sidebar.options.on_change);
    assert.equal(chat.options.reveal_thread, sidebar.options.reveal_thread);
    assert.equal(chat.host, panel);
    assert.equal(panel.title, 'B · New chat');

    const repo_c = { name: 'C', uri: { fsPath: '/r/C' } };
    const chat_c = chat.options.open_beside(repo_c);
    assert.equal(panels[1].args[1], 'C · New chat');
    assert.equal(chat_c.options.repo, repo_c);

    sidebar.notes = { id: 'id-a', repo: 'A', hex: '#0', title: 'A', text: 'a', rev: 1 };
    chat.notes_error = true;
    chat_c.notes = null;
    chat_c.groups_error = true;
    const chat_d = manager.open({ name: 'D', uri: { fsPath: '/r/D' } });
    chat_d.notes = { id: 'id-d', repo: 'D', hex: '#3', title: 'D', text: 'd', rev: 4 };
    manager._changed();
    const groups = sidebar.groups.at(-1);
    assert.deepEqual(groups.map(item => item.id), ['id-a', 'id-d']);
    assert.equal(chat_c.groups.length, 0);
    for (const item of [sidebar, chat, chat_d]) assert.equal(item.groups.at(-1), groups);

    chat.value.id = 'id-b';
    assert.equal(manager.set_notes('id-b', 'x', 3), true);
    assert.deepEqual(chat.apply_calls.at(-1), ['x', 3]);
    chat.apply_result = false;
    assert.equal(manager.set_notes('id-b', 'y', 4), false);
    assert.equal(manager.set_notes('missing', 'x', 3), false);
    chat.apply_error = true;
    assert.equal(manager.set_notes('id-b', 'z', 5), false);

    assert.equal(manager.reveal_thread('thread-b', sidebar), false);
    chat.value.thread_id = 'thread-b';
    assert.equal(manager.reveal_thread('thread-b', sidebar), true);
    assert.equal(panel.reveal_calls, 1);

    assert.equal(manager.active(), chat_d);
    panels[2].disposed();
    assert.equal(panels[2].view_state_disposed, true);
    assert.equal(panels[2].dispose_listener_disposed, true);
    assert.equal(chat_d.dispose_calls, 1);
    assert.equal(manager.all().includes(chat_d), false);
    assert.equal(manager.active(), sidebar);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
