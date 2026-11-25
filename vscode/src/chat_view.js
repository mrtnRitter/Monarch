'use strict';
/** Webview chat window: agents from awork, chat history, model choice, messages and attachments; status below the input. */
const vscode = require('vscode');
const crypto = require('crypto');
const path = require('node:path');
const { safe_rel_path, basename } = require('./files');
const { ChatSession, Notice } = require('./session');
const { log } = require('./log');
const { create_zip } = require('./zip');
const { context_line, git_info } = require('./repo');
const { repo_info } = require('./git');
const { venv_command } = require('./venv');
const { folders, list_repos, find_repo, make_repo_colors, make_workspace_adapter } = require('./workspace');

const fixed_excludes = ['**/.git/**', '**/node_modules/**', '**/__pycache__/**', '**/.venv/**', '**/*.pyc'];
const default_labels = { chat: 'Chat', coCredits: 'Co-Credits', coAgents: 'Co-Agenten', stop: 'Stop' };
const image_types = [[[0x89, 0x50, 0x4e, 0x47], 'image/png'], [[0xff, 0xd8, 0xff], 'image/jpeg'], [[0x47, 0x49, 0x46], 'image/gif'], [[0x52, 0x49, 0x46, 0x46], 'image/webp']];
const mime_types = { '.py': 'text/x-python', '.md': 'text/markdown', '.json': 'application/json', '.txt': 'text/plain', '.zip': 'application/zip' };
const max_chats = 100;
const max_attachments = 20;
const uuid_pattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const language_aliases = { py: 'python', js: 'javascript', ts: 'typescript', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript', console: 'shellscript', ps1: 'powershell', pwsh: 'powershell', yml: 'yaml', md: 'markdown', txt: 'plaintext', text: 'plaintext', cs: 'csharp', rb: 'ruby', rs: 'rust', kt: 'kotlin' };

function _config() {
    return vscode.workspace.getConfiguration('monarch');
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

/** VS Code language id for a code fence language (aliases like py, sh); plaintext if unknown. */
async function _language_id(language) {
    const name = (language || '').toLowerCase();
    const id = language_aliases[name] || name;
    return id && (await vscode.languages.getLanguages()).includes(id) ? id : 'plaintext';
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
    // without coAgentName the co-agent IDs use the co-agent's awork name, e.g. "MiniZilla" -> minizilla_1
    const co_agent_name = id => ((id && aworks.find(agent => agent.id === id)?.name) || '').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'coagent';
    const merged = aworks.filter(agent => agent.id && !agent.isArchived && wanted(agent)).map(agent => {
        const override = override_of(agent);
        const labels = override.labels || {};
        return { agentId: agent.id, name: agent.name || 'Agent', has_image: Boolean(agent.hasImage), coAgentId: override.coAgentId || '', coAgentName: override.coAgentName || co_agent_name(override.coAgentId), labels: { ...default_labels, ...labels, chat: labels.chat || labels.credits || default_labels.chat } };
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

class ChatView {
    constructor(context, client, oauth, options = {}) {
        Object.assign(this, { context, client, oauth, port: null, port_disposables: [], sessions: new Map(), attachments: [], avatars: new Map(), user_avatar: null, me: null, agent_list: null, models: new Map(), last_file: null, last_editor: null, sync_timer: null, disposables: [], open_question: false, unseen: false });
        this.id = crypto.randomUUID();
        this.options = { repo: null, colors: null, on_change: () => {}, reveal_thread: () => false, window_idle: () => false, ...options };
        this.agent_id = options.agent_id ?? context.workspaceState.get('monarch.agent');
        this.repo = this.options.repo || null;
        this.colors = this.options.colors || make_repo_colors(context.globalState);
        this.workspace = make_workspace_adapter(() => this._root());
        // remember the last file so that "Current file" also works while a preview or other non-file tab is active
        const remember = uri => { if (uri && uri.scheme !== 'untitled') this.last_file = uri; };
        // remember the last text editor for "Insert at cursor" while the chat window has the focus (output panels excluded)
        const remember_editor = editor => { if (editor && editor.document.uri.scheme !== 'output') this.last_editor = editor; };
        remember(_tab_uri(vscode.window.tabGroups?.activeTabGroup?.activeTab) || vscode.window.activeTextEditor?.document.uri);
        remember_editor(vscode.window.activeTextEditor);
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor?.(editor => { remember(editor?.document.uri); remember_editor(editor); }) || { dispose() {} },
            vscode.window.tabGroups?.onDidChangeTabs?.(() => remember(_tab_uri(vscode.window.tabGroups.activeTabGroup?.activeTab))) || { dispose() {} },
            { dispose: () => clearTimeout(this.sync_timer) },
        );
        context.subscriptions.push(...this.disposables);
    }

    current_repo() {
        return this._folder();
    }

    _folder() {
        return this.repo || folders()[0] || null;
    }

    _same_path(a, b) {
        const fs_path = value => typeof value === 'string' ? value : value?.fsPath;
        const left = fs_path(a);
        const right = fs_path(b);
        if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
        const resolved_left = path.resolve(left);
        const resolved_right = path.resolve(right);
        return process.platform === 'win32' ? resolved_left.toLowerCase() === resolved_right.toLowerCase() : resolved_left === resolved_right;
    }

    _root() {
        return this._folder()?.uri || null;
    }

    _repo_name() {
        return this._folder()?.name || null;
    }

    summary() {
        const agent = this.agent_list && this._agent();
        const session = agent ? this.sessions.get(agent.agentId) : null;
        const state = session?.state;
        const status = session?.busy ? 'working' : this.open_question ? 'question' : this.unseen ? 'answer' : Object.keys(state?.staged || {}).length ? 'staged' : 'idle';
        return { id: this.id, repo: this._repo_name(), title: state?.title ?? null, thread_id: state?.thread_id ?? null, state: status, agent_id: agent?.agentId || this.agent_id || null };
    }

    _changed() {
        try {
            this.options.on_change(this);
        } catch (error) {
            log(`on_change failed: ${error.message}`);
        }
    }

    notes_entry() {
        const agent = this._agent();
        const session = agent && this.sessions.get(agent.agentId);
        if (!session) return null;
        const repo = this._repo_name();
        return { id: this.id, repo, hex: repo ? this.colors.color(repo).hex : null, title: session.state.title || 'New chat', ...session.notes() };
    }

    apply_notes(text, rev) {
        const agent = this._agent();
        const session = agent && this.sessions.get(agent.agentId);
        if (!session || !session.set_notes(String(text), rev)) return false;
        this._post({ type: 'notes', text: String(text), rev, agent: agent.agentId });
        this._changed();
        return true;
    }

    mark_seen() {
        if (!this.unseen) return;
        this.unseen = false;
        this._changed();
    }

    _repo_info(session) {
        const folder = this._folder();
        const state = session?.state || {};
        const active_co_agent = Object.values(state.co_agents || {}).some(item => ['working', 'waiting'].includes(item.state));
        const can_change = !session?.busy && !Object.keys(state.staged || {}).length && !active_co_agent;
        return { name: folder?.name || null, path: folder?.uri?.fsPath || null, hex: folder ? this.colors.color(folder.name).hex : null, can_change };
    }

    _post_repo(session) {
        const agent = this._agent();
        this._post({ type: 'repo', repo: this._repo_info(session), agent: agent?.agentId || null });
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
        return agents.find(agent => agent.agentId === this.agent_id || agent.name === this.agent_id) || agents[0] || null;
    }

    _limits() {
        const config = _config();
        return Object.fromEntries(['relayTimeout', 'pollInterval', 'syncInterval', 'maxFolderMB', 'autoSnapshot', 'maxSnapshotMB', 'normalizeSuffixCopies', 'normalizeLineEndings', 'relayDiff', 'relayDiffMaxKB'].map(key => [key, config.get(key)]));
    }

    async _models(agent) {
        if (!this.models.has(agent.agentId)) this.models.set(agent.agentId, this.client.agent_defaults(agent.agentId).then(parse_models, () => { this.models.delete(agent.agentId); return { default: {}, models: [] }; }));
        return this.models.get(agent.agentId);
    }

    // --- chats (list per agent shared by all repos; every window starts with a new chat) ---
    _chats(agent) {
        this._migrate_chats(agent);
        return { items: this.context.globalState.get(_chats_key(agent)) || [] };
    }

    /** Move the per-repo lists of 0.4 (single chat) and 0.5 into the shared list. */
    _migrate_chats(agent) {
        const workspace = this.context.workspaceState;
        const legacy_keys = [_chats_key(agent), `monarch.chat.${agent.name}`];
        const [list, single] = legacy_keys.map(key => workspace.get(key));
        if (!list && !single) return;
        const legacy = list || (single.thread_id ? { items: [{ thread_id: single.thread_id, title: single.title || 'Earlier chat', updated: Date.now(), state: single }] } : null);
        if (legacy) {
            const repo = this._repo_name();
            this.context.globalState.update(_chats_key(agent), _merge_chats([...(this.context.globalState.get(_chats_key(agent)) || []), ...legacy.items.map(item => ({ repo, ...item }))]));
        }
        for (const key of legacy_keys) workspace.update(key, undefined);
    }

    _save_chats(agent, chats) {
        return this.context.globalState.update(_chats_key(agent), _merge_chats(chats.items));
    }

    /** Saves the chat state into the history; no load, so a new window always starts with a new chat. */
    _store(agent) {
        return {
            save: state => {
                const chats = this._chats(agent);
                if (state.thread_id) {
                    const item = chats.items.find(entry => entry.thread_id === state.thread_id);
                    const entry = { thread_id: state.thread_id, title: state.title || item?.title || 'Untitled chat', repo: this._repo_name(), repo_path: this._root()?.fsPath || null, updated: Date.now(), state };
                    chats.items = [entry, ...chats.items.filter(other => other.thread_id !== state.thread_id)];
                }
                this._save_chats(agent, chats).then(() => this._post_chats(agent));
                this._changed();
            },
        };
    }

    _session(agent = this._agent()) {
        if (!agent) throw new Notice('No agent available. Sign in first.');
        if (!this.sessions.has(agent.agentId)) {
            const ui = {
                message: item => {
                    if (item.role === 'agent') this.unseen = !this.port?.visible;
                    if (item.role === 'question') this.open_question = true;
                    if (item.role === 'user') Object.assign(this, { open_question: false, unseen: false });
                    this._post({ type: 'message', item, agent: agent.agentId });
                    if (['agent', 'question', 'user'].includes(item.role)) this._changed();
                },
                info: text => this._post({ type: 'message', item: { role: 'info', text }, agent: agent.agentId }),
                status: status => { this._post({ type: 'status', status, agent: agent.agentId }); this._post_repo(this.sessions.get(agent.agentId) || null); this._changed(); },
                answer_credits: ({ thread_id, key, credits }) => this._post({ type: 'answer_credits', thread_id, key, credits, agent: agent.agentId }),
                notes: ({ text, rev }) => this._post({ type: 'notes', text, rev, agent: agent.agentId }),
            };
            this.sessions.set(agent.agentId, new ChatSession({ client: this.client, agent, limits: this._limits(), store: this._store(agent), workspace: this.workspace, ui }));
        }
        const session = this.sessions.get(agent.agentId);
        Object.assign(session, { agent, limits: this._limits() });
        return session;
    }

    _post_chats(agent) {
        const current = this.sessions.get(agent.agentId)?.state.thread_id || null;
        this._post({ type: 'chats', agent: agent.agentId, items: this._chats(agent).items.map(({ thread_id, title, repo, updated }) => ({ thread_id, title, repo, updated, current: thread_id === current })) });
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

    // --- webview port ---
    _dispose_port_listeners() {
        for (const disposable of this.port_disposables.splice(0)) {
            try { disposable.dispose(); } catch (error) { log(`dispose failed: ${error.message}`); }
        }
    }

    attach(port) {
        this._dispose_port_listeners();
        this.port = port;
        const is_current = () => this.port === port;
        const message_listener = port.webview.onDidReceiveMessage(message => {
            if (!is_current()) return;
            return this._on_message(message).catch(error => {
                if (is_current()) this._post({ type: 'error', text: error.message, transient: error instanceof Notice });
            });
        });
        if (message_listener) this.port_disposables.push(message_listener);
        const visibility_listener = port.onDidChangeVisibility(() => {
            if (is_current() && port.visible) this.mark_seen();
        });
        if (visibility_listener) this.port_disposables.push(visibility_listener);
        this._schedule_sync();
    }

    _post(message) {
        if (this.port) this.port.webview.postMessage(message);
    }

    dispose() {
        this.disposed = true;
        try { clearTimeout(this.sync_timer); } catch (error) { log(`timer cleanup failed: ${error.message}`); }
        this.port = null;
        this._dispose_port_listeners();
        for (const disposable of this.disposables.splice(0)) {
            try { disposable.dispose(); } catch (error) { log(`dispose failed: ${error.message}`); }
        }
    }

    async _on_message(message) {
        const handlers = {
            ready: () => this.refresh(),
            select_agent: async () => {
                if (this._agent() && this._session().busy) throw new Notice('Stop the agent first.');
                await this.context.workspaceState.update('monarch.agent', message.id);
                this.agent_id = message.id;
                await this.refresh();
            },
            terminal: () => this._terminal(),
            list_repos: async () => {
                let items = [];
                try {
                    const current = this._folder();
                    items = (await list_repos()).map(repo => ({ name: repo.name, path: repo.uri.fsPath, hex: this.colors.peek(repo.name)?.hex || null, open: Boolean(repo.open), current: this._same_path(repo.uri, current?.uri) }));
                } catch {}
                this._post({ type: 'repos', items });
            },
            select_repo: async () => {
                const agent = this._agent();
                const session = agent ? this._session(agent) : null;
                if (!this._repo_info(session).can_change) throw new Notice('Change the repo when the agent has finished and no files are staged.');
                let available = [];
                try { available = await list_repos(); } catch {}
                const found = available.find(repo => this._same_path(repo.uri, message.path));
                if (!found) throw new Notice('Repo not found.');
                if (!this._repo_info(session).can_change) throw new Notice('Change the repo when the agent has finished and no files are staged.');
                this.repo = { name: found.name, uri: found.uri };
                if (agent && session?.state?.thread_id) this._store(agent).save(session.state);
                this._post_repo(session);
                this._changed();
                let workspace_folders = vscode.workspace.workspaceFolders || [];
                if (workspace_folders.some(folder => this._same_path(found.uri, folder.uri))) return;
                if (typeof vscode.workspace.updateWorkspaceFolders !== 'function') return;
                if (!vscode.workspace.workspaceFile) {
                    if (!this.options.window_idle()) throw new Notice('Repo selected. Add it with File → Add Folder to Workspace… when no agent is running.');
                    const answer = await vscode.window.showWarningMessage(`Add ${found.name} to the workspace? This window becomes an untitled multi-root workspace and VS Code may restart the extensions.`, { modal: true }, 'Add');
                    if (answer !== 'Add') return;
                    workspace_folders = vscode.workspace.workspaceFolders || [];
                    if (workspace_folders.some(folder => this._same_path(found.uri, folder.uri))) return;
                }
                if (!vscode.workspace.updateWorkspaceFolders(workspace_folders.length, 0, { uri: found.uri })) throw new Notice('Folder not added.');
            },
            send: () => this._send(message.text, message.interrupt_id),
            stop: () => this.stop(),
            new_chat: () => this.new_chat(),
            open_chat: () => this._open_chat(message.thread_id),
            remove_chat: () => this._remove_chat(message.thread_id),
            import_chat: () => this._import_chat(),
            set_model: () => this._session().set_model(message.model),
            sign_in: () => vscode.commands.executeCommand('monarch.signIn'),
            attach: () => this._attach(message.kind),
            remove_attachment: () => {
                this.attachments = this.attachments.filter(item => item.id !== message.id);
                this._post_attachments();
            },
            open_file: () => this._open_file(message.path),
            copy: () => vscode.env.clipboard.writeText(String(message.text || '')),
            code_action: () => this._code_action(message.action, String(message.code || ''), message.language),
            input_height: () => this.context.globalState.update('monarch.inputHeight', Math.round(Number(message.height)) || null),
        };
        await (handlers[message.type] || (() => {}))();
    }

    /** Re-render agents, sign-in state, history, models and status. */
    async refresh({ reload_agents = false } = {}) {
        try {
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
            const session = agent ? this.sessions.get(agent.agentId) || null : null;
            const agent_items = await Promise.all(agents.map(async item => ({ id: item.agentId, name: item.name, avatar: await this._avatar('agents', item.agentId, item.name, item.has_image) })));
            this._post({ type: 'init', agents: agent_items, current: agent?.agentId || null, current_name: agent?.name || null, labels: agent?.labels || default_labels, signed_in, user: signed_in ? await this._user() : { image: null, initials: 'Du' }, input_height: this.context.globalState.get('monarch.inputHeight') || null, repo: this._repo_info(session) });
            this._post_repo(session);
            this._post_attachments();
            if (!agent) return;
            const active_session = this._session(agent);
            this._post_repo(active_session);
            this._post({ type: 'notes', ...active_session.notes(), agent: agent.agentId });
            this._post({ type: 'status', status: active_session.status(), agent: agent.agentId });
            this._post_chats(agent);
            this._post({ type: 'models', agent: agent.agentId, ...(await this._models(agent)) });
            await this._show_history(active_session, agent);
            active_session.refresh_credits();
        } finally {
            this._changed();
        }
    }

    // --- sync with chats continued elsewhere (awork web app) ---
    _schedule_sync() {
        if (this.disposed) return;
        clearTimeout(this.sync_timer);
        const seconds = _config().get('syncInterval');
        // with 0 (off) the setting is checked again after 10 s
        this.sync_timer = setTimeout(() => this._sync().catch(error => log(`sync failed: ${error.message}`)).finally(() => this._schedule_sync()), (seconds > 0 ? seconds : 10) * 1000);
        // do not keep the process alive only for the sync (tests, shutdown)
        this.sync_timer.unref?.();
    }

    async _sync() {
        if (!(_config().get('syncInterval') > 0) || !this.port?.visible) return;
        const agent = this.agent_list && this._agent();
        const session = agent && this.sessions.get(agent.agentId);
        if (!session || !(await session.has_updates())) return;
        log(`sync: chat ${session.state.thread_id} changed elsewhere, reloading`);
        await this._show_history(session, agent);
        session.refresh_credits();
    }

    async _show_history(session, agent) {
        const requested_thread_id = session.state.thread_id;
        try {
            const items = await session.history();
            if (session.state.thread_id !== requested_thread_id) return;
            this._post({ type: 'history', items, thread_id: requested_thread_id, agent: agent.agentId });
        } catch (error) {
            if (session.state.thread_id !== requested_thread_id) return;
            if (error.status !== 404) {
                this._post({ type: 'history', items: [{ role: 'info', text: `history not loaded: ${error.message}` }], thread_id: requested_thread_id, agent: agent.agentId });
                return;
            }
            // chat was deleted in awork
            session.new_chat();
            const new_thread_id = session.state.thread_id;
            await this._drop_chat(agent, requested_thread_id);
            if (session.state.thread_id !== new_thread_id) return;
            this._post({ type: 'history', items: [{ role: 'error', text: 'This chat no longer exists in awork and was removed from the history.' }], thread_id: new_thread_id, agent: agent.agentId });
        }
    }

    async _open_chat(thread_id) {
        const agent = this._agent();
        const session = this._session(agent);
        const item = this._chats(agent).items.find(entry => entry.thread_id === thread_id);
        if (!item) throw new Notice('Chat not found in the history.');
        if (session.busy) throw new Notice('Stop the agent first.');
        if (this.options.reveal_thread(thread_id, this)) return;
        let found = null;
        if (item.repo || item.repo_path) found = await find_repo({ name: item.repo || null, path: item.repo_path || null });
        if (session.busy) throw new Notice('Stop the agent first.');
        if (found) this.repo = { name: found.name, uri: found.uri };
        Object.assign(this, { open_question: false, unseen: false });
        session.load_state(item.state || { thread_id });
        this._post_repo(session);
        await this._show_history(session, agent);
        session.refresh_credits();
        this._changed();
    }

    /**
     * Workaround (Ctrl/Cmd+click on +): take over a chat of the selected agent from its awork link or id,
     * e.g. one started in the awork web app; awork does not let monarch list these chats.
     */
    async _import_chat() {
        const agent = this._agent();
        const session = this._session(agent);
        if (session.busy) throw new Notice('Stop the agent first.');
        const input = await vscode.window.showInputBox({ title: 'monarch: take over a chat from awork', prompt: `Link or id of a chat with ${agent.name}`, placeHolder: 'https://<workspace>.awork.com/ai/thread/<id>', ignoreFocusOut: true });
        if (!input) return;
        const thread_id = input.match(uuid_pattern)?.[0].toLowerCase();
        if (!thread_id) throw new Notice('No chat id found in the link.');
        if (this.options.reveal_thread(thread_id, this)) return;
        let thread;
        try {
            thread = await this.client.thread(thread_id);
        } catch (error) {
            throw new Notice(error.status === 404 ? 'Chat not found or not readable with your login.' : `Chat not loaded (${error.message.slice(0, 160)}).`);
        }
        if (thread.type && thread.type !== 'custom-agent') throw new Notice('Only chats with custom agents can be taken over.');
        if (thread.agentId && thread.agentId !== agent.agentId) throw new Notice(`This chat belongs to ${thread.agentNameSnapshot || 'another agent'}; select that agent first.`);
        const known = this._chats(agent).items.find(entry => entry.thread_id === thread_id);
        let found = null;
        if (known?.repo || known?.repo_path) found = await find_repo({ name: known.repo || null, path: known.repo_path || null });
        if (session.busy) throw new Notice('Stop the agent first.');
        if (found) this.repo = { name: found.name, uri: found.uri };
        Object.assign(this, { open_question: false, unseen: false });
        session.load_state(known?.state || { thread_id, title: thread.title || 'Chat from awork' });
        this._post_repo(session);
        log(`chat ${thread_id} taken over from awork`);
        await this._show_history(session, agent);
        session.refresh_credits();
        this._changed();
    }

    async _drop_chat(agent, thread_id) {
        const chats = this._chats(agent);
        chats.items = chats.items.filter(item => item.thread_id !== thread_id);
        await this._save_chats(agent, chats);
        this._post_chats(agent);
    }

    async _remove_chat(thread_id) {
        const agent = this._agent();
        const session = this._session(agent);
        if (session.state.thread_id === thread_id) await this.new_chat();
        await this._drop_chat(agent, thread_id);
    }

    async _send(text, interrupt_id = null) {
        if (!text.trim()) return;
        const session = this._session();
        const { uploads, note } = await this._uploads();
        this.attachments = [];
        this._post_attachments();
        await session.send(text + note, uploads, await this._context(), interrupt_id);
    }

    async _git_facts(uri) {
        const info = git_info(await _git_repository(uri));
        if (info.git === true) return info;
        try {
            return await repo_info(uri.fsPath, { timeout_ms: 5000 });
        } catch {
            return info;
        }
    }

    /** Context line for the agent: open repo, online link, branch, kind of local changes. */
    async _context() {
        const folder = this._folder();
        const others = await Promise.all(folders().filter(item => !this._same_path(item.uri, folder?.uri)).map(async item => ({ folder: item.name, ...await this._git_facts(item.uri) })));
        if (!folder) return context_line({ folder: null, others });
        return context_line({ folder: folder.name, ...await this._git_facts(folder.uri), others });
    }

    async stop() {
        await this._session().stop('manual');
    }

    async new_chat() {
        const agent = this._agent();
        const session = this._session(agent);
        Object.assign(this, { open_question: false, unseen: false });
        session.new_chat();
        this._post({ type: 'history', items: [], agent: agent.agentId });
        this._post_chats(agent);
        this._post_repo(session);
        this._changed();
    }

    // --- attachments ---
    _post_attachments() {
        this._post({ type: 'attachments', items: this.attachments.map(({ id, label }) => ({ id, label })) });
    }

    async _attach(kind) {
        let picked = [];
        if (kind === 'current') {
            const uri = _tab_uri(vscode.window.tabGroups?.activeTabGroup?.activeTab) || vscode.window.activeTextEditor?.document.uri || this.last_file;
            if (!uri) throw new Notice('No file open in the editor.');
            if (uri.scheme === 'untitled') throw new Notice('Save the file first, then attach it.');
            picked = [{ uri, folder: false }];
        } else {
            const uris = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: kind === 'files', canSelectFolders: kind === 'folder', defaultUri: this._root() || undefined });
            picked = (uris || []).map(uri => ({ uri, folder: kind === 'folder' }));
        }
        const limit_mb = _config().get('maxFolderMB');
        try {
            for (const { uri, folder } of picked) {
                if (this.attachments.some(item => item.uri.toString() === uri.toString())) continue;
                if (this.attachments.length >= max_attachments) throw new Notice(`Max. ${max_attachments} attachments per message.`);
                const relative = this._root() ? path.relative(this._root().fsPath, uri.fsPath) : null;
                const inside_root = relative !== null && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
                const rel = inside_root ? relative.split(path.sep).join('/') : vscode.workspace.asRelativePath(uri, false);
                if (!folder && (await vscode.workspace.fs.stat(uri)).size > limit_mb * 1024 * 1024) throw new Notice(`File ${rel} exceeds monarch.maxFolderMB (${limit_mb} MB).`);
                this.attachments.push({ id: crypto.randomUUID(), uri, folder, rel, label: folder ? `${rel}/` : rel, bundle: kind !== 'current' });
            }
        } finally {
            this._post_attachments();
        }
    }

    async _uploads() {
        const uploads = [];
        const notes = [];
        const bundle_entries = [];
        const bundle_names = [];
        const seen_names = new Set();
        for (const { uri, folder, rel, bundle, label } of this.attachments) {
            const name = basename(uri.path);
            if (!bundle) {
                uploads.push({ name, data: await vscode.workspace.fs.readFile(uri), mime_type: mime_types[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream' });
                notes.push(rel);
                continue;
            }
            const prefix = safe_rel_path(rel) || basename(uri.path);
            const entries = folder ? await this._folder_entries(uri, prefix) : [{ name: prefix, data: await vscode.workspace.fs.readFile(uri), mtime: new Date((await vscode.workspace.fs.stat(uri)).mtime) }];
            for (const entry of entries) {
                if (seen_names.has(entry.name)) continue;
                seen_names.add(entry.name);
                bundle_entries.push(entry);
            }
            bundle_names.push(label || (folder ? `${prefix}/` : prefix));
        }
        if (bundle_entries.length) {
            uploads.push({ name: 'attachments.zip', data: create_zip(bundle_entries), mime_type: 'application/zip' });
            notes.push(`attachments.zip (${bundle_names.join(', ')})`);
        }
        return { uploads, note: notes.length ? `\n\nAttached (relative to repo root): ${notes.join(', ')}` : '' };
    }

    async _folder_entries(folder_uri, prefix) {
        const max_mb = _config().get('maxFolderMB');
        const limit = max_mb * 1024 * 1024;
        const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder_uri, '**/*'), _exclude_glob());
        const entries = [];
        let total = 0;
        for (const uri of found) {
            const stat = await vscode.workspace.fs.stat(uri);
            total += stat.size;
            if (total > limit) throw new Notice(`Folder ${prefix} exceeds monarch.maxFolderMB (${max_mb} MB).`);
            const relative_path = uri.path.slice(folder_uri.path.replace(/\/$/, '').length + 1);
            entries.push({ name: `${prefix}/${relative_path}`, data: await vscode.workspace.fs.readFile(uri), mtime: new Date(stat.mtime) });
        }
        if (!entries.length) throw new Notice(`Folder ${prefix} has no files to attach (only folders inside the open workspace are supported).`);
        return entries;
    }

    // --- code block actions (like Copilot chat) ---
    async _code_action(action, code, language) {
        const actions = {
            copy: () => vscode.env.clipboard.writeText(code),
            insert: () => this._insert(code),
            new_file: async () => vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: await _language_id(language), content: code })),
            terminal: () => this._to_terminal(code),
        };
        if (!actions[action]) throw new Notice(`Unknown action ${action}.`);
        await actions[action]();
    }

    /** Insert at the cursor of the active (or last active) editor; replaces selections. */
    async _insert(code) {
        const editor = [vscode.window.activeTextEditor, this.last_editor].find(item => item && !item.document.isClosed && (vscode.window.visibleTextEditors || []).includes(item));
        if (!editor) throw new Notice('Open a file in the editor first, then insert.');
        if (!(await editor.edit(builder => editor.selections.forEach(selection => builder.replace(selection, code))))) throw new Notice('The editor did not accept the insert.');
        await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    }

    _terminal() {
        const folder = this._folder();
        if (!folder) throw new Notice('No folder open.');
        const name = `monarch: ${folder.name}`;
        const existing = vscode.window.terminals.find(terminal => terminal.name === name && terminal.exitStatus === undefined);
        if (existing) {
            existing.show();
            return existing;
        }
        const location = vscode.TerminalLocation.Panel;
        const terminal = vscode.window.createTerminal({ name, cwd: folder.uri, color: new vscode.ThemeColor(this.colors.color(folder.name).theme), iconPath: new vscode.ThemeIcon('terminal'), location });
        const command = venv_command(folder.uri.fsPath, vscode.env?.shell || '');
        if (command) terminal.sendText(command, true);
        terminal.show();
        return terminal;
    }

    /** Put code into the active terminal (or a new one) without running it. */
    async _to_terminal(code) {
        const terminal = this._folder() ? this._terminal() : (vscode.window.activeTerminal || vscode.window.createTerminal('monarch'));
        terminal.show();
        const text = code.replace(/\s+$/, '');
        if (!text.includes('\n')) return terminal.sendText(text, false);
        // sendText would run multi-line text line by line; paste uses the bracketed paste mode of the shell instead
        await vscode.env.clipboard.writeText(text);
        await vscode.commands.executeCommand('workbench.action.terminal.paste');
    }

    /** Open a written file with the editor VS Code uses for its type (text, image, binary). */
    async _open_file(path) {
        const root = this._root();
        if (!root) throw new Notice('No folder open.');
        const uri = vscode.Uri.joinPath(root, ...path.split('/'));
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            throw new Notice(`${path} not found in the repo.`);
        }
        try {
            await vscode.commands.executeCommand('vscode.open', uri);
        } catch (error) {
            throw new Notice(`${path} could not be opened (${error.message}).`);
        }
    }
}

module.exports = { ChatView, merge_agents, parse_models };
