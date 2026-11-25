'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const make_uri = fs_path => ({ fsPath: fs_path, path: fs_path, scheme: 'file', toString: () => fs_path });
const vscode = {
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
    let changes = 0;
    const context = {
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
    const posted = [];
    const port = {
        webview: {
            postMessage: async message => posted.push(message),
            onDidReceiveMessage: () => ({ dispose() {} }),
        },
        visible: false,
        onDidChangeVisibility: () => ({ dispose() {} }),
    };
    chat.attach(port);
    return { chat, posted, changes: () => changes };
}

async function main() {
    const refreshing = harness();
    await refreshing.chat.refresh();
    assert(refreshing.changes() >= 1, 'refresh without sign-in must notify chat panels');

    const refresh_failure = harness();
    refresh_failure.chat.oauth.is_logged_in = async () => { throw new Error('auth unavailable'); };
    await assert.rejects(refresh_failure.chat.refresh(), /auth unavailable/);
    assert.equal(refresh_failure.changes(), 1, 'refresh failures must notify chat panels');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
