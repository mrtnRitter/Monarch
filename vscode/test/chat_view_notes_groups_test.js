'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const make_uri = fs_path => ({ fsPath: fs_path, path: fs_path, scheme: 'file', toString: () => fs_path });
const vscode = {
    Uri: { joinPath: (base, ...parts) => make_uri(path.join(base?.fsPath || '', ...parts)) },
    workspace: { getConfiguration: () => ({ get: () => null }) },
    window: { onDidChangeActiveTextEditor: () => ({ dispose() {} }), tabGroups: { activeTabGroup: {}, onDidChangeTabs: () => ({ dispose() {} }) } },
};
const workspace_mock = {
    folders: () => [],
    make_repo_colors: () => ({ color: () => ({ hex: '#123456' }) }),
    make_workspace_adapter: () => ({}),
    list_repos: async () => [],
};
const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    if (request === './workspace' && parent?.filename.endsWith('/src/chat_view.js')) return workspace_mock;
    return original_load.call(this, request, parent, is_main);
};
const { ChatView } = require('../src/chat_view');
Module._load = original_load;

function harness(options = {}) {
    const posted = [];
    let changes = 0;
    const context = {
        extensionUri: make_uri('/extension'),
        subscriptions: [],
        globalState: { get: () => null, update: async () => {} },
        workspaceState: { get: () => undefined, update: async () => {} },
    };
    const chat = new ChatView(context, {}, { is_logged_in: async () => false }, {
        repo: { name: 'Repo', uri: make_uri('/repo') },
        on_change: () => { changes += 1; },
        ...options,
    });
    chat._schedule_sync = () => {};
    const webview = {
        cspSource: 'mock-csp',
        asWebviewUri: uri => uri.fsPath,
        postMessage: async message => posted.push(message),
        onDidReceiveMessage(handler) { this.receive = handler; },
    };
    chat.resolveWebviewView({ webview });
    return { chat, posted, webview, changes: () => changes };
}

async function main() {
    const groups_chat = harness();
    const groups = [{ id: 'x' }];
    groups_chat.chat.post_notes_groups(groups);
    assert.deepEqual(groups_chat.posted.at(-1), { type: 'notes_groups', groups, self: groups_chat.chat.id });

    const routed = [];
    const notes_chat = harness({ set_notes: (...args) => { routed.push(args); return args[0] !== 'other'; } });
    let own_session_changes = 0;
    notes_chat.chat.apply_notes = () => { own_session_changes += 1; return true; };
    await assert.doesNotReject(() => notes_chat.chat._on_message({ type: 'set_notes', chat_id: 'other', text: 't', rev: 2 }));
    assert.deepEqual(routed, [['other', 't', 2]]);
    assert.equal(own_session_changes, 0);
    await notes_chat.chat._on_message({ type: 'set_notes', text: 'own', rev: 3 });
    assert.deepEqual(routed.at(-1), [notes_chat.chat.id, 'own', 3]);
    assert.equal(own_session_changes, 0);

    let opened_repo;
    const beside = harness({ open_beside: repo => { opened_repo = repo; } });
    await beside.chat._on_message({ type: 'new_chat_beside' });
    assert.equal(opened_repo, beside.chat.current_repo());

    const refreshing = harness();
    await refreshing.chat.refresh();
    assert(refreshing.changes() >= 1, 'refresh without sign-in must notify chat panels');

    const refresh_failure = harness();
    refresh_failure.chat.oauth.is_logged_in = async () => { throw new Error('auth unavailable'); };
    await assert.rejects(refresh_failure.chat.refresh(), /auth unavailable/);
    assert.equal(refresh_failure.changes(), 1, 'refresh failures must notify chat panels');

    const html = groups_chat.webview.html;
    assert.match(html, /id="new_menu"/);
    assert.match(html, /id="notes_groups"/);
    assert.match(html, /<div id="notes_groups"[^>]*>[\s\S]*<textarea id="notes"/);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
