'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const vscode = {
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

function harness() {
    const posted = [];
    const context = {
        subscriptions: [],
        globalState: { get: () => null, update: async () => {} },
        workspaceState: { get: () => undefined, update: async () => {} },
    };
    const chat = new ChatView(context, {}, { is_logged_in: async () => false });
    chat._schedule_sync = () => {};
    chat.attach({
        webview: {
            postMessage: async message => posted.push(message),
            onDidReceiveMessage: () => ({ dispose() {} }),
        },
        visible: false,
        onDidChangeVisibility: () => ({ dispose() {} }),
    });
    return { chat, posted };
}

async function main() {
    const test = harness();
    await test.chat.refresh();
    const init = test.posted.find(message => message.type === 'init');
    assert(init);
    for (const field of ['notes_visible', 'notes_width', 'notes_position']) assert.equal(field in init, false);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
