'use strict';
/** Editor chat panels and their shared chat tree. */
const vscode = require('vscode');
const { ChatView } = require('./chat_view');
const { folders, folder_by_name, repo_color } = require('./workspace');
const { log } = require('./log');

const status_text = { working: 'working', question: 'question', answer: 'new answer', staged: 'files staged', idle: '' };

class ChatPanels {
    /**
     * Create the sidebar chat and manage editor chats for the current window.
     * @param {import('vscode').ExtensionContext} context
     * @param {object} client
     * @param {object} oauth
     * @param {{ChatViewClass?: typeof ChatView}} [options]
     */
    constructor(context, client, oauth, { ChatViewClass = ChatView } = {}) {
        this.context = context;
        this.client = client;
        this.oauth = oauth;
        this.ChatViewClass = ChatViewClass;
        this._on_change = () => this._changed();
        this._reveal_thread = (thread_id, self) => this.reveal_thread(thread_id, self);
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
        this.sidebar = new ChatViewClass(context, client, oauth, this._options());
        this.entries = [{ chat: this.sidebar, panel: null }];
        this.last = this.sidebar;
    }

    _options(repo_name) {
        return {
            ...(repo_name === undefined ? {} : { repo_name }),
            on_change: this._on_change,
            reveal_thread: this._reveal_thread,
        };
    }

    _log_error(error) {
        try { log(`chat panels: ${error?.message || error}`); } catch {}
    }

    _summary(chat) {
        try { return chat.summary() || {}; } catch (error) {
            this._log_error(error);
            return {};
        }
    }

    _changed() {
        try {
            for (const entry of this.entries) {
                if (!entry.panel) continue;
                try {
                    const summary = entry.chat.summary() || {};
                    entry.panel.title = `${summary.repo || 'no folder'} · ${summary.title || 'New chat'}`;
                } catch (error) {
                    this._log_error(error);
                }
            }
        } catch (error) {
            this._log_error(error);
        }
        try { this.emitter.fire(); } catch (error) { this._log_error(error); }
    }

    /** Open a chat in a new editor tab for the named workspace folder.
     * @param {string} repo_name
     * @returns {ChatView}
     */
    open(repo_name) {
        const panel = vscode.window.createWebviewPanel(
            'monarch.chatPanel', `${repo_name} · New chat`, vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] },
        );
        const chat = new this.ChatViewClass(this.context, this.client, this.oauth, this._options(repo_name));
        chat.resolveWebviewView(panel);
        const folder = folder_by_name(repo_name);
        panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', repo_color(folder?.index ?? 0).icon);
        const entry = { chat, panel };
        this.entries.push(entry);
        this.last = chat;
        panel.onDidChangeViewState(() => {
            if (panel.active) this.last = chat;
            this._changed();
        });
        panel.onDidDispose(() => {
            if (!this.entries.includes(entry)) return;
            this.entries = this.entries.filter(item => item !== entry);
            if (this.last === chat) this.last = this.sidebar;
            try { chat.dispose(); } catch (error) { this._log_error(error); }
            this._changed();
        });
        return chat;
    }

    /** Ask which open repository should own a new chat.
     * @returns {Promise<string|null>}
     */
    async pick_repo() {
        const available = folders();
        if (!available.length) {
            vscode.window.showErrorMessage('monarch: open a folder first.');
            return null;
        }
        if (available.length === 1) return available[0].name;
        return (await vscode.window.showQuickPick(available.map(folder => folder.name), { title: 'monarch: repo for the new chat' })) ?? null;
    }

    /** Reveal another chat with the requested thread, focusing the sidebar when needed.
     * @param {string} thread_id
     * @param {ChatView} self
     * @returns {boolean}
     */
    reveal_thread(thread_id, self) {
        const entry = this.entries.find(item => item.chat !== self && this._summary(item.chat).thread_id === thread_id);
        return this._reveal_entry(entry);
    }

    /** Reveal a chat by its stable view id.
     * @param {string} id
     * @returns {boolean}
     */
    reveal(id) {
        const entry = this.entries.find(item => this._summary(item.chat).id === id);
        return this._reveal_entry(entry);
    }

    _reveal_entry(entry) {
        if (!entry) return false;
        try {
            if (entry.panel) entry.panel.reveal();
            else vscode.commands.executeCommand('monarch.chat.focus');
            return true;
        } catch (error) {
            this._log_error(error);
            return false;
        }
    }

    /** Return the most recently focused chat, falling back to the sidebar.
     * @returns {ChatView}
     */
    active() {
        return this.entries.some(entry => entry.chat === this.last) ? this.last : this.sidebar;
    }

    /** Return all live chat views.
     * @returns {ChatView[]}
     */
    all() {
        return this.entries.map(entry => entry.chat);
    }

    /** Return the current entries for the chat tree.
     * @returns {{chat: ChatView, panel: import('vscode').WebviewPanel|null}[]}
     */
    getChildren() {
        return this.entries;
    }

    /** Build a tree row for a chat.
     * @param {{chat: ChatView, panel: import('vscode').WebviewPanel|null}} entry
     * @returns {import('vscode').TreeItem}
     */
    getTreeItem(entry) {
        try {
            const summary = this._summary(entry.chat);
            const folder = folder_by_name(summary.repo);
            const item = new vscode.TreeItem(`${summary.repo || 'no folder'} · ${summary.title || 'New chat'}`, vscode.TreeItemCollapsibleState.None);
            item.id = summary.id;
            item.description = [status_text[summary.state], entry.panel ? null : 'sidebar'].filter(Boolean).join(' · ');
            if (folder) item.iconPath = new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor(repo_color(folder.index).theme));
            item.command = { command: 'monarch.revealChat', title: 'Show chat', arguments: [summary.id] };
            return item;
        } catch (error) {
            this._log_error(error);
            return new vscode.TreeItem('no folder · New chat', vscode.TreeItemCollapsibleState.None);
        }
    }
}

module.exports = { ChatPanels };
