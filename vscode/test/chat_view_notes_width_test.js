'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ fsPath: [base?.fsPath || '', ...parts].join('/') }) },
    workspace: { getConfiguration: () => ({ get: () => null }) },
    window: {},
};
const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    return original_load.call(this, request, parent, is_main);
};
const { ChatView } = require('../src/chat_view');
Module._load = original_load;

function harness(initial_values = {}) {
    const state = new Map(Object.entries(initial_values));
    const posted = [];
    const context = {
        extensionUri: { fsPath: '/extension' },
        subscriptions: [],
        globalState: {
            get: key => state.get(key),
            update: async (key, value) => state.set(key, value),
        },
        workspaceState: { get: () => undefined, update: async () => undefined },
    };
    const chat = new ChatView(context, {}, { is_logged_in: async () => false });
    chat._schedule_sync = () => {};
    const webview = {
        cspSource: 'mock-csp',
        asWebviewUri: uri => uri.fsPath,
        postMessage: async message => posted.push(message),
        onDidReceiveMessage(handler) { this.receive = handler; },
    };
    chat.resolveWebviewView({ webview });
    return { chat, context, posted, state, webview };
}

async function main() {
    const page = harness();
    assert.match(page.webview.html, /<div id="notes_pane"[^>]*>\s*<div id="notes_splitter" class="notes-splitter"><\/div>\s*<div id="notes_groups" class="notes-groups">\s*<textarea id="notes"/);

    for (const [width, expected] of [[321.6, 322], [0, null], ['abc', null], [-1, null], [Infinity, null]]) {
        const test = harness();
        await test.webview.receive({ type: 'notes_width', width });
        assert.equal(test.state.get('monarch.notesWidth'), expected);
    }

    const stored = harness({ 'monarch.notesWidth': 321 });
    await stored.chat.refresh();
    assert.equal(stored.posted.find(message => message.type === 'init')?.notes_width, 321);

    const empty = harness();
    await empty.chat.refresh();
    assert.equal(empty.posted.find(message => message.type === 'init')?.notes_width, null);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
