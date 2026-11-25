'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const make_uri = fs_path => ({ fsPath: fs_path, path: fs_path, scheme: 'file', toString: () => fs_path });
let open_folders = [];
let repos = [];
let fail_list_repos = false;
let open_dialog_uris = [];
let repo_facts = { git: true, remote: 'https://github.com/u/X.git', branch: 'main', changes: 0, ahead: 0 };

const vscode = {
    Uri: {
        joinPath: (base, ...parts) => make_uri(path.join(base?.fsPath || '', ...parts)),
        file: fs_path => make_uri(fs_path),
    },
    workspace: {
        get workspaceFolders() { return open_folders.map(({ name, uri }) => ({ name, uri })); },
        getConfiguration: () => ({ get: key => key === 'maxFolderMB' ? 5 : null }),
        asRelativePath: uri => uri.fsPath,
        fs: {
            stat: async uri => fs.stat(uri.fsPath),
        },
    },
    window: {
        showOpenDialog: async () => open_dialog_uris,
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        terminals: [],
    },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
};

const palette = [
    { theme: 'terminal.ansiBlue', hex: '#3b8eea', icon: 'repo_0.svg' },
    { theme: 'terminal.ansiGreen', hex: '#23d18b', icon: 'repo_1.svg' },
    { theme: 'terminal.ansiYellow', hex: '#e5e510', icon: 'repo_2.svg' },
    { theme: 'terminal.ansiMagenta', hex: '#d670d6', icon: 'repo_3.svg' },
    { theme: 'terminal.ansiCyan', hex: '#29b8db', icon: 'repo_4.svg' },
    { theme: 'terminal.ansiRed', hex: '#f14c4c', icon: 'repo_5.svg' },
];

const workspace_mock = {
    folders: () => open_folders,
    list_repos: async () => {
        if (fail_list_repos) throw new Error('repo scan failed');
        return repos;
    },
    find_repo: async ({ name = null, path: repo_path = null } = {}) => {
        if (repo_path) {
            try {
                if ((await fs.stat(repo_path)).isDirectory()) {
                    const uri = make_uri(path.resolve(repo_path));
                    const folder = open_folders.find(item => path.resolve(item.uri.fsPath) === uri.fsPath);
                    return { name: name || path.basename(repo_path), uri, open: Boolean(folder) };
                }
            } catch {}
        }
        return repos.find(item => item.name === name) || null;
    },
    make_repo_colors: memento => {
        let assigned = { ...(memento.get('monarch.repoColors') || {}) };
        const slot = name => {
            const key = String(name || '').toLowerCase();
            if (!key) return 0;
            if (!Number.isInteger(assigned[key])) {
                const used = new Set(Object.values(assigned));
                assigned[key] = palette.findIndex((_, index) => !used.has(index));
                if (assigned[key] < 0) assigned[key] = 0;
                void memento.update('monarch.repoColors', assigned);
            }
            return assigned[key];
        };
        return {
            slot,
            color: name => palette[slot(name)],
            peek: name => Number.isInteger(assigned[String(name || '').toLowerCase()]) ? palette[assigned[String(name).toLowerCase()]] : null,
        };
    },
    make_workspace_adapter: () => ({}),
};

const git_mock = { repo_info: async () => repo_facts };
const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    if (request === './workspace' && parent?.filename.endsWith('/src/chat_view.js')) return workspace_mock;
    if (request === './git' && parent?.filename.endsWith('/src/chat_view.js')) return git_mock;
    return original_load.call(this, request, parent, is_main);
};
const { ChatView } = require('../src/chat_view');
const { Notice } = require('../src/session');
Module._load = original_load;

function set_repos(names = ['A', 'B']) {
    open_folders = names.map((name, index) => ({ name, uri: make_uri(`/r/${name}`), index }));
    repos = open_folders.map(folder => ({ ...folder, open: true }));
}

function harness(initial_values = {}, options = {}, names = ['A', 'B'], all_repos = null) {
    set_repos(names);
    if (all_repos) repos = all_repos;
    fail_list_repos = false;
    const state = new Map(Object.entries({ 'monarch.repoColors': { a: 0 }, ...initial_values }));
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

const agent = { agentId: 'a1', name: 'Z', labels: {} };
const repo = (name, fs_path, open = false) => ({ name, uri: make_uri(fs_path), open });
const pause = () => new Promise(resolve => setImmediate(resolve));

async function main() {
    const initial = harness();
    assert.equal(initial.chat.current_repo().name, 'A');
    const original_platform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        assert.equal(initial.chat._same_path('C:\\Repo\\Path', 'c:\\repo\\path'), true);
        assert.equal(initial.chat._same_path('C:\\Repo\\Path', 'C:\\Repo\\Other'), false);
    } finally {
        Object.defineProperty(process, 'platform', original_platform);
    }
    assert.equal(initial.chat._root().fsPath, '/r/A');

    const list = harness({}, {}, ['A', 'B'], [repo('A', '/r/A', true), repo('X', '/r/X'), repo('Y', '/r/Y')]);
    await list.chat._on_message({ type: 'list_repos' });
    const repos_message = list.posted.find(message => message.type === 'repos');
    assert(repos_message);
    assert.equal(repos_message.items.filter(item => item.current).length, 1);
    assert.equal(repos_message.items.find(item => item.name === 'A').current, true);
    assert.equal(repos_message.items.find(item => item.name === 'X').current, false);
    assert.equal(repos_message.items.find(item => item.name === 'Y').hex, null);
    fail_list_repos = true;
    await assert.doesNotReject(() => list.chat._on_message({ type: 'list_repos' }));
    assert.deepEqual(list.posted.filter(message => message.type === 'repos').at(-1).items, []);
    fail_list_repos = false;

    const selected = harness({}, {}, ['A', 'B'], [repo('A', '/r/A', true), repo('X', '/r/X')]);
    await selected.chat._on_message({ type: 'select_repo', path: '/r/X' });
    assert.equal(selected.chat.current_repo().name, 'X');
    assert(selected.posted.some(message => message.type === 'repo' && message.repo.name === 'X' && message.repo.path === '/r/X' && message.repo.hex));

    const threaded = harness({ 'monarch.chats.a1': [{ thread_id: 't1', title: 'Existing', repo: 'A', repo_path: '/r/A', updated: 1, state: { thread_id: 't1' } }] }, {}, ['A'], [repo('A', '/r/A', true), repo('X', '/r/X')]);
    threaded.chat.agent_list = [agent];
    const thread_session = { busy: false, state: { thread_id: 't1', staged: {}, co_agents: {} } };
    threaded.chat._session = () => thread_session;
    await threaded.chat._on_message({ type: 'select_repo', path: '/r/X' });
    await pause();
    const stored_thread = threaded.state.get('monarch.chats.a1').find(item => item.thread_id === 't1');
    assert.equal(stored_thread.repo, 'X');
    assert.equal(stored_thread.repo_path, '/r/X');

    for (const session of [
        { busy: true, state: { staged: {}, co_agents: {} } },
        { busy: false, state: { staged: { 'a.py': {} }, co_agents: {} } },
        { busy: false, state: { staged: {}, co_agents: { c1: { state: 'working' } } } },
    ]) {
        const blocked = harness({}, {}, ['A'], [repo('A', '/r/A', true), repo('X', '/r/X')]);
        blocked.chat.agent_list = [agent];
        blocked.chat._session = () => session;
        await blocked.webview.receive({ type: 'select_repo', path: '/r/X' });
        assert.equal(blocked.chat.current_repo().name, 'A');
        assert(blocked.posted.some(message => message.type === 'error' && message.text === 'Change the repo when the agent has finished and no files are staged.'));
    }

    const outside = harness({}, {}, ['A'], [repo('A', '/r/A', true)]);
    await assert.rejects(outside.chat._on_message({ type: 'select_repo', path: '/outside' }), error => error instanceof Notice && error.message === 'Repo not found.');
    assert.equal(outside.chat.current_repo().name, 'A');

    const busy_open = harness({ 'monarch.chats.a1': [{ thread_id: 't_busy', repo: 'X', repo_path: '/r/X', updated: 1, state: { thread_id: 't_busy' } }] }, {}, ['A'], [repo('A', '/r/A', true), repo('X', '/r/X')]);
    busy_open.chat.agent_list = [agent];
    busy_open.chat._session = () => ({
        busy: true,
        state: { thread_id: 't_current' },
        load_state() { throw new Notice('Stop the agent first.'); },
    });
    await assert.rejects(busy_open.chat._open_chat('t_busy'), error => error instanceof Notice && error.message === 'Stop the agent first.');
    assert.equal(busy_open.chat.current_repo().name, 'A');

    const race_select = harness({}, {}, ['A'], [repo('A', '/r/A', true), repo('X', '/r/X')]);
    race_select.chat.agent_list = [agent];
    const select_session = { busy: false, state: { thread_id: null, staged: {}, co_agents: {} } };
    race_select.chat._session = () => select_session;
    const pending_select = race_select.chat._on_message({ type: 'select_repo', path: '/r/X' });
    select_session.busy = true;
    await assert.rejects(pending_select, error => error instanceof Notice && error.message.includes('finished'));
    assert.equal(race_select.chat.current_repo().name, 'A');

    const race_open = harness({ 'monarch.chats.a1': [{ thread_id: 't_race', repo: 'X', repo_path: '/r/X', updated: 1, state: { thread_id: 't_race' } }] }, {}, ['A'], [repo('A', '/r/A', true), repo('X', '/r/X')]);
    race_open.chat.agent_list = [agent];
    const open_session = { busy: false, state: { thread_id: null }, load_state() { this.loaded = true; } };
    race_open.chat._session = () => open_session;
    const pending_open = race_open.chat._open_chat('t_race');
    open_session.busy = true;
    await assert.rejects(pending_open, error => error instanceof Notice && error.message === 'Stop the agent first.');
    assert.equal(race_open.chat.current_repo().name, 'A');
    assert.equal(open_session.loaded, undefined);

    let routed_notes;
    const notes_chat = harness({}, { set_notes: (...args) => { routed_notes = args; return true; } }, ['A']);
    notes_chat.chat.agent_list = [agent];
    const note_session = {
        state: { title: 'Notes title' },
        notes: () => ({ text: 'current note', rev: 11 }),
        set_notes(text, rev) { this.applied = [text, rev]; return rev === 11; },
    };
    notes_chat.chat.sessions.set(agent.agentId, note_session);
    assert.deepEqual(notes_chat.chat.notes_entry(), { id: notes_chat.chat.id, repo: 'A', hex: palette[0].hex, title: 'Notes title', text: 'current note', rev: 11 });
    const groups = [{ id: 'another-chat' }];
    notes_chat.chat.post_notes_groups(groups);
    assert.deepEqual(notes_chat.posted.at(-1), { type: 'notes_groups', groups });
    assert.equal(notes_chat.chat.apply_notes('updated note', 11), true);
    assert.deepEqual(note_session.applied, ['updated note', 11]);
    assert.deepEqual(notes_chat.posted.at(-1), { type: 'notes', text: 'updated note', rev: 11, agent: agent.agentId });
    await notes_chat.chat._on_message({ type: 'set_notes', text: 'routed note', rev: 12 });
    assert.deepEqual(routed_notes, [notes_chat.chat.id, 'routed note', 12]);

    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-view-repo-'));
    const from_history = harness({ 'monarch.chats.a1': [{ thread_id: 't2', repo: 'X', repo_path: temp_root, updated: 1, state: { thread_id: 't2' } }] }, {}, ['A'], [repo('A', '/r/A', true), repo('X', temp_root)]);
    from_history.chat.agent_list = [agent];
    const load_session = { state: { thread_id: null }, load_state: state => { load_session.loaded = state; from_history.chat._store(agent).save(state); }, refresh_credits() {} };
    from_history.chat._session = () => load_session;
    from_history.chat._show_history = async () => {};
    await from_history.chat._open_chat('t2');
    assert.equal(from_history.chat.current_repo().name, 'X');
    assert.equal(from_history.chat.current_repo().uri.fsPath, temp_root);
    const reopened_thread = from_history.state.get('monarch.chats.a1').find(item => item.thread_id === 't2');
    assert.equal(reopened_thread.repo, 'X');
    assert.equal(reopened_thread.repo_path, temp_root);

    const unchanged = harness({}, { repo: { name: 'A', uri: make_uri('/r/A') } }, ['A'], [repo('A', '/r/A', true)]);
    unchanged.chat.agent_list = [agent];
    const unchanged_session = { state: { thread_id: null }, load_state() {}, refresh_credits() {} };
    unchanged.chat._session = () => unchanged_session;
    unchanged.chat._show_history = async () => {};
    unchanged.state.set('monarch.chats.a1', [{ thread_id: 't3', repo: 'Unknown', repo_path: null, updated: 1, state: { thread_id: 't3' } }]);
    await unchanged.chat._open_chat('t3');
    assert.equal(unchanged.chat.current_repo().name, 'A');

    const context_chat = harness({}, { repo: { name: 'X', uri: make_uri('/r/X') } }, ['A'], [repo('A', '/r/A', true), repo('X', '/r/X')]);
    repo_facts = { git: true, remote: 'https://github.com/u/X.git', branch: 'main', changes: 0, ahead: 0 };
    const context = await context_chat.chat._context();
    assert.match(context, /"this repo" = the repo of this chat: X/);
    assert.match(context, /online: https:\/\/github\.com\/u\/X/);
    repo_facts = { git: true, remote: 'https://github.com/u/X.git', branch: 'main', changes: 0, ahead: 0 };

    const attach = harness({}, { repo: { name: 'X', uri: make_uri(temp_root) } }, ['A'], [repo('A', '/r/A', true)]);
    await fs.mkdir(path.join(temp_root, 'sub'));
    await fs.writeFile(path.join(temp_root, 'sub', 'a.txt'), 'attachment');
    open_dialog_uris = [make_uri(path.join(temp_root, 'sub', 'a.txt'))];
    await attach.chat._attach('files');
    assert.equal(attach.chat.attachments[0].label, 'sub/a.txt');
    open_dialog_uris = [];

    const repo_button = harness();
    assert.match(repo_button.webview.html, /<div class="menu-wrap repo-wrap"><button id="repo" class="repo-btn" title="Repo of this chat">/);
    await fs.rm(temp_root, { recursive: true, force: true });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
