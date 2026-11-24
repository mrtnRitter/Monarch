'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const workspace_folders = [
    { name: 'A', uri: { fsPath: '/r/A' } },
    { name: 'B', uri: { fsPath: '/r/B' } },
];
const executed = [];
const panels = [];
const vscode = {
    EventEmitter: class {
        constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return { dispose() {} }; }; }
        fire(value) { for (const listener of this.listeners) listener(value); }
    },
    TreeItem: class { constructor(label, collapsible_state) { Object.assign(this, { label, collapsible_state }); } },
    ThemeIcon: class { constructor(id, color) { Object.assign(this, { id, color }); } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0 },
    ViewColumn: { Active: -1 },
    Uri: { joinPath: (base, ...parts) => ({ path: [base?.path || '', ...parts].join('/') }) },
    window: {
        createWebviewPanel(...args) {
            const panel = {
                args, webview: {}, active: false, title: args[1], reveal_calls: 0,
                onDidChangeViewState(callback) { this.view_state = callback; },
                onDidDispose(callback) { this.disposed = callback; },
                reveal() { this.reveal_calls += 1; },
            };
            panels.push(panel);
            return panel;
        },
        showQuickPick: async (items, options) => { vscode.quick_pick = { items, options }; return vscode.quick_pick_result; },
        showErrorMessage: message => { vscode.error_message = message; },
    },
    commands: { executeCommand: (...args) => { executed.push(args); } },
};
const workspace = {
    folders: () => workspace_folders.map((folder, index) => ({ ...folder, index })),
    folder_by_name: name => workspace.folders().find(folder => folder.name === name) || null,
    repo_color: index => ({ icon: `repo_${index}.svg`, theme: `theme_${index}`, hex: `#${index}` }),
};
class FakeChatView {
    constructor(context, client, oauth, options = {}) {
        this.context = context;
        this.client = client;
        this.oauth = oauth;
        this.options = options;
        this.value = { id: `chat-${FakeChatView.next++}`, repo: options.repo_name || null, title: null, thread_id: null, state: 'idle' };
        this.dispose_calls = 0;
    }
    resolveWebviewView(host) { this.host = host; }
    summary() { return { ...this.value }; }
    dispose() { this.dispose_calls += 1; }
    refresh() {}
    new_chat() {}
    stop() {}
    forget_user() {}
    post_notes_position() {}
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

async function main() {
    panels.length = 0;
    executed.length = 0;
    const context = { extensionUri: { path: '/extension' } };
    const manager = new ChatPanels(context, {}, {} , { ChatViewClass: FakeChatView });
    const sidebar = manager.sidebar;
    const chat = manager.open('B');
    const panel = panels[0];
    assert.equal(panel.args[0], 'monarch.chatPanel');
    assert.equal(panel.args[1], 'B · New chat');
    assert.equal(panel.args[2], -1);
    assert.equal(panel.args[3].enableScripts, true);
    assert.equal(panel.args[3].retainContextWhenHidden, true);
    assert.equal(panel.iconPath.path, '/extension/media/repo_1.svg');
    assert.equal(chat.options.repo_name, 'B');
    assert.equal(chat.options.on_change, sidebar.options.on_change);
    assert.equal(chat.options.reveal_thread, sidebar.options.reveal_thread);
    assert.equal(chat.host, panel);
    assert.equal(panel.title, 'B · New chat');

    assert.equal(manager.getChildren().length, 2);
    chat.value = { id: 'panel-id', repo: 'B', title: 'Panel', thread_id: 't1', state: 'answer' };
    chat.options.on_change();
    const panel_item = manager.getTreeItem(manager.getChildren()[1]);
    const sidebar_item = manager.getTreeItem(manager.getChildren()[0]);
    assert.equal(panel_item.description, 'new answer');
    assert.equal(sidebar_item.description, 'sidebar');
    assert.deepEqual(panel_item.command.arguments, ['panel-id']);
    assert.equal(panel_item.id, 'panel-id');

    assert.equal(manager.reveal_thread('t1', sidebar), true);
    assert.equal(panel.reveal_calls, 1);
    assert.equal(manager.reveal('panel-id'), true);
    assert.equal(panel.reveal_calls, 2);
    assert.equal(manager.reveal_thread('t2', sidebar), false);
    sidebar.value.thread_id = 't3';
    assert.equal(manager.reveal_thread('t3', chat), true);
    assert.deepEqual(executed.at(-1), ['monarch.chat.focus']);

    assert.equal(manager.active(), chat);
    panel.disposed();
    assert.equal(chat.dispose_calls, 1);
    assert.equal(manager.getChildren().length, 1);
    assert.equal(manager.active(), sidebar);

    workspace_folders.splice(0, workspace_folders.length,
        { name: 'A', uri: { fsPath: '/r/A' } }, { name: 'B', uri: { fsPath: '/r/B' } });
    vscode.quick_pick_result = 'B';
    assert.equal(await manager.pick_repo(), 'B');
    assert.deepEqual(vscode.quick_pick.items, ['A', 'B']);
    assert.deepEqual(vscode.quick_pick.options, { title: 'monarch: repo for the new chat' });
    workspace_folders.splice(1);
    assert.equal(await manager.pick_repo(), 'A');
    workspace_folders.splice(0);
    assert.equal(await manager.pick_repo(), null);
    assert.equal(vscode.error_message, 'monarch: open a folder first.');

    const failing = manager.open('A');
    failing.summary = () => { throw new Error('summary failed'); };
    assert.doesNotThrow(() => failing.options.on_change());
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
