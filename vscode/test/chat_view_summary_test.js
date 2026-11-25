'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const make_uri = fsPath => ({ fsPath, path: fsPath, toString: () => fsPath });
const created_terminals = [];
const terminal_options = [];
const vscode = {
    Uri: { joinPath: (base, ...parts) => make_uri([base?.fsPath || '', ...parts].join('/')) },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
    ViewColumn: { Beside: -2 },
    TerminalLocation: { Panel: 1 },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => null }) },
    window: {
        terminals: created_terminals,
        createTerminal(options) {
            terminal_options.push(options);
            const terminal = { name: options.name, exitStatus: undefined, show() {} };
            created_terminals.push(terminal);
            return terminal;
        },
        showQuickPick: async () => 'B',
    },
};
const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    return original_load.call(this, request, parent, is_main);
};
const { ChatView } = require('../src/chat_view');
Module._load = original_load;

function folders(names = ['A', 'B']) {
    vscode.workspace.workspaceFolders = names.map(name => ({ name, uri: make_uri(`/r/${name}`) }));
}

function harness(initial_values = {}, options = {}, { names = ['A', 'B'], visible = false, viewColumn, stub_schedule = true } = {}) {
    folders(names);
    const state = new Map(Object.entries(initial_values));
    const posted = [];
    const context = {
        extensionUri: make_uri('/extension'),
        subscriptions: [],
        globalState: {
            get: key => state.get(key),
            update: async (key, value) => state.set(key, value),
        },
        workspaceState: { get: () => undefined, update: async () => undefined },
    };
    const chat = new ChatView(context, {}, { is_logged_in: async () => false }, options);
    if (stub_schedule) chat._schedule_sync = () => {};
    const webview = {
        cspSource: 'mock-csp',
        asWebviewUri: uri => uri.fsPath,
        postMessage: async message => posted.push(message),
        onDidReceiveMessage(handler) { this.receive = handler; return disposable(); },
    };
    const host_listeners = [];
    const host = {
        webview,
        visible,
        viewColumn,
        onDidChangeVisibility(handler) { host_listeners.push({ type: 'visibility', handler }); return disposable(host_listeners.at(-1)); },
        onDidChangeViewState(handler) { host_listeners.push({ type: 'viewState', handler }); return disposable(host_listeners.at(-1)); },
    };
    chat.resolveWebviewView(host);
    return { chat, context, posted, state, webview, host, host_listeners };
}

function disposable(record = null) {
    return { disposed: false, dispose() { this.disposed = true; if (record) record.disposed = true; } };
}

async function main() {
    const no_agent = harness({}, {}, { names: ['A'] });
    const empty_summary = no_agent.chat.summary();
    assert.equal(empty_summary.repo, 'A');
    assert.equal(empty_summary.title, null);
    assert.equal(empty_summary.thread_id, null);
    assert.equal(empty_summary.state, 'idle');
    assert.equal(typeof empty_summary.id, 'string');

    let changes = 0;
    const status = harness({}, { on_change: () => { changes++; } });
    status.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    const session = status.chat._session();
    assert.equal(status.chat.summary().title, null);
    session.ui.message({ role: 'agent', text: 'x' });
    assert.equal(status.chat.summary().state, 'answer');
    assert(changes > 0);
    status.chat.mark_seen();
    assert.equal(status.chat.summary().state, 'idle');
    session.ui.message({ role: 'question', questions: [] });
    assert.equal(status.chat.summary().state, 'question');
    session.ui.message({ role: 'user', text: 'y' });
    assert.equal(status.chat.summary().state, 'idle');
    session.busy = true;
    assert.equal(status.chat.summary().state, 'working');
    session.busy = false;
    session.state.staged = { 'a.txt': {} };
    assert.equal(status.chat.summary().state, 'staged');
    session.state.title = 'Saved title';
    session.state.thread_id = 'thread-1';
    assert.equal(status.chat.summary().title, 'Saved title');
    assert.equal(status.chat.summary().thread_id, 'thread-1');
    session.ui.status({ busy: false });
    assert(changes > 4);

    let repo_changes = 0;
    const changed_repo = harness({}, { on_change: () => { repo_changes++; } });
    changed_repo.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    await changed_repo.webview.receive({ type: 'select_repo', path: '/r/B' });
    assert.equal(repo_changes, 1);

    let store_changes = 0;
    const stored = harness({}, { on_change: () => { store_changes++; } });
    stored.chat._store({ agentId: 'a1', name: 'Z' }).save({ thread_id: 't1', title: 'Saved', staged: {} });
    assert.equal(store_changes, 1);

    const throwing = harness({}, { on_change: () => { throw new Error('change failed'); } });
    throwing.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    assert.doesNotThrow(() => throwing.chat._session().ui.message({ role: 'agent', text: 'x' }));

    created_terminals.length = 0;
    terminal_options.length = 0;
    const terminal_chat = harness({}, {}, { names: ['A'] });
    const first_terminal = terminal_chat.chat._terminal();
    const second_terminal = terminal_chat.chat._terminal();
    assert.equal(first_terminal, second_terminal);
    assert.equal(created_terminals.length, 1);
    assert.equal(terminal_options[0].name, 'monarch: A');
    assert.equal(terminal_options[0].cwd.fsPath, '/r/A');
    assert.equal(terminal_options[0].color.id, 'terminal.ansiBlue');
    assert.equal(terminal_options[0].location, 1);

    created_terminals.length = 0;
    terminal_options.length = 0;
    const beside = harness({}, {}, { names: ['A'], viewColumn: 1 });
    beside.chat._terminal();
    assert.deepEqual(terminal_options.at(-1).location, { viewColumn: -2, preserveFocus: false });
    let terminal_messages = 0;
    beside.chat._terminal = () => { terminal_messages++; };
    await beside.webview.receive({ type: 'terminal' });
    assert.equal(terminal_messages, 1);
    assert.match(beside.webview.html, /id="terminal"/);

    const opened = harness({ 'monarch.chats.a1': [{ thread_id: 't9', repo: 'A', updated: 1, state: { thread_id: 't9' } }] });
    opened.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    let loaded = false;
    opened.chat._session = () => ({ state: { thread_id: null }, load_state: () => { loaded = true; } });
    opened.chat.options.reveal_thread = () => true;
    await opened.chat._open_chat('t9');
    assert.equal(loaded, false);

    const unscheduled = harness({}, {}, { names: ['A'], stub_schedule: false });
    unscheduled.chat.dispose();
    const timer_after_dispose = unscheduled.chat.sync_timer;
    let new_timers = 0;
    const original_set_timeout = global.setTimeout;
    global.setTimeout = (...args) => { new_timers++; return original_set_timeout(...args); };
    try {
        unscheduled.chat._schedule_sync();
    } finally {
        global.setTimeout = original_set_timeout;
    }
    assert.equal(unscheduled.chat.sync_timer, timer_after_dispose);
    assert.equal(new_timers, 0);

    const disposed = harness();
    let stopped_with = null;
    let reject_stop;
    disposed.chat.sessions.set('a1', { busy: true, stop: reason => { stopped_with = reason; return new Promise((resolve, reject) => { reject_stop = reject; }); } });
    assert.equal(disposed.chat.dispose(), undefined);
    assert.equal(stopped_with, 'manual');
    assert.equal(disposed.chat.view, null);
    reject_stop(new Error('stop failed'));
    await new Promise(resolve => setImmediate(resolve));
    assert(disposed.host_listeners.length >= 2);
    assert(disposed.host_listeners.every(listener => listener.disposed));
    assert.doesNotThrow(() => disposed.chat._post({ type: 'after-dispose' }));
    assert.equal(disposed.chat.view, null);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
