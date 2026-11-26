'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const registered_commands = new Map();
const webview_providers = [];
let configuration_changed;
const changed_configuration = new Set();
const auth_events = [];
const config_values = { notesPosition: 'right', newChatPosition: 'left', actionBarPosition: 'left', inputEmptyLines: 5 };
const vscode = {
    window: {
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        registerWebviewViewProvider: (...args) => { webview_providers.push(args); return { dispose() {} }; },
        showErrorMessage() {},
        showInformationMessage() {},
    },
    commands: { registerCommand: (name, handler) => { registered_commands.set(name, handler); return { dispose() {} }; } },
    workspace: {
        getConfiguration: () => ({ get: key => config_values[key] }),
        onDidChangeConfiguration: callback => { configuration_changed = callback; return { dispose() {} }; },
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    },
    env: { openExternal: async () => true },
    Uri: { parse: value => value },
};
const active_chat = { new_chat_calls: 0, stop_calls: 0, new_chat() { this.new_chat_calls += 1; }, stop() { this.stop_calls += 1; } };
const fake_panels = {
    add_chat_calls: 0, notes_positions: [], new_chat_positions: [], action_bar_positions: [], input_empty_lines: [],
    add_chat() { this.add_chat_calls += 1; },
    set_notes_position(value) { this.notes_positions.push(value); },
    set_new_chat_position(value) { this.new_chat_positions.push(value); },
    set_action_bar_position(value) { this.action_bar_positions.push(value); },
    set_input_empty_lines(value) { this.input_empty_lines.push(value); },
    all: () => [auth_chat], active: () => active_chat,
};
const auth_chat = { forget_calls: 0, refresh_calls: 0, forget_user() { this.forget_calls += 1; }, async refresh() { this.refresh_calls += 1; } };
const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    if (request === './awork' && parent?.filename.endsWith('/extension.js')) return { AworkClient: class {}, OAuth: class { async login() { auth_events.push('signIn'); } async logout() { auth_events.push('signOut'); } async access_token() { return null; } } };
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
    const subscriptions = [];
    activate({
        subscriptions,
        secrets: { delete: async () => undefined },
        workspaceState: { get: () => undefined, update: async () => undefined },
        globalState: { get: () => undefined, update: async () => undefined },
        extensionUri: { path: '/extension' },
    });
    assert(registered_commands.has('monarch.addChat'));
    assert.equal(registered_commands.has('monarch.openChatInEditor'), false);
    assert(registered_commands.has('monarch.newChat'));
    assert(registered_commands.has('monarch.stop'));
    assert(webview_providers.some(([id, provider]) => id === 'monarch.chat' && provider === fake_panels));
    assert(subscriptions.includes(fake_panels));
    await registered_commands.get('monarch.addChat')();
    await registered_commands.get('monarch.newChat')();
    await registered_commands.get('monarch.stop')();
    assert.equal(fake_panels.add_chat_calls, 1);
    assert.equal(active_chat.new_chat_calls, 1);
    assert.equal(active_chat.stop_calls, 1);
    await registered_commands.get('monarch.signIn')();
    await registered_commands.get('monarch.signOut')();
    assert.deepEqual(auth_events, ['signIn', 'signOut']);
    assert.equal(auth_chat.forget_calls, 2);
    assert.equal(auth_chat.refresh_calls, 2);
    changed_configuration.clear();
    changed_configuration.add('monarch.notesPosition');
    configuration_changed({ affectsConfiguration: name => changed_configuration.has(name) });
    changed_configuration.clear();
    changed_configuration.add('monarch.newChatPosition');
    configuration_changed({ affectsConfiguration: name => changed_configuration.has(name) });
    changed_configuration.clear();
    changed_configuration.add('monarch.actionBarPosition');
    configuration_changed({ affectsConfiguration: name => changed_configuration.has(name) });
    changed_configuration.clear();
    changed_configuration.add('monarch.inputEmptyLines');
    configuration_changed({ affectsConfiguration: name => changed_configuration.has(name) });
    assert.deepEqual(fake_panels.notes_positions, ['right']);
    assert.deepEqual(fake_panels.new_chat_positions, ['left']);
    assert.deepEqual(fake_panels.action_bar_positions, ['left']);
    assert.deepEqual(fake_panels.input_empty_lines, [5]);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
