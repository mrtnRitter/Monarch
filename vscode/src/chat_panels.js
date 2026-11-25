'use strict';
/** Editor chat panels and their shared chat state. */
const vscode = require('vscode');
const { ChatView } = require('./chat_view');
const { make_repo_colors } = require('./workspace');
const { log } = require('./log');

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
        this._change_generation = 0;
        this._on_change = () => this._changed();
        this._reveal_thread = (thread_id, self) => this.reveal_thread(thread_id, self);
        this.colors = make_repo_colors(context.globalState, () => (this.entries || [])
            .map(entry => entry.chat.current_repo?.()?.name)
            .filter(Boolean));
        this.sidebar = new ChatViewClass(context, client, oauth, this._options(null));
        this.entries = [{ chat: this.sidebar, panel: null }];
        this.last = this.sidebar;
    }

    _options(repo) {
        return {
            repo,
            colors: this.colors,
            on_change: this._on_change,
            reveal_thread: this._reveal_thread,
            open_beside: next_repo => this.open(next_repo),
            set_notes: (chat_id, text, rev) => this.set_notes(chat_id, text, rev),
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
        const generation = ++this._change_generation;
        const entries = [...this.entries];
        for (const entry of entries) {
            if (!entry.panel) continue;
            try {
                const summary = entry.chat.summary() || {};
                entry.panel.title = `${summary.repo || 'no folder'} · ${summary.title || 'New chat'}`;
                if (summary.repo) {
                    entry.panel.iconPath = vscode.Uri.joinPath(
                        this.context.extensionUri, 'media', this.colors.color(summary.repo).icon,
                    );
                }
            } catch (error) {
                this._log_error(error);
            }
        }

        const groups = this.notes_groups();
        for (const entry of entries) {
            if (generation !== this._change_generation) return;
            if (!this.entries.includes(entry)) continue;
            try {
                entry.chat.post_notes_groups?.(groups);
            } catch (error) {
                this._log_error(error);
            }
        }
    }

    /** Open a chat in a new editor tab for the selected repository. */
    open(repo) {
        const panel = vscode.window.createWebviewPanel(
            'monarch.chatPanel', `${repo?.name || 'no folder'} · New chat`, vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] },
        );
        const chat = new this.ChatViewClass(this.context, this.client, this.oauth, this._options(repo));
        chat.resolveWebviewView(panel);
        if (repo?.name) {
            panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', this.colors.color(repo.name).icon);
        }
        const entry = { chat, panel, listeners: [] };
        this.entries.push(entry);
        this.last = chat;
        const view_state_listener = panel.onDidChangeViewState(() => {
            if (panel.active) this.last = chat;
            this._changed();
        });
        if (view_state_listener) entry.listeners.push(view_state_listener);
        const dispose_listeners = () => {
            for (const listener of entry.listeners.splice(0)) {
                try { listener.dispose(); } catch (error) { this._log_error(error); }
            }
        };
        const dispose_listener = panel.onDidDispose(() => {
            if (!this.entries.includes(entry)) return;
            this.entries = this.entries.filter(item => item !== entry);
            if (this.last === chat) this.last = this.sidebar;
            dispose_listeners();
            try { chat.dispose(); } catch (error) { this._log_error(error); }
            this._changed();
        });
        if (dispose_listener) entry.listeners.push(dispose_listener);
        return chat;
    }

    /** Reveal another chat with the requested thread, focusing the sidebar when needed. */
    reveal_thread(thread_id, self) {
        const entry = this.entries.find(item => item.chat !== self && this._summary(item.chat).thread_id === thread_id);
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

    notes_groups() {
        const groups = [];
        for (const entry of this.entries) {
            try {
                const notes = entry.chat.notes_entry?.();
                if (notes) groups.push(notes);
            } catch (error) {
                this._log_error(error);
            }
        }
        return groups;
    }

    set_notes(chat_id, text, rev) {
        const entry = this.entries.find(item => this._summary(item.chat).id === chat_id);
        if (!entry) return false;
        try {
            return Boolean(entry.chat.apply_notes?.(text, rev));
        } catch (error) {
            this._log_error(error);
            return false;
        }
    }

    /** Return the most recently focused chat, falling back to the sidebar. */
    active() {
        return this.entries.some(entry => entry.chat === this.last) ? this.last : this.sidebar;
    }

    /** Return all live chat views. */
    all() {
        return this.entries.map(entry => entry.chat);
    }
}

module.exports = { ChatPanels };
