'use strict';
// Loads the extension with a stubbed vscode module: activation, agents from awork, shared history, model choice, a chat round trip.
const assert = require('assert/strict');
const Module = require('module');

const registered = {};
const posted = [];
let provider = null;
let on_message = null;
// 0.4 single chat (Mastazilla) and 0.5 list (CodeZilla) of this repo, plus a CodeZilla chat from another repo
const workspace_state = new Map([['monarch.chat.Mastazilla', { thread_id: 'old1', rounds: 0, next_index: 1, co_agents: {} }], ['monarch.chats.code', { current: null, items: [{ thread_id: 'old05', title: 'Alt', updated: 1, state: { thread_id: 'old05' } }] }]]);
const global_state = new Map([['monarch.chats.code', [{ thread_id: 'other1', title: 'Anderes Repo', repo: 'other', updated: 2, state: { thread_id: 'other1' } }]]]);
const memento = map => ({ get: key => map.get(key), update: async (key, value) => (value === undefined ? map.delete(key) : map.set(key, value)) });
const settings = {
    apiBaseUrl: 'https://api.awork.com/api/v1', clientId: 'monarch', redirectPort: 18766,
    agents: [{ agentId: 'master', name: 'Mastazilla', coAgentId: 'mini', coAgentName: 'minizilla', labels: { credits: 'Credits', coAgents: 'Minizillas', stop: '/stopzilla' } }],
    maxCredits: 0, maxCoAgents: 3, maxRounds: 20, relayTimeout: 0, pollInterval: 0, maxFolderMB: 20, syncInterval: 4,
};
const uri = path => ({ path, scheme: 'file', toString: () => `file://${path}` });
const git_repository = { state: { HEAD: { name: 'main', upstream: { remote: 'origin', name: 'main' }, ahead: 0 }, remotes: [{ name: 'origin', fetchUrl: 'git@github.com:mrtnRitter/Monarch.git' }], workingTreeChanges: [], indexChanges: [] } };
let file_size = 1;
let clipboard = null;
const terminal_input = [];
const shown = [];
const executed = [];
const opened = [];
const log_lines = [];
let tab_listener = () => {};
const open_tab = input => { vscode.window.tabGroups.activeTabGroup.activeTab = { input }; tab_listener(); };
const vscode = {
    workspace: {
        getConfiguration: section => ({ get: key => (section === 'monarch' ? settings[key] : {}) }),
        workspaceFolders: [{ uri: uri('/repo') }],
        fs: { createDirectory: async () => {}, stat: async target => { if (['/repo/README.md', '/repo/big.bin'].includes(target.path)) return { size: file_size }; throw new Error('missing'); }, writeFile: async () => {}, readFile: async () => Buffer.from('x') },
        asRelativePath: value => value.path.replace('/repo/', ''),
        applyEdit: async () => true,
        openTextDocument: async options => { opened.push(options); return { save: async () => true, getText: () => '', positionAt: () => ({}) }; },
        onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
        tabGroups: { activeTabGroup: { activeTab: null }, onDidChangeTabs: fn => { tab_listener = fn; return { dispose() {} }; } },
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        createOutputChannel: () => ({ appendLine: line => log_lines.push(line), dispose() {} }),
        registerWebviewViewProvider: (id, value) => { provider = value; return { dispose() {} }; },
        showErrorMessage: message => posted.push({ error: message }),
        showInformationMessage: () => {},
        activeTextEditor: null,
        visibleTextEditors: [],
        activeTerminal: null,
        createTerminal: name => ({ name, show() {}, sendText: (text, execute) => terminal_input.push([name, text, execute]) }),
        showTextDocument: async document => shown.push(document),
    },
    commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; }, executeCommand: async id => { executed.push(id); } },
    env: { openExternal: async () => true, clipboard: { writeText: async text => { clipboard = text; } } },
    languages: { getLanguages: async () => ['python', 'plaintext', 'shellscript'] },
    extensions: { getExtension: id => (id === 'vscode.git' ? { isActive: true, exports: { getAPI: () => ({ getRepository: () => git_repository }) } } : undefined) },
    Uri: { parse: value => value, joinPath: (base, ...parts) => uri([base.path, ...parts].join('/')) },
    WorkspaceEdit: class { createFile() {} insert() {} replace() {} },
    Position: class {}, Range: class {}, RelativePattern: class {},
};
const original_load = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : original_load.call(this, request, ...rest);
};

const secrets = new Map([['monarch.oauth', JSON.stringify({ access_token: 'user', refresh_token: 'r', expires_at: Date.now() + 3_600_000 })]]);
const context = {
    subscriptions: [],
    secrets: { get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value), delete: async key => secrets.delete(key) },
    workspaceState: memento(workspace_state),
    globalState: memento(global_state),
    extensionUri: uri('/ext'),
};

// fake awork API over fetch
const bodies = [];
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).buffer;
global.fetch = async (url, options) => {
    const parsed = new URL(url);
    const route = parsed.pathname.replace('/api/v1', '');
    const reply = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    const missing = () => ({ ok: false, status: 404, text: async () => 'not found' });
    if (options.body && typeof options.body === 'string') bodies.push({ route, body: JSON.parse(options.body) });
    if (route === '/agents') return reply([{ id: 'master', name: 'Mastazilla', hasImage: true, createdBy: 'other' }, { id: 'mini', name: 'minizilla', createdBy: 'user1' }, { id: 'code', name: 'CodeZilla', createdBy: 'user1' }, { id: 'foreign', name: 'Fremd', createdBy: 'other' }]);
    if (route === '/agents/defaults') return reply({ modelProvider: 'anthropic', modelName: 'opus', reasoningLevel: 'high', availableModels: { providers: [{ provider: 'anthropic', displayName: 'Anthropic', modelDetails: [{ id: 'opus', displayName: 'Claude Opus', supportedReasoningLevels: ['low', 'high'] }] }] } });
    if (route === '/me') return reply({ id: 'user1', firstName: 'Martin', lastName: 'Ritter' });
    if (route === '/files/images/users/user1' || route === '/files/images/agents/master') return { ok: true, status: 200, arrayBuffer: async () => png };
    if (route.startsWith('/files/images/')) return missing();
    if (route === '/agents/threads/old1/messages' || route === '/agents/threads/old1') return missing();
    if (route === '/agents/threads/thread1') return reply({ id: 'thread1', usage: { creditsUsed: 7 } });
    if (route === '/agents/threads' && options.method === 'POST') return reply({ id: 'thread1', acceptedMessageId: 'u1' });
    if (route === '/agents/threads/thread1/messages' && options.method === 'POST') return reply({ acceptedMessageId: 'u2' });
    if (route.endsWith('/status')) return reply({ status: 'completed', hasAgentResponse: true });
    if (route === '/agents/threads/thread1/messages') return reply(thread_messages);
    throw new Error(`unexpected ${options.method} ${route}`);
};

const thread_messages = [{ id: 'u1', role: 'user', content: 'Hallo\n\n[monarch context] x', messageOrder: 1 }, { id: 'a1', role: 'agent', content: 'Hi Martin', messageOrder: 2 }];
const last = type => posted.filter(message => message.type === type).pop();
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

(async () => {
    const extension = require('../src/extension');
    extension.activate(context);
    assert.deepEqual(Object.keys(registered).sort(), ['monarch.newChat', 'monarch.signIn', 'monarch.signOut', 'monarch.stop']);
    const view = { webview: { options: null, html: '', cspSource: 'csp', asWebviewUri: value => value.path, postMessage: message => posted.push(message), onDidReceiveMessage: fn => { on_message = fn; } } };
    provider.resolveWebviewView(view);
    for (const id of ['agents', 'agent', 'history', 'history_menu', 'model', 'model_menu', 'stop', 'new_chat', 'splitter']) assert.match(view.webview.html, new RegExp(`id="${id}"`), id);
    assert.match(view.webview.html, /id="new_chat" class="icon-btn primary"[^>]*><svg/);
    assert.match(view.webview.html, /id="history" class="icon-btn"[^>]*><svg/);
    await on_message({ type: 'ready' });
    await settle();
    // agents from awork: minizilla hidden as co-agent, sorted, avatars
    const init = last('init');
    assert.deepEqual(init.agents.map(agent => agent.name), ['CodeZilla', 'Mastazilla']);
    assert.equal(init.current, 'code');
    assert.equal(init.agents[1].avatar.image.slice(0, 22), 'data:image/png;base64,');
    assert.deepEqual(init.agents[0].avatar, { image: null, initials: 'CZ' });
    assert.ok(init.user.image.startsWith('data:image/png'));
    // 0.5 list moved into the shared list, chats of other repos visible with their repo name
    assert.deepEqual(last('chats').items.map(chat => [chat.thread_id, chat.repo]), [['other1', 'other'], ['old05', 'repo']]);
    assert.equal(workspace_state.has('monarch.chats.code'), false);
    await on_message({ type: 'select_agent', id: 'master' });
    await settle();
    assert.equal(last('init').labels.coAgents, 'Minizillas');
    assert.equal(last('models').default.name, 'opus');
    // the 0.4 chat was taken over, but no longer exists in awork -> removed
    assert.ok(posted.some(message => message.type === 'history' && message.items.some(item => item.role === 'error')));
    assert.deepEqual(global_state.get('monarch.chats.master'), []);
    assert.equal(workspace_state.has('monarch.chat.Mastazilla'), false);
    // chat round trip, then model override on the next message
    await on_message({ type: 'send', text: 'Hallo Welt\nzweite Zeile' });
    assert.equal(posted.filter(message => message.type === 'message' && message.item.role === 'agent').pop().item.text, 'Hi Martin');
    assert.equal(last('status').status.credits, 7);
    await on_message({ type: 'set_model', model: { provider: 'anthropic', name: 'opus', reasoning: 'low' } });
    await on_message({ type: 'send', text: 'Noch was' });
    // context line with the first message only (unchanged afterwards), without open file
    assert.equal(bodies.find(item => item.route === '/agents/threads').body.content, 'Hallo Welt\nzweite Zeile\n\n[monarch context] "this repo" = the repo open in VS Code: repo · online: https://github.com/mrtnRitter/Monarch · branch: main');
    assert.deepEqual(bodies.filter(item => item.route === '/agents/threads/thread1/messages').pop().body, { content: 'Noch was', modelProvider: 'anthropic', modelName: 'opus', reasoningLevel: 'low' });
    // history list, new chat, reopen, remove
    let chats = last('chats').items;
    assert.deepEqual(chats.map(chat => [chat.thread_id, chat.title, chat.repo, chat.current]), [['thread1', 'Hallo Welt', 'repo', true]]);
    assert.equal(global_state.get('monarch.chats.master')[0].thread_id, 'thread1');
    assert.equal(workspace_state.get('monarch.current.master'), 'thread1');
    await on_message({ type: 'new_chat' });
    assert.equal(last('chats').items[0].current, false);
    await on_message({ type: 'open_chat', thread_id: 'thread1' });
    assert.deepEqual(last('history').items.map(item => [item.role, item.text]), [['user', 'Hallo'], ['agent', 'Hi Martin']]);
    // chat continued in the awork web app shows up with the next sync, only when visible and changed
    const histories = () => posted.filter(message => message.type === 'history').length;
    let count = histories();
    view.visible = true;
    await provider._sync();
    assert.equal(histories(), count);
    thread_messages.push({ id: 'u3', role: 'user', content: 'Aus awork', messageOrder: 3 }, { id: 'a3', role: 'agent', content: 'Antwort im Web', messageOrder: 4 });
    view.visible = false;
    await provider._sync();
    assert.equal(histories(), count);
    view.visible = true;
    await provider._sync();
    assert.deepEqual(last('history').items.slice(-2).map(item => item.text), ['Aus awork', 'Antwort im Web']);
    assert.ok(log_lines.some(line => /sync: chat thread1 changed elsewhere, reloading$/.test(line)), log_lines.join('\n'));
    // hints are transient, also "Stop the agent first."
    provider.sessions.get('master').busy = true;
    await on_message({ type: 'select_agent', id: 'code' });
    assert.deepEqual([last('error').text, last('error').transient], ['Stop the agent first.', true]);
    provider.sessions.get('master').busy = false;
    count = histories();
    await provider._sync();
    assert.equal(histories(), count);
    // "Current file": active tab (also preview/custom editor), else the last file; notices are transient
    open_tab({ uri: uri('/repo/README.md'), viewType: 'vscode.markdown.preview.editor' });
    await on_message({ type: 'attach', kind: 'current' });
    assert.deepEqual(last('attachments').items.map(item => item.label), ['README.md']);
    await on_message({ type: 'remove_attachment', id: last('attachments').items[0].id });
    open_tab({ viewType: 'markdown.preview' });
    await on_message({ type: 'attach', kind: 'current' });
    assert.deepEqual(last('attachments').items.map(item => item.label), ['README.md']);
    await on_message({ type: 'remove_attachment', id: last('attachments').items[0].id });
    open_tab({ uri: { path: 'Untitled-1', scheme: 'untitled', toString: () => 'untitled:1' } });
    await on_message({ type: 'attach', kind: 'current' });
    assert.deepEqual([last('error').text, last('error').transient], ['Save the file first, then attach it.', true]);
    file_size = 30 * 1024 * 1024;
    open_tab({ uri: uri('/repo/big.bin') });
    await on_message({ type: 'attach', kind: 'current' });
    assert.match(last('error').text, /big\.bin exceeds monarch\.maxFolderMB \(20 MB\)/);
    assert.deepEqual(last('attachments').items, []);
    file_size = 1;
    // input height is kept and sent with init
    await on_message({ type: 'input_height', height: 240.4 });
    assert.equal(global_state.get('monarch.inputHeight'), 240);
    await on_message({ type: 'ready' });
    assert.equal(last('init').input_height, 240);
    await settle();
    assert.equal(last('chats').items[0].current, true);
    assert.equal(last('status').status.model.reasoning, 'low');
    await on_message({ type: 'remove_chat', thread_id: 'thread1' });
    assert.deepEqual(last('chats').items, []);
    assert.ok(!posted.some(message => message.error), JSON.stringify(posted.filter(message => message.error)));
    const errors = posted.filter(message => message.type === "error" && !message.transient); assert.deepEqual(errors, [], JSON.stringify(errors));
    // code block actions and copy answer
    await on_message({ type: 'code_action', action: 'copy', code: 'x = 1', language: 'py' });
    assert.equal(clipboard, 'x = 1');
    await on_message({ type: 'copy', text: '**Antwort**' });
    assert.equal(clipboard, '**Antwort**');
    await on_message({ type: 'code_action', action: 'new_file', code: 'x = 1', language: 'py' });
    await on_message({ type: 'code_action', action: 'new_file', code: 'x', language: 'unknownlang' });
    assert.deepEqual(opened.slice(-2), [{ language: 'python', content: 'x = 1' }, { language: 'plaintext', content: 'x' }]);
    await on_message({ type: 'code_action', action: 'insert', code: 'x = 1', language: 'py' });
    assert.deepEqual([last('error').text, last('error').transient], ['Open a file in the editor first, then insert.', true]);
    const edits = [];
    const editor = { document: { isClosed: false, uri: uri('/repo/a.py') }, selections: ['s1', 's2'], viewColumn: 1, edit: async fn => { fn({ replace: (selection, text) => edits.push([selection, text]) }); return true; } };
    vscode.window.visibleTextEditors = [editor];
    provider.last_editor = editor;
    await on_message({ type: 'code_action', action: 'insert', code: 'y', language: '' });
    assert.deepEqual(edits, [['s1', 'y'], ['s2', 'y']]);
    await on_message({ type: 'code_action', action: 'terminal', code: 'ls -la\n', language: 'sh' });
    assert.deepEqual(terminal_input, [['monarch', 'ls -la', false]]);
    await on_message({ type: 'code_action', action: 'terminal', code: 'a\nb', language: 'sh' });
    assert.deepEqual([clipboard, executed.at(-1), terminal_input.length], ['a\nb', 'workbench.action.terminal.paste', 1]);
    // restart in another repo: same shared list, no current chat there
    vscode.workspace.workspaceFolders = [{ uri: uri('/repo2') }];
    const fresh = new (require('../src/chat_view').ChatView)({ ...context, workspaceState: memento(new Map()) }, null, null);
    assert.deepEqual(fresh._chats({ agentId: 'code', name: 'CodeZilla' }), { current: null, items: global_state.get('monarch.chats.code') });
    assert.deepEqual(global_state.get('monarch.chats.code').map(chat => chat.thread_id), ['other1', 'old05']);
    console.log("extension smoke test passed");
})().catch(error => { console.error(error); process.exit(1); });
