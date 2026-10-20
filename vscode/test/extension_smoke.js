'use strict';
// Loads the extension with a stubbed vscode module: activation, commands, webview html and a chat round trip.
const assert = require('assert/strict');
const Module = require('module');

const registered = {};
const posted = [];
let provider = null;
let on_message = null;
const workspace_state = new Map();
const settings = {
    apiBaseUrl: 'https://api.awork.com/api/v1', clientId: 'client', redirectPort: 18766,
    agents: [{ name: 'Mastazilla', agentId: 'master', coAgentId: 'mini', coAgentName: 'minizilla', labels: { credits: 'Credits', coAgents: 'Minizillas', stop: '/stopzilla' } }, { name: 'CodeZilla', agentId: 'code' }],
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
let message_count = 0;
global.fetch = async (url, options) => {
    const route = new URL(url).pathname.replace('/api/v1', '');
    const reply = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    if (route === '/agents/management/threads') return reply([{ id: 'thread1', creditsUsed: 7 }]);
    if (route === '/me') return reply({ id: 'user1', firstName: 'Martin', lastName: 'Ritter' });
    if (route === '/files/images/users/user1') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).buffer };
    if (route.startsWith('/files/images/agents/')) return { ok: false, status: 404, text: async () => 'not found' };
    if (route === '/agents/threads' && options.method === 'POST') return reply({ id: 'thread1', acceptedMessageId: 'u1' });
    if (route.endsWith('/status')) return reply({ status: 'completed', hasAgentResponse: true });
    if (route === '/agents/threads/thread1/messages') { message_count += 1; return reply([{ id: 'u1', role: 'user', content: 'Hallo', messageOrder: 1 }, { id: 'a1', role: 'agent', content: 'Hi Martin', messageOrder: 2 }]); }
    throw new Error(`unexpected ${options.method} ${route}`);
};

(async () => {
    const extension = require('../src/extension');
    extension.activate(context);
    assert.deepEqual(Object.keys(registered).sort(), ['monarch.clearApiKey', 'monarch.newChat', 'monarch.setApiKey', 'monarch.signIn', 'monarch.signOut', 'monarch.stop']);
    const view = { webview: { options: null, html: '', cspSource: 'csp', asWebviewUri: value => value.path, postMessage: message => posted.push(message), onDidReceiveMessage: fn => { on_message = fn; } } };
    provider.resolveWebviewView(view);
    assert.match(view.webview.html, /id="stop"/);
    assert.match(view.webview.html, /script-src 'nonce-/);
    await on_message({ type: 'ready' });
    await new Promise(resolve => setTimeout(resolve, 20));
    const init = posted.find(message => message.type === 'init');
    assert.deepEqual([init.current, init.signed_in, init.labels.coAgents], ['Mastazilla', true, 'Minizillas']);
    assert.ok(init.avatars.user.image.startsWith('data:image/png;base64,'));
    assert.deepEqual(init.avatars.agent, { image: null, initials: 'M' });
    assert.match(view.webview.html, /img-src data:/);
    assert.match(view.webview.html, /markdown\.js/);
    await on_message({ type: 'send', text: 'Hallo' });
    const agent_message = posted.filter(message => message.type === 'message' && message.item.role === 'agent').pop();
    assert.equal(agent_message.item.text, 'Hi Martin');
    const status = posted.filter(message => message.type === 'status').pop().status;
    assert.equal(status.credits, 7);
    assert.equal(workspace_state.get('monarch.chat.Mastazilla').thread_id, 'thread1');
    await on_message({ type: 'select_agent', name: 'CodeZilla' });
    const code_init = posted.filter(message => message.type === 'init').pop();
    assert.equal(code_init.labels.stop, 'Stop');
    assert.equal(code_init.avatars.agent.initials, 'CZ');
    assert.ok(!posted.some(message => message.type === 'error' || message.error), JSON.stringify(posted.filter(message => message.type === 'error' || message.error)));
    console.log('extension smoke test passed');
})().catch(error => { console.error(error); process.exit(1); });
