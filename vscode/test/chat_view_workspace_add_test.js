'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const make_uri = fs_path => ({ fsPath: fs_path, path: fs_path, scheme: 'file', toString: () => fs_path });
let open_folders = [];
let repos = [];
let workspace_file = undefined;
let update_result = true;
let update_calls = [];
let warning_calls = [];
let warning_handler = async () => undefined;

const vscode = {
    workspace: {
        get workspaceFolders() { return open_folders; },
        get workspaceFile() { return workspace_file; },
        updateWorkspaceFolders(...args) { update_calls.push(args); return update_result; },
    },
    window: {
        showWarningMessage(...args) { warning_calls.push(args); return warning_handler(...args); },
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        terminals: [],
    },
};
const workspace_mock = {
    folders: () => open_folders,
    list_repos: async () => repos,
    make_repo_colors: () => ({ color: () => ({ hex: '#123456' }), peek: () => null }),
    make_workspace_adapter: () => ({}),
};
const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    if (request === './workspace' && parent?.filename.endsWith('/src/chat_view.js')) return workspace_mock;
    if (request === './git' && parent?.filename.endsWith('/src/chat_view.js')) return { repo_info: async () => ({}) };
    return original_load.call(this, request, parent, is_main);
};
const { ChatView } = require('../src/chat_view');
const { Notice } = require('../src/session');
Module._load = original_load;

function set_window(paths, multi_root = false) {
    open_folders = paths.map((fs_path, index) => ({ name: path.basename(fs_path), uri: make_uri(fs_path), index }));
    repos = [...open_folders, { name: 'X', uri: make_uri('/r/X'), open: false }, { name: 'Y', uri: make_uri('/r/Y'), open: false }];
    workspace_file = multi_root ? make_uri('/r/workspace.code-workspace') : undefined;
    update_result = true;
    update_calls = [];
    warning_calls = [];
    warning_handler = async () => undefined;
}

function assert_update_call(index, uri_path) {
    assert.equal(update_calls.length, 1);
    const [insert_index, delete_count, folder] = update_calls[0];
    assert.equal(insert_index, index);
    assert.equal(delete_count, 0);
    assert.equal(folder.uri.fsPath, uri_path);
}

function harness(options = {}) {
    const context = {
        subscriptions: [],
        workspaceState: { get: () => undefined, update: async () => undefined },
        globalState: { get: () => undefined, update: async () => undefined },
    };
    const chat = new ChatView(context, {}, {}, { repo: { name: 'A', uri: make_uri('/r/A') }, ...options });
    chat._schedule_sync = () => {};
    const posted = [];
    const webview = {
        postMessage(message) { posted.push(message); return Promise.resolve(true); },
        onDidReceiveMessage(handler) { this.listener = handler; return { dispose() {} }; },
        receive(message) { return this.listener(message); },
    };
    chat.attach({ webview, visible: false, onDidChangeVisibility: () => ({ dispose() {} }) });
    return { chat, posted, webview };
}

async function main() {
    {
        set_window(['/r/A', '/r/B'], true);
        const { chat } = harness();
        assert.equal(chat.options.window_idle(), false);
        await chat._on_message({ type: 'select_repo', path: '/r/X' });
        assert_update_call(2, '/r/X');
        assert.equal(warning_calls.length, 0);
        assert.equal(chat.current_repo().name, 'X');
    }
    {
        set_window([]);
        warning_handler = async () => 'Add';
        const { chat } = harness({ window_idle: () => true });
        await chat._on_message({ type: 'select_repo', path: '/r/X' });
        assert.deepEqual(warning_calls[0].slice(1), [{ modal: true }, 'Add']);
        assert_update_call(0, '/r/X');
    }
    {
        set_window(['/r/A']);
        const { chat, posted, webview } = harness({ window_idle: () => false });
        await webview.receive({ type: 'select_repo', path: '/r/X' });
        assert.deepEqual(update_calls, []);
        assert.equal(warning_calls.length, 0);
        assert.deepEqual(posted.filter(item => item.type === 'error').map(item => item.text), [
            'Repo selected. Add it with File → Add Folder to Workspace… when no agent is running.',
        ]);
        assert.equal(chat.current_repo().name, 'X');
    }
    {
        set_window(['/r/A']);
        warning_handler = async () => 'Add';
        const { chat } = harness({ window_idle: () => true });
        await chat._on_message({ type: 'select_repo', path: '/r/X' });
        assert.deepEqual(warning_calls, [[
            'Add X to the workspace? This window becomes an untitled multi-root workspace and VS Code may restart the extensions.',
            { modal: true },
            'Add',
        ]]);
        assert_update_call(1, '/r/X');
    }
    {
        set_window(['/r/A']);
        const { posted, chat } = harness({ window_idle: () => true });
        await chat._on_message({ type: 'select_repo', path: '/r/X' });
        assert.deepEqual(update_calls, []);
        assert.deepEqual(posted.filter(item => item.type === 'error'), []);
    }
    {
        set_window(['/r/A']);
        warning_handler = async () => 'Add';
        update_result = false;
        const { posted, webview } = harness({ window_idle: () => true });
        await webview.receive({ type: 'select_repo', path: '/r/X' });
        assert_update_call(1, '/r/X');
        assert.deepEqual(posted.filter(item => item.type === 'error').map(item => item.text), ['Folder not added.']);
    }
    {
        set_window(['/r/A', '/r/B'], true);
        const { chat } = harness();
        await chat._on_message({ type: 'select_repo', path: '/r/B' });
        assert.deepEqual(update_calls, []);
        assert.equal(warning_calls.length, 0);
    }
    {
        set_window(['/r/A']);
        let resolve_warning;
        warning_handler = () => new Promise(resolve => { resolve_warning = resolve; });
        const { chat, posted } = harness({ window_idle: () => true });
        const pending = chat._on_message({ type: 'select_repo', path: '/r/X' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(chat.current_repo().name, 'X');
        assert(posted.some(item => item.type === 'repo' && item.repo.name === 'X'));
        assert.equal(typeof resolve_warning, 'function');
        const second_chat = harness({ window_idle: () => false });
        await second_chat.chat._on_message({ type: 'list_repos' });
        assert(second_chat.posted.some(item => item.type === 'repos'));
        resolve_warning(undefined);
        await pending;
    }
    {
        set_window(['/r/A']);
        const { chat } = harness();
        await assert.rejects(chat._on_message({ type: 'select_repo', path: '/missing' }), error => error instanceof Notice && error.message === 'Repo not found.');
        assert.deepEqual(update_calls, []);
        assert.equal(warning_calls.length, 0);
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
