'use strict';
// Loads the extension with a stubbed vscode module: activation, agents from awork, history, model choice, a chat round trip.
const assert = require('assert/strict');
const Module = require('module');

const registered = {};
const posted = [];
let provider = null;
let on_message = null;
const workspace_state = new Map([['monarch.chat.Mastazilla', { thread_id: 'old1', rounds: 0, next_index: 1, co_agents: {} }]]);
const settings = {
    apiBaseUrl: 'https://api.awork.com/api/v1', clientId: 'monarch', redirectPort: 18766,
    agents: [{ agentId: 'master', name: 'Mastazilla', coAgentId: 'mini', coAgentName: 'minizilla', labels: { credits: 'Credits', coAgents: 'Minizillas', stop: '/stopzilla' } }],
    maxCredits: 0, maxCoAgents: 3, maxRounds: 20, relayTimeout: 0, pollInterval: 0, maxFolderMB: 20,
};
const uri = path => ({ path, scheme: 'file', toString: () => `file://${path}` });
const vscode = {
    workspace: {
        getConfiguration: section => ({ get: key => (section === 'monarch' ? settings[key] : {}) }),
        workspaceFolders: [{ uri: uri('/repo') }],
        fs: { createDirectory: async () => {}, stat: async () => { throw new Error('missing'); }, writeFile: async () => {}, readFile: async () => Buffer.from('x') },
        asRelativePath: value => value.path.replace('/repo/', ''),
        applyEdit: async () => true,
        openTextDocument: async () => ({ save: async () => true, getText: () => '', positionAt: () => ({}) }),
        onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
        registerWebviewViewProvider: (id, value) => { provider = value; return { dispose() {} }; },
        showErrorMessage: message => posted.push({ error: message }),
        showInformationMessage: () => {},
        activeTextEditor: null,
    },
    commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
    env: { openExternal: async () => true },
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
    workspaceState: { get: key => workspace_state.get(key), update: async (key, value) => workspace_state.set(key, value) },
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
    if (route === '/agents/threads/thread1/messages') return reply([{ id: 'u1', role: 'user', content: 'Hallo', messageOrder: 1 }, { id: 'a1', role: 'agent', content: 'Hi Martin', messageOrder: 2 }]);
    throw new Error(`unexpected ${options.method} ${route}`);
};

const last = type => posted.filter(message => message.type === type).pop();
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

(async () => {
    const extension = require('../src/extension');
    extension.activate(context);
    assert.deepEqual(Object.keys(registered).sort(), ['monarch.newChat', 'monarch.signIn', 'monarch.signOut', 'monarch.stop']);
    const view = { webview: { options: null, html: '', cspSource: 'csp', asWebviewUri: value => value.path, postMessage: message => posted.push(message), onDidReceiveMessage: fn => { on_message = fn; } } };
    provider.resolveWebviewView(view);
    for (const id of ['agents', 'agent', 'history', 'history_menu', 'model', 'model_menu', 'stop', 'new_chat']) assert.match(view.webview.html, new RegExp(`id="${id}"`), id);
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
    await on_message({ type: 'select_agent', id: 'master' });
    await settle();
    assert.equal(last('init').labels.coAgents, 'Minizillas');
    assert.equal(last('models').default.name, 'opus');
    // the 0.4 chat was taken over, but no longer exists in awork -> removed
    assert.ok(posted.some(message => message.type === 'history' && message.items.some(item => item.role === 'error')));
    assert.deepEqual(workspace_state.get('monarch.chats.master').items, []);
    // chat round trip, then model override on the next message
    await on_message({ type: 'send', text: 'Hallo Welt\nzweite Zeile' });
    assert.equal(posted.filter(message => message.type === 'message' && message.item.role === 'agent').pop().item.text, 'Hi Martin');
    assert.equal(last('status').status.credits, 7);
    await on_message({ type: 'set_model', model: { provider: 'anthropic', name: 'opus', reasoning: 'low' } });
    await on_message({ type: 'send', text: 'Noch was' });
    assert.deepEqual(bodies.filter(item => item.route === '/agents/threads/thread1/messages').pop().body, { content: 'Noch was', modelProvider: 'anthropic', modelName: 'opus', reasoningLevel: 'low' });
    // history list, new chat, reopen, remove
    let chats = last('chats').items;
    assert.deepEqual(chats.map(chat => [chat.thread_id, chat.title, chat.current]), [['thread1', 'Hallo Welt', true]]);
    await on_message({ type: 'new_chat' });
    assert.equal(last('chats').items[0].current, false);
    await on_message({ type: 'open_chat', thread_id: 'thread1' });
    await settle();
    assert.equal(last('chats').items[0].current, true);
    assert.equal(last('status').status.model.reasoning, 'low');
    await on_message({ type: 'remove_chat', thread_id: 'thread1' });
    assert.deepEqual(last('chats').items, []);
    assert.ok(!posted.some(message => message.error), JSON.stringify(posted.filter(message => message.error)));
    const errors = posted.filter(message => message.type === "error"); assert.deepEqual(errors, [], JSON.stringify(errors));
    console.log("extension smoke test passed");
})().catch(error => { console.error(error); process.exit(1); });
