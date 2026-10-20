'use strict';
/** Webview chat window: agent selection, status (credits, co-agents, stop), messages and attachments. */
const vscode = require('vscode');
const crypto = require('crypto');
const { ChatSession } = require('./session');
const { create_zip } = require('./zip');

const fixed_excludes = ['**/.git/**', '**/node_modules/**', '**/__pycache__/**', '**/.venv/**', '**/*.pyc'];
const default_labels = { credits: 'Credits', coAgents: 'Co-agents', stop: 'Stop' };
const mime_types = { '.py': 'text/x-python', '.md': 'text/markdown', '.json': 'application/json', '.txt': 'text/plain', '.zip': 'application/zip' };

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

function _exclude_glob() {
    const user = Object.entries(vscode.workspace.getConfiguration('files').get('exclude') || {}).filter(([, on]) => on === true).flatMap(([pattern]) => [pattern, `${pattern}/**`]);
    return `{${[...fixed_excludes, ...user].join(',')}}`;
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
        Object.assign(this, { context, client, oauth, view: null, sessions: new Map(), attachments: [] });
    }

    // --- agents and sessions ---
    _agents() {
        return (_config().get('agents') || []).filter(agent => agent && agent.name);
    }

    _agent() {
        const agents = this._agents();
        return agents.find(agent => agent.name === this.context.workspaceState.get('monarch.agent')) || agents[0] || null;
    }

    _limits() {
        const config = _config();
        return Object.fromEntries(['maxCredits', 'maxCoAgents', 'maxRounds', 'relayTimeout', 'pollInterval'].map(key => [key, config.get(key)]));
    }

    _session() {
        const agent = this._agent();
        if (!agent) throw new Error('No agent configured in monarch.agents.');
        if (!this.sessions.has(agent.name)) {
            const key = `monarch.chat.${agent.name}`;
            const ui = {
                message: item => this._post({ type: 'message', item, agent: agent.name }),
                info: text => this._post({ type: 'message', item: { role: 'info', text }, agent: agent.name }),
                status: status => this._post({ type: 'status', status, agent: agent.name }),
            };
            const store = { load: () => this.context.workspaceState.get(key), save: state => this.context.workspaceState.update(key, state) };
            this.sessions.set(agent.name, new ChatSession({ client: this.client, agent, limits: this._limits(), store, workspace: workspace_adapter, ui }));
        }
        const session = this.sessions.get(agent.name);
        Object.assign(session, { agent, limits: this._limits() });
        return session;
    }

    // --- webview ---
    resolveWebviewView(view) {
        this.view = view;
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        const nonce = crypto.randomBytes(16).toString('hex');
        const asset = name => view.webview.asWebviewUri(vscode.Uri.joinPath(media, name));
        view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('chat.css')}"></head><body>
<div id="signin" class="banner hidden">Not signed in. <button id="signin_button">Sign in</button></div>
<div class="bar"><select id="agent"></select><button id="new_chat" title="Start a new chat">New chat</button></div>
<div class="bar status"><span id="credits"></span><span id="co_agents"></span><span class="spacer"></span><button id="stop" class="danger"></button></div>
<div id="messages"></div><div id="busy" class="hidden">working …</div>
<div id="attachments"></div>
<div class="composer"><textarea id="input" rows="3" placeholder="Message (Enter = send, Shift+Enter = new line)"></textarea>
<div class="bar"><button id="attach_current">Current file</button><button id="attach_files">Files</button><button id="attach_folder">Folder</button><span class="spacer"></span><button id="send">Send</button></div></div>
<script nonce="${nonce}" src="${asset('chat.js')}"></script></body></html>`;
        view.webview.onDidReceiveMessage(message => this._on_message(message).catch(error => this._post({ type: 'error', text: error.message })));
    }

    _post(message) {
        if (this.view) this.view.webview.postMessage(message);
    }

    async _on_message(message) {
        const handlers = {
            ready: () => this.refresh(),
            select_agent: async () => {
                await this.context.workspaceState.update('monarch.agent', message.name);
                await this.refresh();
            },
            send: () => this._send(message.text),
            stop: () => this.stop(),
            new_chat: () => this.new_chat(),
            sign_in: () => vscode.commands.executeCommand('monarch.signIn'),
            attach: () => this._attach(message.kind),
            remove_attachment: () => {
                this.attachments = this.attachments.filter(item => item.id !== message.id);
                this._post_attachments();
            },
            open_file: () => this._open_file(message.path),
        };
        await (handlers[message.type] || (() => {}))();
    }

    /** Re-render agent list, sign-in state, history and status. */
    async refresh() {
        const agents = this._agents();
        const agent = this._agent();
        this._post({ type: 'init', agents: agents.map(item => item.name), current: agent?.name, labels: { ...default_labels, ...(agent?.labels || {}) }, signed_in: await this.oauth.is_logged_in() });
        this._post_attachments();
        if (!agent) return;
        const session = this._session();
        this._post({ type: 'status', status: session.status(), agent: agent.name });
        if (await this.oauth.is_logged_in()) {
            this._post({ type: 'history', items: await session.history().catch(error => [{ role: 'info', text: `history not loaded: ${error.message}` }]), agent: agent.name });
            session.refresh_credits();
        }
    }

    async _send(text) {
        if (!text.trim()) return;
        const session = this._session();
        const { uploads, note } = await this._uploads();
        this.attachments = [];
        this._post_attachments();
        await session.send(text + note, uploads);
    }

    async stop() {
        await this._session().stop('manual');
    }

    async new_chat() {
        this._session().new_chat();
        this._post({ type: 'history', items: [], agent: this._agent().name });
    }

    // --- attachments ---
    _post_attachments() {
        this._post({ type: 'attachments', items: this.attachments.map(({ id, label }) => ({ id, label })) });
    }

    async _attach(kind) {
        let picked = [];
        if (kind === 'current') {
            const uri = vscode.window.activeTextEditor?.document.uri;
            if (!uri || uri.scheme !== 'file') throw new Error('No file open in the editor.');
            picked = [{ uri, folder: false }];
        } else {
            const uris = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: kind === 'files', canSelectFolders: kind === 'folder', defaultUri: _root() || undefined });
            picked = (uris || []).map(uri => ({ uri, folder: kind === 'folder' }));
        }
        for (const { uri, folder } of picked) {
            const rel = vscode.workspace.asRelativePath(uri, false);
            if (!this.attachments.some(item => item.uri.toString() === uri.toString())) this.attachments.push({ id: crypto.randomUUID(), uri, folder, rel, label: folder ? `${rel}/` : rel });
        }
        this._post_attachments();
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

module.exports = { ChatView };
