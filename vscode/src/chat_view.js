'use strict';
/** Webview chat window: agents from awork, chat history, model choice, status (credits, co-agents, stop), messages and attachments. */
const vscode = require('vscode');
const crypto = require('crypto');
const { ChatSession } = require('./session');
const { create_zip } = require('./zip');
const { context_line, git_info } = require('./repo');

const fixed_excludes = ['**/.git/**', '**/node_modules/**', '**/__pycache__/**', '**/.venv/**', '**/*.pyc'];
const default_labels = { credits: 'Credits', coAgents: 'Co-agents', stop: 'Stop' };
const image_types = [[[0x89, 0x50, 0x4e, 0x47], 'image/png'], [[0xff, 0xd8, 0xff], 'image/jpeg'], [[0x47, 0x49, 0x46], 'image/gif'], [[0x52, 0x49, 0x46, 0x46], 'image/webp']];
const mime_types = { '.py': 'text/x-python', '.md': 'text/markdown', '.json': 'application/json', '.txt': 'text/plain', '.zip': 'application/zip' };
const max_chats = 100;
const max_attachments = 20;
const notice_types = new Set(['attach']);

function _config() {
    return vscode.workspace.getConfiguration('monarch');
}

function _root() {
    return vscode.workspace.workspaceFolders?.[0]?.uri || null;
}

function _decode_text(data) {
    if (data.includes(0)) return null;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
        return null;
    }
}

function _data_uri(data) {
    const bytes = Buffer.from(data);
    const head = bytes.subarray(0, 200).toString('utf8').trimStart();
    const type = image_types.find(([magic]) => magic.every((byte, index) => bytes[index] === byte))?.[1] || (/^(<\?xml|<svg)/i.test(head) ? 'image/svg+xml' : null);
    return type ? `data:${type};base64,${bytes.toString('base64')}` : null;
}

/** File behind an editor tab: text, diff (modified side), custom editor, notebook; null for webviews, terminals etc. */
function _tab_uri(tab) {
    const input = tab?.input;
    return input?.uri || input?.modified || null;
}

/** Repository of the VS Code git API for uri; null = no repository, undefined = git not available. */
async function _git_repository(uri) {
    const extension = vscode.extensions?.getExtension('vscode.git');
    if (!extension) return undefined;
    try {
        const git = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
        return git.getRepository(uri) || null;
    } catch {
        return undefined;
    }
}

const _chats_key = agent => `monarch.chats.${agent.agentId}`;
const _current_key = agent => `monarch.current.${agent.agentId}`;

function _repo_name() {
    return _root()?.path.split('/').filter(Boolean).pop() || null;
}

/** Deduplicate by thread (newest entry wins), newest first, at most max_chats. */
function _merge_chats(items) {
    const newest = new Map();
    for (const item of items) if (!(newest.get(item.thread_id)?.updated >= item.updated)) newest.set(item.thread_id, item);
    return [...newest.values()].sort((a, b) => b.updated - a.updated).slice(0, max_chats);
}

function _initials(name) {
    const capitals = (name || '').match(/\p{Lu}/gu) || [];
    return (capitals.length ? capitals : [(name || '?')[0]]).slice(0, 2).join('').toUpperCase();
}

function _exclude_glob() {
    const user = Object.entries(vscode.workspace.getConfiguration('files').get('exclude') || {}).filter(([, on]) => on === true).flatMap(([pattern]) => [pattern, `${pattern}/**`]);
    return `{${[...fixed_excludes, ...user].join(',')}}`;
}

/**
 * Merge awork agents with the optional settings overrides; agents used as co-agent are hidden.
 * filter 'own' keeps agents created by me_id plus agents listed in the overrides; 'all' keeps every visible agent.
 */
function merge_agents(aworks, overrides, { filter = 'all', me_id = null } = {}) {
    const find_override = agent => overrides.find(item => item && item.agentId === agent.id) || overrides.find(item => item && !item.agentId && item.name === agent.name);
    const override_of = agent => find_override(agent) || {};
    const wanted = agent => filter !== 'own' || (me_id && agent.createdBy === me_id) || Boolean(find_override(agent));
    const merged = aworks.filter(agent => agent.id && !agent.isArchived && wanted(agent)).map(agent => {
        const override = override_of(agent);
        return { agentId: agent.id, name: agent.name || 'Agent', has_image: Boolean(agent.hasImage), coAgentId: override.coAgentId || '', coAgentName: override.coAgentName || 'coagent', labels: { ...default_labels, ...(override.labels || {}) } };
    });
    const co_agent_ids = new Set(merged.map(agent => agent.coAgentId).filter(Boolean));
    return merged.filter(agent => !co_agent_ids.has(agent.agentId)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Text models from GET /agents/defaults: {default: {provider, name, reasoning}, models: [{provider, provider_name, name, display, levels, factor}]}. */
function parse_models(defaults) {
    const providers = defaults?.availableModels?.providers || [];
    const models = providers.flatMap(provider => (provider.modelDetails || [])
        .filter(model => (model.kind || 'text') === 'text' && model.isAvailable !== false && (model.status || 'active') === 'active')
        .map(model => ({ provider: provider.provider, provider_name: provider.displayName || provider.provider, name: model.id, display: model.displayName || model.id, levels: (model.supportedReasoningLevels || []).filter(Boolean), factor: model.creditFactor ?? null })));
    return { default: { provider: defaults?.modelProvider || null, name: defaults?.modelName || null, reasoning: defaults?.reasoningLevel || null }, models };
}

/** Repo access for the session: writes text as undoable edit, binary directly. */
const workspace_adapter = {
    async write(path, data) {
        const root = _root();
        if (!root) throw new Error('no folder open');
        const uri = vscode.Uri.joinPath(root, ...path.split('/'));
        const text = typeof data === 'string' ? data : _decode_text(data);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
        if (text === null) {
            await vscode.workspace.fs.writeFile(uri, data);
            return path;
        }
        const edit = new vscode.WorkspaceEdit();
        const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
        if (exists) {
            const document = await vscode.workspace.openTextDocument(uri);
            edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
        } else {
            edit.createFile(uri, { ignoreIfExists: true });
            edit.insert(uri, new vscode.Position(0, 0), text);
        }
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error('edit rejected');
        await (await vscode.workspace.openTextDocument(uri)).save();
        return path;
    },
};

class ChatView {
    constructor(context, client, oauth) {
        Object.assign(this, { context, client, oauth, view: null, sessions: new Map(), attachments: [], avatars: new Map(), user_avatar: null, me: null, agent_list: null, models: new Map(), last_file: null, sync_timer: null });
        // remember the last file so that "Current file" also works while a preview or other non-file tab is active
        const remember = uri => { if (uri && uri.scheme !== 'untitled') this.last_file = uri; };
        remember(_tab_uri(vscode.window.tabGroups?.activeTabGroup?.activeTab) || vscode.window.activeTextEditor?.document.uri);
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor?.(editor => remember(editor?.document.uri)) || { dispose() {} },
            vscode.window.tabGroups?.onDidChangeTabs?.(() => remember(_tab_uri(vscode.window.tabGroups.activeTabGroup?.activeTab))) || { dispose() {} },
            { dispose: () => clearTimeout(this.sync_timer) },
        );
    }

    /** Drop everything that belongs to the signed-in user (after sign-in or sign-out). */
    forget_user() {
        Object.assign(this, { agent_list: null, user_avatar: null, me: null });
        this.models.clear();
        this.sessions.clear();
    }

    // --- agents ---
    async _load_agents(force = false) {
        if (!this.agent_list || force) {
            const filter = _config().get('agentFilter') || 'own';
            const me = filter === 'own' ? await this._me().catch(() => null) : null;
            this.agent_list = merge_agents(await this.client.agents(), _config().get('agents') || [], { filter, me_id: me?.id || null });
        }
        return this.agent_list;
    }

    _agent() {
        const agents = this.agent_list || [];
        const stored = this.context.workspaceState.get('monarch.agent');
        return agents.find(agent => agent.agentId === stored || agent.name === stored) || agents[0] || null;
    }

    _limits() {
        const config = _config();
        return Object.fromEntries(['maxCredits', 'maxCoAgents', 'maxRounds', 'relayTimeout', 'pollInterval'].map(key => [key, config.get(key)]));
    }

    async _models(agent) {
        if (!this.models.has(agent.agentId)) this.models.set(agent.agentId, this.client.agent_defaults(agent.agentId).then(parse_models, () => { this.models.delete(agent.agentId); return { default: {}, models: [] }; }));
        return this.models.get(agent.agentId);
    }

    // --- chats (list per agent shared by all repos, current chat per repo) ---
    _chats(agent) {
        this._migrate_chats(agent);
        return { current: this.context.workspaceState.get(_current_key(agent)) ?? null, items: this.context.globalState.get(_chats_key(agent)) || [] };
    }

    /** Move the per-repo lists of 0.4 (single chat) and 0.5 into the shared list. */
    _migrate_chats(agent) {
        const workspace = this.context.workspaceState;
        const legacy_keys = [_chats_key(agent), `monarch.chat.${agent.name}`];
        const [list, single] = legacy_keys.map(key => workspace.get(key));
        if (!list && !single) return;
        const legacy = list || (single.thread_id ? { current: single.thread_id, items: [{ thread_id: single.thread_id, title: single.title || 'Earlier chat', updated: Date.now(), state: single }] } : null);
        if (legacy) {
            const repo = _repo_name();
            this.context.globalState.update(_chats_key(agent), _merge_chats([...(this.context.globalState.get(_chats_key(agent)) || []), ...legacy.items.map(item => ({ repo, ...item }))]));
            if (workspace.get(_current_key(agent)) === undefined) workspace.update(_current_key(agent), legacy.current || null);
        }
        for (const key of legacy_keys) workspace.update(key, undefined);
    }

    _save_chats(agent, chats) {
        return Promise.all([this.context.globalState.update(_chats_key(agent), _merge_chats(chats.items)), this.context.workspaceState.update(_current_key(agent), chats.current)]);
    }

    _store(agent) {
        return {
            load: () => {
                const chats = this._chats(agent);
                return chats.items.find(item => item.thread_id === chats.current)?.state;
            },
            save: state => {
                const chats = this._chats(agent);
                chats.current = state.thread_id || null;
                if (state.thread_id) {
                    const item = chats.items.find(entry => entry.thread_id === state.thread_id);
                    const entry = { thread_id: state.thread_id, title: state.title || item?.title || 'Untitled chat', repo: item ? item.repo ?? null : _repo_name(), updated: Date.now(), state };
                    chats.items = [entry, ...chats.items.filter(other => other.thread_id !== state.thread_id)];
                }
                this._save_chats(agent, chats).then(() => this._post_chats(agent));
            },
        };
    }

    _session(agent = this._agent()) {
        if (!agent) throw new Error('No agent available. Sign in first.');
        if (!this.sessions.has(agent.agentId)) {
            const ui = {
                message: item => this._post({ type: 'message', item, agent: agent.agentId }),
                info: text => this._post({ type: 'message', item: { role: 'info', text }, agent: agent.agentId }),
                status: status => this._post({ type: 'status', status, agent: agent.agentId }),
            };
            this.sessions.set(agent.agentId, new ChatSession({ client: this.client, agent, limits: this._limits(), store: this._store(agent), workspace: workspace_adapter, ui }));
        }
        const session = this.sessions.get(agent.agentId);
        Object.assign(session, { agent, limits: this._limits() });
        return session;
    }

    _post_chats(agent) {
        const chats = this._chats(agent);
        this._post({ type: 'chats', agent: agent.agentId, items: chats.items.map(({ thread_id, title, repo, updated }) => ({ thread_id, title, repo, updated, current: thread_id === chats.current })) });
    }

    // --- avatars (cached until VS Code restarts) ---
    _avatar(kind, id, name, has_image = true) {
        if (!has_image || !id) return Promise.resolve({ image: null, initials: _initials(name) });
        const key = `${kind}:${id}`;
        if (!this.avatars.has(key)) this.avatars.set(key, this.client.image(kind, id).then(_data_uri, () => null).then(image => ({ image, initials: _initials(name) })));
        return this.avatars.get(key);
    }

    _me() {
        this.me = this.me || this.client.me().catch(error => { this.me = null; throw error; });
        return this.me;
    }

    _user() {
        this.user_avatar = this.user_avatar || this._me().then(
            me => this._avatar('users', me.id, `${me.firstName || ''} ${me.lastName || ''}`.trim() || 'Du'),
            () => { this.user_avatar = null; return { image: null, initials: 'Du' }; },
        );
        return this.user_avatar;
    }

    // --- webview ---
    resolveWebviewView(view) {
        this.view = view;
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        const nonce = crypto.randomBytes(16).toString('hex');
        const asset = name => view.webview.asWebviewUri(vscode.Uri.joinPath(media, name));
        view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; img-src data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('chat.css')}"></head><body>
<div class="header" id="header">
<div class="agents" id="agents"></div><select id="agent" class="agent-select hidden" title="Agent"></select>
<div class="menu-wrap"><button id="history" class="icon-btn" title="Chat history"><svg viewBox="0 0 16 16" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.4v2.7h2.7"/><path d="M8 5v3.2l2.2 1.4"/></svg></button><div id="history_menu" class="menu right hidden"></div></div>
<button id="new_chat" class="icon-btn primary" title="New chat"><svg viewBox="0 0 16 16" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg></button>
</div>
<div class="statusbar"><span id="credits" class="badge"></span><span id="co_agents" class="badge"></span><span class="spacer"></span>
<div class="menu-wrap"><button id="model" class="picker-btn" title="Model for this chat"></button><div id="model_menu" class="menu right hidden"></div></div>
<button id="stop" class="stop-btn"></button></div>
<div class="messages" id="messages"></div>
<div id="working" class="working hidden"><span class="spinner"></span><span id="working_text"></span></div>
<div class="input-area">
<div id="splitter" class="splitter" title="Drag to resize the input"></div>
<div class="input-toolbar"><button id="attach_current" class="picker-btn" title="Attach the open file">📄 Current file</button><button id="attach_files" class="picker-btn" title="Attach files">📎 Files</button><button id="attach_folder" class="picker-btn" title="Attach a folder as ZIP">📁 Folder</button></div>
<div id="attachments" class="attachments"></div>
<div class="input-editor-wrap"><textarea id="input" rows="3" placeholder="Message …"></textarea></div>
<div class="input-send-row"><span class="hint">Enter = send · Shift+Enter = new line</span><button id="send" class="send-btn">Send</button></div>
</div>
<script nonce="${nonce}" src="${asset('markdown.js')}"></script>
<script nonce="${nonce}" src="${asset('chat.js')}"></script></body></html>`;
        view.webview.onDidReceiveMessage(message => this._on_message(message).catch(error => this._post({ type: 'error', text: error.message, transient: notice_types.has(message.type) })));
        this._schedule_sync();
    }

    _post(message) {
        if (this.view) this.view.webview.postMessage(message);
    }

    async _on_message(message) {
        const handlers = {
            ready: () => this.refresh(),
            select_agent: async () => {
                if (this._agent() && this._session().busy) throw new Error('Stop the agent first.');
                await this.context.workspaceState.update('monarch.agent', message.id);
                await this.refresh();
            },
            send: () => this._send(message.text),
            stop: () => this.stop(),
            new_chat: () => this.new_chat(),
            open_chat: () => this._open_chat(message.thread_id),
            remove_chat: () => this._remove_chat(message.thread_id),
            set_model: () => this._session().set_model(message.model),
            sign_in: () => vscode.commands.executeCommand('monarch.signIn'),
            attach: () => this._attach(message.kind),
            remove_attachment: () => {
                this.attachments = this.attachments.filter(item => item.id !== message.id);
                this._post_attachments();
            },
            open_file: () => this._open_file(message.path),
            input_height: () => this.context.globalState.update('monarch.inputHeight', Math.round(Number(message.height)) || null),
        };
        await (handlers[message.type] || (() => {}))();
    }

    /** Re-render agents, sign-in state, history, models and status. */
    async refresh({ reload_agents = false } = {}) {
        const signed_in = await this.oauth.is_logged_in();
        let agents = [];
        if (signed_in) {
            try {
                agents = await this._load_agents(reload_agents);
            } catch (error) {
                this._post({ type: 'error', text: `Agents not loaded: ${error.message}` });
            }
        }
        const agent = signed_in ? this._agent() : null;
        const agent_items = await Promise.all(agents.map(async item => ({ id: item.agentId, name: item.name, avatar: await this._avatar('agents', item.agentId, item.name, item.has_image) })));
        this._post({ type: 'init', agents: agent_items, current: agent?.agentId || null, current_name: agent?.name || null, labels: agent?.labels || default_labels, signed_in, user: signed_in ? await this._user() : { image: null, initials: 'Du' }, input_height: this.context.globalState.get('monarch.inputHeight') || null });
        this._post_attachments();
        if (!agent) return;
        const session = this._session(agent);
        this._post({ type: 'status', status: session.status(), agent: agent.agentId });
        this._post_chats(agent);
        this._post({ type: 'models', agent: agent.agentId, ...(await this._models(agent)) });
        await this._show_history(session, agent);
        session.refresh_credits();
    }

    // --- sync with chats continued elsewhere (awork web app) ---
    _schedule_sync() {
        clearTimeout(this.sync_timer);
        const seconds = _config().get('syncInterval');
        // with 0 (off) the setting is checked again after 10 s
        this.sync_timer = setTimeout(() => this._sync().catch(() => {}).finally(() => this._schedule_sync()), (seconds > 0 ? seconds : 10) * 1000);
        // do not keep the process alive only for the sync (tests, shutdown)
        this.sync_timer.unref?.();
    }

    async _sync() {
        if (!(_config().get('syncInterval') > 0) || !this.view?.visible) return;
        const agent = this.agent_list && this._agent();
        const session = agent && this.sessions.get(agent.agentId);
        if (!session || !(await session.has_updates())) return;
        await this._show_history(session, agent);
        session.refresh_credits();
    }

    async _show_history(session, agent) {
        try {
            this._post({ type: 'history', items: await session.history(), agent: agent.agentId });
        } catch (error) {
            if (error.status !== 404) {
                this._post({ type: 'history', items: [{ role: 'info', text: `history not loaded: ${error.message}` }], agent: agent.agentId });
                return;
            }
            // chat was deleted in awork
            const thread_id = session.state.thread_id;
            session.new_chat();
            await this._drop_chat(agent, thread_id);
            this._post({ type: 'history', items: [{ role: 'error', text: 'This chat no longer exists in awork and was removed from the history.' }], agent: agent.agentId });
        }
    }

    async _open_chat(thread_id) {
        const agent = this._agent();
        const session = this._session(agent);
        const item = this._chats(agent).items.find(entry => entry.thread_id === thread_id);
        if (!item) throw new Error('Chat not found in the history.');
        session.load_state(item.state || { thread_id });
        await this._show_history(session, agent);
        session.refresh_credits();
    }

    async _drop_chat(agent, thread_id) {
        const chats = this._chats(agent);
        chats.items = chats.items.filter(item => item.thread_id !== thread_id);
        if (chats.current === thread_id) chats.current = null;
        await this._save_chats(agent, chats);
        this._post_chats(agent);
    }

    async _remove_chat(thread_id) {
        const agent = this._agent();
        const session = this._session(agent);
        if (session.state.thread_id === thread_id) await this.new_chat();
        await this._drop_chat(agent, thread_id);
    }

    async _send(text) {
        if (!text.trim()) return;
        const session = this._session();
        const { uploads, note } = await this._uploads();
        this.attachments = [];
        this._post_attachments();
        await session.send(text + note, uploads, await this._context());
    }

    /** Context line for the agent: open repo, online link, branch, open file, local changes. */
    async _context() {
        const root = _root();
        if (!root) return context_line({ folder: null });
        const uri = vscode.window.activeTextEditor?.document.uri;
        const file = uri?.scheme === 'file' && uri.path.startsWith(`${root.path.replace(/\/$/, '')}/`) ? vscode.workspace.asRelativePath(uri, false) : null;
        return context_line({ folder: _repo_name(), file, ...git_info(await _git_repository(root)) });
    }

    async stop() {
        await this._session().stop('manual');
    }

    async new_chat() {
        const agent = this._agent();
        this._session(agent).new_chat();
        this._post({ type: 'history', items: [], agent: agent.agentId });
        this._post_chats(agent);
    }

    // --- attachments ---
    _post_attachments() {
        this._post({ type: 'attachments', items: this.attachments.map(({ id, label }) => ({ id, label })) });
    }

    async _attach(kind) {
        let picked = [];
        if (kind === 'current') {
            const uri = _tab_uri(vscode.window.tabGroups?.activeTabGroup?.activeTab) || vscode.window.activeTextEditor?.document.uri || this.last_file;
            if (!uri) throw new Error('No file open in the editor.');
            if (uri.scheme === 'untitled') throw new Error('Save the file first, then attach it.');
            picked = [{ uri, folder: false }];
        } else {
            const uris = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: kind === 'files', canSelectFolders: kind === 'folder', defaultUri: _root() || undefined });
            picked = (uris || []).map(uri => ({ uri, folder: kind === 'folder' }));
        }
        const limit_mb = _config().get('maxFolderMB');
        try {
            for (const { uri, folder } of picked) {
                if (this.attachments.some(item => item.uri.toString() === uri.toString())) continue;
                if (this.attachments.length >= max_attachments) throw new Error(`Max. ${max_attachments} attachments per message.`);
                const rel = vscode.workspace.asRelativePath(uri, false);
                if (!folder && (await vscode.workspace.fs.stat(uri)).size > limit_mb * 1024 * 1024) throw new Error(`File ${rel} exceeds monarch.maxFolderMB (${limit_mb} MB).`);
                this.attachments.push({ id: crypto.randomUUID(), uri, folder, rel, label: folder ? `${rel}/` : rel });
            }
        } finally {
            this._post_attachments();
        }
    }

    async _uploads() {
        const uploads = [];
        const notes = [];
        for (const { uri, folder, rel } of this.attachments) {
            const name = uri.path.split('/').pop();
            if (folder) {
                uploads.push({ name: `${name}.zip`, data: await this._zip_folder(uri, name), mime_type: 'application/zip' });
                notes.push(`folder ${rel}/ as ${name}.zip`);
            } else {
                uploads.push({ name, data: await vscode.workspace.fs.readFile(uri), mime_type: mime_types[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream' });
                notes.push(rel);
            }
        }
        return { uploads, note: notes.length ? `\n\nAttached (relative to repo root): ${notes.join(', ')}` : '' };
    }

    async _zip_folder(folder_uri, name) {
        const limit = _config().get('maxFolderMB') * 1024 * 1024;
        const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder_uri, '**/*'), _exclude_glob());
        const entries = [];
        let total = 0;
        for (const uri of found) {
            const stat = await vscode.workspace.fs.stat(uri);
            total += stat.size;
            if (total > limit) throw new Error(`Folder ${name} exceeds monarch.maxFolderMB (${_config().get('maxFolderMB')} MB).`);
            entries.push({ name: `${name}/${uri.path.slice(folder_uri.path.replace(/\/$/, '').length + 1)}`, data: await vscode.workspace.fs.readFile(uri), mtime: new Date(stat.mtime) });
        }
        if (!entries.length) throw new Error(`Folder ${name} has no files to attach (only folders inside the open workspace are supported).`);
        return create_zip(entries);
    }

    async _open_file(path) {
        const root = _root();
        if (root) await vscode.window.showTextDocument(vscode.Uri.joinPath(root, ...path.split('/')));
    }
}

module.exports = { ChatView, merge_agents, parse_models };
