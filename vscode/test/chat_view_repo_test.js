'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const make_uri = fsPath => ({ fsPath, path: fsPath, toString: () => fsPath });
const vscode = {
    Uri: { joinPath: (base, ...parts) => make_uri([base?.fsPath || '', ...parts].join('/')) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => null }) },
    window: { showQuickPick: async () => 'B' },
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

function harness(initial_values = {}, options = {}, names = ['A', 'B']) {
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
    const default_repo = harness();
    assert.equal(default_repo.chat._repo_name(), 'A');
    assert.equal(default_repo.chat._root().fsPath, '/r/A');

    const selected_repo = harness({}, { repo_name: 'B' });
    assert.equal(selected_repo.chat._repo_name(), 'B');
    const invalid_repo = harness({}, { repo_name: 'X' });
    assert.equal(invalid_repo.chat._repo_name(), 'A');
    assert.equal(invalid_repo.chat._root().fsPath, '/r/A');

    const context_chat = harness({}, { repo_name: 'B' });
    const context = await context_chat.chat._context();
    assert.match(context, /"this repo" = the repo open in VS Code: B/);
    assert.match(context, /other repos in this VS Code window/);
    assert.match(context, /A \(not online\)/);

    const change_repo = harness();
    change_repo.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    change_repo.chat._session = () => ({ busy: false, state: { thread_id: null } });
    await change_repo.webview.receive({ type: 'select_repo' });
    assert.equal(change_repo.chat.repo_name, 'B');
    assert(change_repo.posted.some(message => message.type === 'repo' && message.repo.name === 'B' && message.repo.hex === '#23d18b' && message.repo.can_change === true));

    const fixed_single_repo = harness({}, {}, ['A']);
    fixed_single_repo.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    fixed_single_repo.chat._session = () => ({ busy: false, state: { thread_id: 't' } });
    await fixed_single_repo.webview.receive({ type: 'select_repo' });
    assert.equal(fixed_single_repo.chat._repo_name(), 'A');
    assert.equal(fixed_single_repo.posted.some(message => message.type === 'error'), false);

    const fixed_repo = harness();
    fixed_repo.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    fixed_repo.chat._session = () => ({ busy: false, state: { thread_id: 't' } });
    await fixed_repo.webview.receive({ type: 'select_repo' });
    assert.equal(fixed_repo.chat._repo_name(), 'A');
    assert(fixed_repo.posted.some(message => message.type === 'error' && message.text === 'The repo of a chat is fixed. Start a new chat for another repo.'));

    const history = [{ thread_id: 't9', repo: 'B', updated: 1, state: { thread_id: 't9' } }];
    const opened = harness({ 'monarch.chats.a1': history });
    opened.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    const session = { state: { thread_id: null }, load_state: state => { session.loaded = state; }, refresh_credits() {} };
    opened.chat._session = () => session;
    opened.chat._show_history = async () => {};
    await opened.chat._open_chat('t9');
    assert.equal(opened.chat.repo_name, 'B');
    assert.deepEqual(session.loaded, { thread_id: 't9' });

    const closed_history = [{ thread_id: 't10', repo: 'B', updated: 1, state: { thread_id: 't10' } }];
    const closed_repo = harness({ 'monarch.chats.a1': closed_history }, {}, ['A']);
    closed_repo.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    const closed_session = { state: { thread_id: null }, load_state: state => { closed_session.loaded = state; }, refresh_credits() {} };
    closed_repo.chat._session = () => closed_session;
    closed_repo.chat._show_history = async () => {};
    await closed_repo.chat._open_chat('t10');
    assert.equal(closed_repo.chat.repo_name, null);
    assert.equal(closed_repo.chat._root().fsPath, '/r/A');

    const missing_status = harness({}, { repo_name: 'B' }, ['A']);
    missing_status.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    const missing_session = missing_status.chat._session();
    assert.doesNotThrow(() => missing_session.ui.status({ busy: false }));
    assert(missing_status.posted.some(message => message.type === 'repo' && message.repo.name === 'A' && message.repo.can_change === false));

    const no_folder_status = harness({}, {}, []);
    no_folder_status.chat.agent_list = [{ agentId: 'a1', name: 'Z', labels: {} }];
    const no_folder_session = no_folder_status.chat._session();
    assert.doesNotThrow(() => no_folder_session.ui.status({ busy: false }));
    assert(no_folder_status.posted.some(message => message.type === 'repo' && message.repo.name === null && message.repo.can_change === false));

    const one_repo = harness({}, {}, ['A']);
    assert.match(one_repo.webview.html, /id="repo"/);
    await one_repo.chat.refresh();
    const init = one_repo.posted.find(message => message.type === 'init');
    assert.equal(init.repo.name, 'A');
    assert.equal(init.repo.can_change, false);

    const refreshed = harness();
    refreshed.chat.oauth.is_logged_in = async () => true;
    refreshed.chat.agent_list = [{ agentId: 'a1', name: 'Z', has_image: false, labels: {} }];
    refreshed.chat._user = async () => ({ image: null, initials: 'Du' });
    refreshed.chat._session = () => ({ notes: () => ({ text: '', rev: null }), status: () => ({ busy: false }), refresh_credits() {} });
    refreshed.chat._models = async () => ({ default: {}, models: [] });
    refreshed.chat._show_history = async () => {};
    await refreshed.chat.refresh();
    assert.equal(refreshed.posted.find(message => message.type === 'init').repo.can_change, true);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
