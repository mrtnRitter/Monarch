'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const registered_commands = new Map();
const webview_providers = [];
const tree_providers = [];
const opened = [];
const vscode = {
    window: {
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        registerWebviewViewProvider: (...args) => { webview_providers.push(args); return { dispose() {} }; },
        registerTreeDataProvider: (...args) => { tree_providers.push(args); return { dispose() {} }; },
        showErrorMessage() {},
        showInformationMessage() {},
    },
    commands: { registerCommand: (name, handler) => { registered_commands.set(name, handler); return { dispose() {} }; } },
    workspace: {
        getConfiguration: () => ({ get: () => undefined }),
        onDidChangeConfiguration: callback => { vscode.configuration_changed = callback; return { dispose() {} }; },
        onDidChangeWorkspaceFolders: callback => { vscode.folders_changed = callback; return { dispose() {} }; },
    },
    env: { openExternal: async () => true },
    Uri: { parse: value => value },
};
const active_chat = { current_repo: () => ({ name: 'Active repo', uri: { fsPath: '/r/active' } }) };
const fake_panels = {
    sidebar: { refresh() {}, new_chat() {}, stop() {}, forget_user() {}, post_notes_position() {} },
    all: () => [],
    active: () => active_chat,
    open: repo => opened.push(repo),
};
const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    if (request === './awork' && parent?.filename.endsWith('/extension.js')) {
        return { AworkClient: class {}, OAuth: class { async login() {} async logout() {} async access_token() { return null; } } };
    }
    if (request === './chat_view' && parent?.filename.endsWith('/extension.js')) return { ChatView: class {} };
    if (request === './chat_panels' && parent?.filename.endsWith('/extension.js')) return { ChatPanels: class { constructor() { return fake_panels; } } };
    if (request === './log' && parent?.filename.endsWith('/extension.js')) return { set_log() {} };
    return original_load.call(this, request, parent, is_main);
};
let activate;
try {
    ({ activate } = require('../src/extension'));
} finally {
    Module._load = original_load;
}

async function main() {
    const context = {
        subscriptions: [],
        secrets: { delete: async () => undefined },
        workspaceState: { get: () => undefined, update: async () => undefined },
        globalState: { get: () => undefined, update: async () => undefined },
        extensionUri: { path: '/extension' },
    };
    activate(context);
    for (const name of ['monarch.signIn', 'monarch.signOut', 'monarch.newChat', 'monarch.stop', 'monarch.openChatInEditor']) {
        assert(registered_commands.has(name), `missing command ${name}`);
    }
    assert.equal(registered_commands.has('monarch.revealChat'), false);
    assert.equal(tree_providers.length, 0);
    assert(webview_providers.some(([id, provider]) => id === 'monarch.chat' && provider === fake_panels.sidebar));
    await registered_commands.get('monarch.openChatInEditor')();
    assert.deepEqual(opened, [{ name: 'Active repo', uri: { fsPath: '/r/active' } }]);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
