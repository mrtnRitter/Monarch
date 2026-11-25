'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const workspace_values = new Map([['monarch.agent', 'a1']]);
const vscode = {
    workspace: { getConfiguration: () => ({ get: () => null }) },
    window: {},
};
const workspace_mock = {
    folders: () => [],
    make_repo_colors: () => ({ color: () => ({ hex: '#123456', theme: 'terminal.ansiBlue' }) }),
    make_workspace_adapter: () => ({}),
};
const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    if (request === './workspace' && parent?.filename.endsWith('/src/chat_view.js')) return workspace_mock;
    return original_load.call(this, request, parent, is_main);
};
const { ChatView } = require('../src/chat_view');
const { Notice } = require('../src/session');
Module._load = original_load;

function make_context() {
    return {
        subscriptions: [],
        globalState: { get: () => undefined, update: async () => undefined },
        workspaceState: {
            get: key => workspace_values.get(key),
            update: async (key, value) => workspace_values.set(key, value),
        },
    };
}

function make_port(initial_visible = false) {
    let visible = initial_visible;
    const port = {
        sent: [],
        message_listeners: [],
        visibility_listeners: [],
        webview: {
            postMessage(message) { port.sent.push(message); },
            onDidReceiveMessage(listener) {
                const record = { listener, disposed: false };
                port.message_listeners.push(record);
                return { dispose() { record.disposed = true; } };
            },
        },
        get visible() { return visible; },
        change_visibility(value) {
            visible = value;
            for (const record of port.visibility_listeners) if (!record.disposed) record.listener();
        },
        onDidChangeVisibility(listener) {
            const record = { listener, disposed: false };
            port.visibility_listeners.push(record);
            return { dispose() { record.disposed = true; } };
        },
    };
    return port;
}

function make_chat(options = {}) {
    const chat = new ChatView(make_context(), {}, { is_logged_in: async () => false }, options);
    chat._schedule_sync = () => {};
    return chat;
}

async function main() {
    const a1 = { agentId: 'a1', name: 'Agent 1', labels: {} };
    const a2 = { agentId: 'a2', name: 'Agent 2', labels: {} };
    const default_chat = make_chat();
    assert.equal(default_chat.agent_id, 'a1');
    const first = make_chat({ agent_id: 'a1' });
    const second = make_chat({ agent_id: 'a2' });
    first.agent_list = [a1, a2];
    second.agent_list = [a1, a2];
    assert.equal(first._agent(), a1);
    assert.equal(second._agent(), a2);
    first._session = () => ({ busy: false });
    first.refresh = async () => {};
    await first._on_message({ type: 'select_agent', id: 'a2' });
    assert.equal(first.agent_id, 'a2');
    assert.equal(first._agent(), a2);
    assert.equal(second._agent(), a2);
    assert.equal(second.agent_id, 'a2');
    assert.equal(workspace_values.get('monarch.agent'), 'a2');

    const busy = make_chat({ agent_id: 'a1' });
    busy.agent_list = [a1, a2];
    busy._session = () => ({ busy: true });
    await assert.rejects(busy._on_message({ type: 'select_agent', id: 'a2' }), error => error instanceof Notice && error.message === 'Stop the agent first.');
    assert.equal(busy.agent_id, 'a1');

    const invalid_agent = make_chat({ agent_id: 'unknown' });
    invalid_agent.agent_list = [a1, a2];
    assert.equal(invalid_agent._agent(), a1);

    const visible_chat = make_chat({ agent_id: 'a1' });
    const visible_port = make_port();
    visible_chat.unseen = true;
    visible_chat.attach(visible_port);
    visible_port.change_visibility(true);
    assert.equal(visible_chat.unseen, false);

    const chat = make_chat({ agent_id: 'a1' });
    const port1 = make_port();
    let received = [];
    chat._on_message = async message => { received.push(message); };
    chat.attach(port1);
    await port1.message_listeners[0].listener({ type: 'ping' });
    assert.deepEqual(received, [{ type: 'ping' }]);
    chat._post({ type: 'pong' });
    assert.deepEqual(port1.sent, [{ type: 'pong' }]);

    const old_listener = port1.message_listeners[0].listener;
    const port2 = make_port();
    chat.attach(port2);
    assert.equal(port1.message_listeners[0].disposed, true);
    assert.equal(port1.visibility_listeners[0].disposed, true);
    await old_listener({ type: 'stale' });
    assert.deepEqual(received, [{ type: 'ping' }]);

    chat.agent_list = [a1, a2];
    chat.agent_id = 'a1';
    assert.equal(chat.summary().agent_id, 'a1');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
