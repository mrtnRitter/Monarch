'use strict';
/** Sidebar chat areas and their shared webview host. */
const vscode = require('vscode');
const { ChatView } = require('./chat_view');
const { make_repo_colors } = require('./workspace');
const { chat_html } = require('./chat_html');
const { insert_index, next_active } = require('../media/chat_layout');
const { log } = require('./log');

const global_messages = new Set(['host_ready', 'focus_area', 'add_chat', 'close_area', 'notes_visible', 'notes_width', 'set_notes', 'move_area']);
const close_notice = 'Close the chat when the agent has finished and no files are staged.';

function _config() {
    return vscode.workspace.getConfiguration('monarch');
}

class ChatPanels {
    constructor(context, client, oauth, { ChatViewClass = ChatView } = {}) {
        this.context = context;
        this.client = client;
        this.oauth = oauth;
        this.ChatViewClass = ChatViewClass;
        this._change_generation = 0;
        this.view = null;
        this._view_listener = null;
        this._view_dispose_listener = null;
        this._on_change = () => this._changed();
        this._reveal_thread = (thread_id, self) => this.reveal_thread(thread_id, self);
        this.colors = make_repo_colors(context.globalState, () => (this.entries || [])
            .map(entry => entry.chat.current_repo?.()?.name)
            .filter(Boolean));
        this.notes_position = _config().get('notesPosition') === 'right' ? 'right' : 'left';
        this.action_bar_position = _config().get('actionBarPosition') === 'left' ? 'left' : 'right';
        this.new_chat_position = _config().get('newChatPosition') === 'left' ? 'left' : 'right';
        this.input_empty_lines = _config().get('inputEmptyLines');
        this.sidebar = new ChatViewClass(context, client, oauth, this._options(null));
        const entry = { chat: this.sidebar, port: null };
        this.entries = [entry];
        this.active_id = this.sidebar.id;
        entry.port = this._make_port(entry);
    }

    _options(repo, agent_id) {
        return { repo, colors: this.colors, on_change: this._on_change, reveal_thread: this._reveal_thread, window_idle: () => (this.entries || []).every(entry => this._can_close(entry.chat)), agent_id };
    }

    _log_error(error) {
        try { log(`chat panels: ${error?.message || error}`); } catch {}
    }

    _entry(chat_id) {
        return this.entries.find(entry => entry.chat.id === chat_id) || null;
    }

    _make_port(entry) {
        const listeners = new Set();
        let port;
        port = {
            webview: {
                postMessage: message => {
                    if (!this.view || !this.entries.includes(entry) || entry.port !== port) return;
                    this._post_message({ ...message, chat_id: entry.chat.id });
                },
                onDidReceiveMessage: listener => {
                    listeners.add(listener);
                    return { dispose: () => listeners.delete(listener) };
                },
            },
            get visible() { return Boolean(this_panels.view?.visible); },
            onDidChangeVisibility: listener => {
                if (!this.view) return { dispose() {} };
                return this.view.onDidChangeVisibility(listener) || { dispose() {} };
            },
        };
        const this_panels = this;
        port.dispatch = message => {
            for (const listener of [...listeners]) {
                try { listener(message); } catch (error) { this._log_error(error); }
            }
        };
        return port;
    }

    _post_message(message) {
        if (!this.view) return;
        try {
            const pending = this.view.webview.postMessage(message);
            pending?.then?.(undefined, error => this._log_error(error));
        } catch (error) {
            this._log_error(error);
        }
    }

    resolveWebviewView(view) {
        this._view_listener?.dispose();
        this._view_dispose_listener?.dispose();
        this._view_listener = null;
        this._view_dispose_listener = null;
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        view.webview.html = chat_html({ webview: view.webview, extension_uri: this.context.extensionUri });
        this._view_listener = view.webview.onDidReceiveMessage(message => this._dispatch(message));
        this._view_dispose_listener = view.onDidDispose?.(() => {
            if (this.view !== view) return;
            this.view = null;
            this._view_listener?.dispose();
            this._view_listener = null;
            this._view_dispose_listener = null;
        }) || null;
        for (const entry of this.entries) {
            entry.port = this._make_port(entry);
            entry.chat.attach(entry.port);
        }
    }

    _dispatch(message) {
        if (!message || typeof message !== 'object') return;
        if (global_messages.has(message.type)) {
            switch (message.type) {
                case 'host_ready': return this._host_ready();
                case 'focus_area': return this.focus_area(message.chat_id);
                case 'move_area': return this.move_area(message.chat_id, message.index);
                case 'add_chat': return this.add_chat();
                case 'close_area': return this.close_area(message.chat_id);
                case 'notes_visible': return this._store('monarch.notesVisible', Boolean(message.visible));
                case 'notes_width': {
                    const width = Number.isFinite(message.width) && message.width > 0 ? Math.round(message.width) : null;
                    return this._store('monarch.notesWidth', width);
                }
                case 'set_notes': return this.set_notes(message.chat_id, message.text, message.rev);
            }
        }
        const entry = this._entry(message.chat_id);
        if (entry) entry.port.dispatch(message);
    }

    _store(key, value) {
        try {
            const pending = this.context.globalState.update(key, value);
            pending?.then?.(undefined, error => this._log_error(error));
        } catch (error) {
            this._log_error(error);
        }
    }

    _host_ready() {
        this._post_message({
            type: 'host_init',
            notes_visible: Boolean(this.context.globalState.get('monarch.notesVisible')),
            notes_width: this.context.globalState.get('monarch.notesWidth') ?? null,
            notes_position: this.notes_position,
            new_chat_position: this.new_chat_position,
            action_bar_position: this.action_bar_position,
            input_empty_lines: this.input_empty_lines,
            input_height: this.context.globalState.get('monarch.inputHeight') || null,
        });
        this.entries.forEach((entry, index) => this._post_message({ type: 'add_area', chat_id: entry.chat.id, index }));
        if (this.active_id && this._entry(this.active_id)) this._post_message({ type: 'focus_area', chat_id: this.active_id });
        this._send_notes_groups();
    }

    _make_chat(repo, agent_id) {
        const chat = new this.ChatViewClass(this.context, this.client, this.oauth, this._options(repo, agent_id));
        const entry = { chat, port: null };
        this.entries.splice(insert_index(this.entries.length, this.new_chat_position), 0, entry);
        entry.port = this._make_port(entry);
        if (this.view) chat.attach(entry.port);
        return entry;
    }

    add_chat() {
        const active = this._entry(this.active_id) || this.entries[0];
        let repo = null;
        try { repo = active?.chat.current_repo?.() || null; } catch (error) { this._log_error(error); }
        const entry = this._make_chat(repo, active?.chat.agent_id);
        this.active_id = entry.chat.id;
        this._post_message({ type: 'add_area', chat_id: entry.chat.id, index: this.entries.indexOf(entry) });
        this._post_message({ type: 'focus_area', chat_id: entry.chat.id });
        this._send_notes_groups();
        return entry.chat;
    }

    _can_close(chat) {
        let agent_id = chat.agent_id;
        try { agent_id = chat.summary()?.agent_id || agent_id; } catch (error) { this._log_error(error); }
        if (!agent_id) return true;
        const session = chat.sessions?.get(agent_id);
        if (!session) return true;
        try { return Boolean(chat._repo_info(session).can_change); } catch (error) {
            this._log_error(error);
            return false;
        }
    }

    close_area(chat_id) {
        const entry = this._entry(chat_id);
        if (!entry) return false;
        if (this.entries.length < 2 || !this._can_close(entry.chat)) {
            this._post_message({ type: 'error', chat_id, text: close_notice, transient: true });
            return false;
        }
        const ids = this.entries.map(item => item.chat.id);
        const old_active = this.active_id;
        try { entry.chat.dispose(); } catch (error) { this._log_error(error); }
        this.entries = this.entries.filter(item => item !== entry);
        this._post_message({ type: 'remove_area', chat_id });
        this.active_id = next_active(ids, chat_id, old_active);
        this._post_message({ type: 'focus_area', chat_id: this.active_id });
        this._send_notes_groups();
        return true;
    }

    focus_area(chat_id) {
        if (this._entry(chat_id)) this.active_id = chat_id;
    }

    move_area(chat_id, index) {
        const entry = this._entry(chat_id);
        if (!entry || !Number.isInteger(index)) return false;
        const current_index = this.entries.indexOf(entry);
        const target_index = Math.max(0, Math.min(index, this.entries.length - 1));
        if (target_index === current_index) return false;
        const entries = [...this.entries];
        entries.splice(current_index, 1);
        entries.splice(target_index, 0, entry);
        this.entries = entries;
        this._send_notes_groups();
        return true;
    }

    reveal_thread(thread_id, self) {
        const entry = this.entries.find(item => item.chat !== self && item.chat.summary()?.thread_id === thread_id);
        if (!entry) return false;
        this.active_id = entry.chat.id;
        this._post_message({ type: 'focus_area', chat_id: entry.chat.id });
        return true;
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

    _send_notes_groups() {
        this._post_message({ type: 'notes_groups', groups: this.notes_groups() });
    }

    _changed() {
        const generation = ++this._change_generation;
        const groups = this.notes_groups();
        if (generation === this._change_generation) this._post_message({ type: 'notes_groups', groups });
    }

    set_notes(chat_id, text, rev) {
        const entry = this._entry(chat_id);
        if (!entry) return false;
        try { return Boolean(entry.chat.apply_notes?.(text, rev)); } catch (error) {
            this._log_error(error);
            return false;
        }
    }

    set_notes_position(position) {
        this.notes_position = position === 'right' ? 'right' : 'left';
        this._post_message({ type: 'notes_position', position: this.notes_position });
    }

    set_new_chat_position(position) {
        this.new_chat_position = position === 'left' ? 'left' : 'right';
        this._post_message({ type: 'new_chat_position', position: this.new_chat_position });
    }

    set_action_bar_position(position) {
        this.action_bar_position = position === 'left' ? 'left' : 'right';
        this._post_message({ type: 'action_bar_position', position: this.action_bar_position });
    }

    set_input_empty_lines(value) {
        this.input_empty_lines = value;
        this._post_message({ type: 'input_empty_lines', value });
    }

    active() {
        return this._entry(this.active_id)?.chat || this.entries[0]?.chat || null;
    }

    all() {
        return this.entries.map(entry => entry.chat);
    }

    dispose() {
        this._view_listener?.dispose();
        this._view_dispose_listener?.dispose();
        this._view_listener = null;
        this._view_dispose_listener = null;
        this.view = null;
        for (const { chat } of this.entries) {
            for (const session of chat.sessions?.values?.() || []) {
                if (!session.busy) continue;
                try {
                    const stopped = session.stop('manual');
                    Promise.resolve(stopped).catch(error => this._log_error(error));
                } catch (error) {
                    this._log_error(error);
                }
            }
            try { chat.dispose(); } catch (error) { this._log_error(error); }
        }
    }
}

module.exports = { ChatPanels };
