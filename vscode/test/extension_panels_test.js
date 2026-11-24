'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const registered_commands = new Map();
const webview_providers = [];
const tree_providers = [];
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
const fake_panels = {
    sidebar: { refresh() {}, new_chat() {}, stop() {}, forget_user() {}, post_notes_position() {} },
    all: () => [], active() { return this.sidebar; },
    pick_repo: async () => null, open() {}, reveal() { return false; },
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
    for (const name of ['monarch.signIn', 'monarch.signOut', 'monarch.newChat', 'monarch.stop', 'monarch.openChatInEditor', 'monarch.revealChat']) {
        assert(registered_commands.has(name), `missing command ${name}`);
    }
    assert(tree_providers.some(([id, provider]) => id === 'monarch.chats' && provider === fake_panels));
    assert(webview_providers.some(([id, provider]) => id === 'monarch.chat' && provider === fake_panels.sidebar));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
