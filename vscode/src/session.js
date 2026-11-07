'use strict';
/** One chat with an awork agent: messages, co-agent relay via ORCA commands, limits, credits (agent and co-agents separately) and stop. */
const files = require('./files');
const { abortable } = require('./awork');
const { parse_commands, parse_spawn_body } = require('./orca');
const { strip_context } = require('./repo');
const { log } = require('./log');

// any other status ends the wait, so an unknown final status cannot block the chat
const active_states = new Set(['', 'accepted', 'created', 'queued', 'pending', 'started', 'running', 'processing', 'in_progress', 'inprogress', 'streaming']);
const max_empty_polls = 10;
const urgent_states = new Set(['question', 'blocked']);
const skip_roles = new Set(['user', 'tool', 'system']);
const status_pattern = /^\W*STATUS:\W*(\w+)/im;
const max_attachments = 20;
const attach_pattern = /^\s*ATTACH:\s*`?([^`\n]+?)`?\s*$/;
const relay_prefix = '[monarch relay]';

class StopRequested extends Error {}
/** Hint about an action that is not possible right now; shown briefly instead of as an error. */
class Notice extends Error {}
/** The chat was continued elsewhere (newer user message in awork) while monarch waited. */
class Superseded extends StopRequested {}

function _is_user(message) {
    return (message.role || '').toLowerCase() === 'user';
}

/** Short reason of a failed request: HTTP status or the start of the error text. */
function _reason(error) {
    return error.status ? `HTTP ${error.status}` : error.message.slice(0, 120);
}

function _first_line(text) {
    return ((text || '').split('\n').find(line => line.trim()) || '').trim().slice(0, 60);
}


/** Messages of the run started by message_id (all messages after it). */
function _run_messages(messages, message_id) {
    const ids = messages.map(message => message.id);
    if (message_id && ids.includes(message_id)) return messages.slice(ids.indexOf(message_id) + 1);
    const last_user = messages.map(_is_user).lastIndexOf(true);
    return messages.slice(last_user + 1);
}

/** Return {answer, run}: the answer messages (response_id match, else all content messages of the run) and the whole run. */
function answer_of(messages, message_id, response_id) {
    const run = _run_messages(messages, message_id);
    const match = response_id ? messages.filter(message => [message.runtimeMessageId, message.id].includes(response_id)) : [];
    const answer = match.length ? match : run.filter(message => !skip_roles.has((message.role || '').toLowerCase()) && message.content);
    return { answer, run };
}

/** Visible text of the answer messages. */
function answer_text(answer) {
    return answer.map(message => files.clean_text(message.content)).filter(Boolean).join('\n\n');
}

function _arguments(call) {
    if (typeof call.arguments !== 'string') return call.arguments || {};
    try {
        return JSON.parse(call.arguments);
    } catch {
        return {};
    }
}

/** Question cards that the agent asked via tool calls, each tool call once: [{role: 'question', questions: [{text, options, multi, custom}]}]. Credential requests (skillId) are skipped. */
function questions_of(messages, seen = new Set()) {
    return messages.flatMap(message => message.toolCalls || []).flatMap(call => {
        const args = _arguments(call);
        const questions = _questions(args);
        const key = call.id || questions.map(question => question.text).join('\n');
        if (!questions.length || args.skillId || seen.has(key)) return [];
        seen.add(key);
        return [{ role: 'question', questions }];
    });
}

// {questions: [{question, options?, multiSelect?, allowCustomText?}]} or the old {question, options, allowCustomText}; awork events use snake_case keys
function _questions(args) {
    const legacy = typeof args.question === 'string' && Array.isArray(args.options) && args.options.length;
    const items = Array.isArray(args.questions) && args.questions.length ? args.questions : legacy ? [args] : [];
    return items.filter(item => typeof item?.question === 'string' && item.question.trim()).map(item => {
        const options = Array.isArray(item.options) ? item.options.map(String) : [];
        const allow = item.allowCustomText ?? item.allow_custom_text;
        return { text: item.question, options, multi: Boolean(item.multiSelect ?? item.multi_select), custom: !options.length || (legacy ? Boolean(allow) : allow !== false) };
    });
}

// awork marks the question message with runtimeMessageId '<id>:question'; it holds only the text, the options come with the run events
function _is_question(message) {
    return (message.runtimeMessageId || '').endsWith(':question');
}

function _event_data(event) {
    try {
        return JSON.parse(event.dataJson || '{}');
    } catch {
        return {};
    }
}

/** Card for the open question: interrupt of type request_info in the last RUN_FINISHED event, or null; credential requests are skipped. */
function pending_question(events) {
    const finished = (events || []).filter(event => event.eventName === 'RUN_FINISHED').sort((a, b) => a.sequence - b.sequence).pop();
    const interrupt = (_event_data(finished || {}).interrupt || []).find(item => item?.value?.type === 'request_info');
    const ask = interrupt?.value;
    if (!ask || ask.skill_id || ask.skillId) return null;
    const questions = _questions(ask);
    return questions.length ? { role: 'question', questions, interrupt_id: interrupt.id } : null;
}

/** Text without a trailing copy of the question texts (shown as cards instead). */
function _without_questions(text, questions) {
    return questions.flatMap(card => card.questions).reverse().reduce((rest, { text: question }) => (rest.trimEnd().endsWith(question.trim()) ? rest.trimEnd().slice(0, -question.trim().length).trimEnd() : rest), text);
}

/** Fingerprint of a message list to detect changes made elsewhere (e.g. in the awork web app). */
function _signature(messages) {
    return messages.map(message => `${message.id}:${(message.content || '').length}:${(message.toolCalls || []).length}:${message.isStreaming ? 1 : 0}`).join('|');
}

/** Chat state with defaults: thread, title, model override, last sent repo context, staged co-agent files {path: {from, url}}, job (co-agents). */
function _new_state(state) {
    return { thread_id: null, title: null, model: null, context: null, staged: {}, next_index: 1, co_agents: {}, extra_credits: 0, extra_co_credits: 0, extra_co_agents: 0, ...(state || {}) };
}

const activity_states = new Set(['running', 'completed', 'failed', 'cancelled', 'waiting', 'unknown']);
const activity_read_timeout_ms = 200;
const activity_private_key = /reasoning|thinking|thought|signature|password|passwd|secret|credential|authorization|bearer|token|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key/i;

function _activity_hash(value) {
    let hash = 2166136261;
    for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(36);
}

function _activity_redact(text) {
    return text
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+={0,2}/gi, 'Bearer [REDACTED]')
        .replace(/\b(password|passwd|secret|credential|authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1$2[REDACTED]')
        .replace(/<((?:password|passwd|secret|token|authorization|api[_-]?key))>[^<]*<\/\1>/gi, '<$1>[REDACTED]</$1>')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED]')
        .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function _activity_value(value, depth = 0, seen = new WeakSet()) {
    if (depth > 8 || value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed && /^[{[\"]/.test(trimmed)) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed !== value) return _activity_value(parsed, depth + 1, seen);
            } catch {}
        }
        return _activity_redact(value).slice(0, 4000);
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => _activity_value(item, depth + 1, seen)).filter(item => item !== undefined);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (activity_private_key.test(key)) continue;
        const cleaned = _activity_value(item, depth + 1, seen);
        if (cleaned !== undefined) result[key] = cleaned;
    }
    return result;
}

function _activity_display(value) {
    const cleaned = _activity_value(value);
    if (cleaned === undefined || cleaned === null) return null;
    if (typeof cleaned === 'string') return cleaned.slice(0, 4000) || null;
    try { return JSON.stringify(cleaned).slice(0, 4000); } catch { return null; }
}

function _activity_state(value) {
    const state = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (['running', 'started', 'in_progress', 'processing', 'pending'].includes(state)) return 'running';
    if (['completed', 'complete', 'success', 'succeeded', 'successful', 'ok', 'finished', 'done'].includes(state)) return 'completed';
    if (['failed', 'failure', 'error', 'errored'].includes(state)) return 'failed';
    if (['cancelled', 'canceled', 'aborted', 'stopped', 'interrupted'].includes(state)) return 'cancelled';
    if (['waiting', 'awaiting', 'awaiting_input', 'input_required', 'requires_action', 'requires_info', 'paused'].includes(state)) return 'waiting';
    return 'unknown';
}

function _activity_object(event) {
    if (!event || typeof event.dataJson !== 'string') return null;
    try {
        let value = JSON.parse(event.dataJson);
        for (let depth = 0; depth < 4 && typeof value === 'string'; depth++) value = JSON.parse(value);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
}

function _activity_marker(data, event, message_id) {
    const sources = [data, data?.data, data?.metadata, event];
    const keys = ['acceptedMessageId', 'accepted_message_id', 'messageId', 'message_id'];
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        for (const key of keys) {
            if (source[key] !== undefined && source[key] !== null) return String(source[key]) === String(message_id);
        }
    }
    return null;
}

function _activity_run_id(data, event) {
    const sources = [data, data?.data, data?.metadata, event];
    const keys = ['threadRunId', 'thread_run_id', 'run_id', 'runId'];
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        for (const key of keys) {
            if (typeof source[key] === 'string' || typeof source[key] === 'number') return String(source[key]);
        }
    }
    return null;
}

function _activity_has_interrupt(value) {
    let interrupt = value;
    for (let depth = 0; depth < 4 && typeof interrupt === 'string'; depth++) {
        try { interrupt = JSON.parse(interrupt); } catch { break; }
    }
    if (Array.isArray(interrupt)) return interrupt.length > 0;
    if (interrupt && typeof interrupt === 'object') return Object.keys(interrupt).length > 0;
    return Boolean(interrupt);
}

function _activity_call_id(data) {
    const id = data?.tool_call_id ?? data?.toolCallId ?? data?.toolCallID;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

function _activity_events(events, message_id, baseline, expected_run_id = null, fresh_thread = false) {
    if (!Array.isArray(events)) return null;
    const unique = new Map();
    for (const event of events) {
        if (!event || !Number.isFinite(event.sequence) || typeof event.eventName !== 'string') continue;
        const data = _activity_object(event);
        if (data && !unique.has(event.sequence)) unique.set(event.sequence, { event, data, run_id: _activity_run_id(data, event) });
    }
    const ordered = [...unique.values()].sort((a, b) => a.event.sequence - b.event.sequence);
    let selected_run_id = expected_run_id;
    if (!selected_run_id) {
        const anchor = ordered.findIndex(({ event, data }) => ['USER_MESSAGE_ADDED', 'RUN_STARTED'].includes(event.eventName) && _activity_marker(data, event, message_id) === true);
        if (anchor >= 0) {
            const own = ordered[anchor];
            selected_run_id = own.run_id;
            if (!selected_run_id) {
                const following = ordered.slice(anchor + 1);
                const next_user = following.findIndex(item => item.event.eventName === 'USER_MESSAGE_ADDED');
                const window = next_user < 0 ? following : following.slice(0, next_user);
                selected_run_id = window.find(item => item.event.eventName === 'RUN_STARTED')?.run_id || null;
            }
        } else if (fresh_thread) {
            selected_run_id = ordered.find(item => item.event.eventName === 'RUN_STARTED')?.run_id || null;
        }
    }
    // A sequence cursor alone cannot distinguish another user's run.
    if (!selected_run_id) return null;
    const selected = ordered.filter(item => item.run_id === selected_run_id);
    if (!selected.length) return null;

    const calls = new Map();
    const args_parts = new Map();
    let run_state = null;
    const get_call = (id, sequence) => {
        const call_id = id || `event-${sequence}`;
        const key = `${call_id}`;
        if (!calls.has(key)) calls.set(key, { key: `call-${_activity_hash(key)}`, sequence, label: null, tool_name: null, status: 'running', parameters: null, result: null });
        const item = calls.get(key);
        item.sequence = Math.min(item.sequence, sequence);
        return item;
    };
    for (const { event, data } of selected) {
        const name = event.eventName.toUpperCase();
        const call_id = _activity_call_id(data);
        if (name === 'RUN_INTENT') {
            const item = get_call(call_id, event.sequence);
            item.label = _activity_display(data.intent) || item.label;
        } else if (name === 'TOOL_CALL_START') {
            const item = get_call(call_id, event.sequence);
            item.tool_name = _activity_display(data.tool_call_name ?? data.toolName) || item.tool_name;
            item.label = _activity_display(data.tool_intent ?? data.intent) || item.label || item.tool_name;
            if (data.tool_parameters !== undefined || data.toolParameters !== undefined) item.parameters = _activity_display(data.tool_parameters ?? data.toolParameters);
        } else if (name === 'TOOL_CALL_ARGS') {
            const item = get_call(call_id, event.sequence);
            const delta = data.delta ?? data.args?.delta ?? data.tool_arguments_delta;
            if (typeof delta === 'string') args_parts.set(item.key, [...(args_parts.get(item.key) || []), delta]);
            else if (delta !== undefined) args_parts.set(item.key, [...(args_parts.get(item.key) || []), _activity_display(delta) || '']);
        } else if (name === 'TOOL_CALL_END') {
            const item = get_call(call_id, event.sequence);
            const status = _activity_state(data.status);
            item.status = status === 'unknown' ? 'unknown' : status;
            const result = data.tool_result !== undefined ? data.tool_result : data.content;
            if (result !== undefined && result !== null) item.result = _activity_display(result);
        } else if (name === 'RUN_ERROR') {
            run_state = 'failed';
            if (call_id) get_call(call_id, event.sequence).status = 'failed';
        } else if (name === 'RUN_FINISHED') {
            const interrupted = _activity_has_interrupt(data.interrupt);
            if (run_state !== 'failed') run_state = interrupted ? 'waiting' : data.status !== undefined ? _activity_state(data.status) : 'completed';
        }
    }
    const items = [...calls.values()].sort((a, b) => a.sequence - b.sequence);
    for (const item of items) {
        const parts = args_parts.get(item.key);
        if (parts?.length) item.parameters = _activity_display(parts.join(''));
    }
    return { items, state: run_state && activity_states.has(run_state) ? run_state : null };
}

function _activity_messages(messages, message_id, run_state) {
    if (!Array.isArray(messages)) return null;
    const start = messages.findIndex(message => message?.id === message_id && _is_user(message));
    if (start < 0) return null;
    const calls = new Map();
    let sequence = 0;
    for (const message of messages.slice(start + 1)) {
        if (_is_user(message)) break;
        for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
            if (!call || typeof call !== 'object') continue;
            const id = typeof call.id === 'string' || typeof call.id === 'number' ? String(call.id) : `index-${sequence}`;
            if (calls.has(id)) continue;
            sequence++;
            const status = call.status === undefined ? (run_state === 'running' && call.response == null ? 'running' : 'unknown') : _activity_state(call.status);
            calls.set(id, {
                key: `call-${_activity_hash(id)}`, sequence: Number.isFinite(call.sequence) ? call.sequence : sequence,
                label: _activity_display(call.intent) || _activity_display(call.toolName),
                tool_name: _activity_display(call.toolName), status,
                parameters: _activity_display(call.arguments),
                result: call.response === undefined || call.response === null ? null : _activity_display(call.response),
            });
        }
    }
    return calls.size ? { items: [...calls.values()].sort((a, b) => a.sequence - b.sequence), state: null } : null;
}

class ChatSession {
    /**
     * @param {object} options
     * @param {import('./awork').AworkClient} options.client
     * @param {{name, agentId, coAgentId?, coAgentName?}} options.agent
     * @param {{maxCredits, maxCoAgentCredits, maxCoAgents, relayTimeout, pollInterval}} options.limits 0 = no cap
     * @param {{load?: () => object|undefined, save: (state: object) => void}} options.store persisted chat state; without load the session starts with a new chat
     * @param {{write: (path: string, data: string|Uint8Array) => Promise<string>}|null} options.workspace repo access
     * @param {{message, info, status}} options.ui callbacks for the chat window
     */
    constructor({ client, agent, limits, store, workspace, ui, sleep, credit_refresh_ms = 10_000 }) {
        Object.assign(this, { client, agent, limits, store, workspace, ui, credit_refresh_ms });
        this.sleep = sleep || ((ms, signal) => new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new StopRequested());
            const finish = error => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', on_abort);
                error ? reject(error) : resolve();
            };
            const on_abort = () => finish(new StopRequested());
            const timer = setTimeout(() => finish(), ms);
            signal?.addEventListener('abort', on_abort, { once: true });
        }));
        this.state = _new_state(store.load?.());
        Object.assign(this, { credits: null, credit_error: null, co_credits: null, co_credit_error: null, credits_at: 0, busy: false, stopping: false, controller: null, answers: new Map(), staged_outputs: new Map(), phase: null, phase_since: null, last_states: new Map(), empty_polls: new Map(), staged_data: new Map(), activity_data: null, activity_baselines: new Map(), activity_run_baselines: new Map(), activity_event_reads: new Map(), activity_events_disabled: false, credit_refresh_index: 0 });
    }

    // --- state ---
    _co_agents(filter = () => true) {
        return Object.entries(this.state.co_agents).filter(([, co_agent]) => filter(co_agent)).map(([id]) => id);
    }

    max_credits() {
        return this.limits.maxCredits ? this.limits.maxCredits + this.state.extra_credits : 0;
    }

    max_co_credits() {
        return this.limits.maxCoAgentCredits ? this.limits.maxCoAgentCredits + this.state.extra_co_credits : 0;
    }

    max_co_agents() {
        return this.limits.maxCoAgents ? this.limits.maxCoAgents + this.state.extra_co_agents : 0;
    }

    _credit_step() {
        return this.limits.creditStep > 0 ? this.limits.creditStep : 100;
    }

    _can_less(limit, used) {
        const next = limit - this._credit_step();
        return limit > 0 && next >= 1 && next > (used ?? 0);
    }

    _can_less_credits() {
        return this._can_less(this.max_credits(), this.credits);
    }

    _can_less_co_credits() {
        return this._can_less(this.max_co_credits(), this.co_credits);
    }

    _can_less_co_agents() {
        const limit = this.max_co_agents();
        const alive = this._co_agents(co_agent => co_agent.state !== 'cancelled').length;
        return limit > 0 && limit - 1 >= Math.max(1, alive);
    }

    _adjust(key, limit, can_less, direction, step) {
        if (!limit || ![1, -1].includes(direction)) return false;
        if (direction === -1 && !can_less) return false;
        this.state[key] += direction * step;
        this._save();
        this._emit();
        return true;
    }

    /** Change the agent credit limit of this chat by ±creditStep; false if not possible. */
    adjust_credits(direction) {
        return this._adjust('extra_credits', this.max_credits(), this._can_less_credits(), direction, this._credit_step());
    }

    /** Change the co-agent credit limit of this chat by ±creditStep; false if not possible. */
    adjust_co_credits(direction) {
        return this._adjust('extra_co_credits', this.max_co_credits(), this._can_less_co_credits(), direction, this._credit_step());
    }

    adjust_co_agents(direction) {
        return this._adjust('extra_co_agents', this.max_co_agents(), this._can_less_co_agents(), direction, 1);
    }

    status() {
        const max_credits = this.max_credits();
        const max_co_credits = this.max_co_credits();
        const max_co_agents = this.max_co_agents();
        return {
            credits: this.credits, max_credits, credit_step: this._credit_step(),
            can_less_credits: this._can_less_credits(), can_more_credits: max_credits > 0,
            co_credits: this.co_credits, max_co_credits,
            can_less_co_credits: this._can_less_co_credits(), can_more_co_credits: max_co_credits > 0,
            co_agents: this._co_agents(co_agent => co_agent.state !== 'cancelled').length,
            working: this._co_agents(co_agent => co_agent.state === 'working').length,
            max_co_agents, can_less_co_agents: this._can_less_co_agents(), can_more_co_agents: max_co_agents > 0,
            busy: this.busy, thread_id: this.state.thread_id, activity: this._activity_snapshot(),
            phase: this.phase, phase_since: this.phase_since, model: this.state.model,
        };
    }

    _set_phase(phase) {
        Object.assign(this, { phase, phase_since: phase ? Date.now() : null });
        this._emit();
    }

    _emit() {
        this.ui.status(this.status());
    }

    _activity_snapshot() {
        const activity = this.activity_data;
        if (!activity || activity.thread_id !== this.state.thread_id) return null;
        const runs = activity.runs.filter(run => run.items.length).map(run => ({
            run_key: run.run_key, state: run.state, source: run.source, current_key: run.current_key,
            items: run.items.map(({ key, sequence, label, tool_name, status, parameters, result }) => ({ key, sequence, label, tool_name, status, parameters, result })),
        }));
        return runs.length ? { thread_id: activity.thread_id, runs } : null;
    }

    _activity_changed(previous) {
        if (previous !== JSON.stringify(this._activity_snapshot())) {
            try { this._emit(); } catch {}
        }
    }

    async _request(action, signal = this.controller?.signal) {
        if (this.stopping || signal?.aborted) throw new StopRequested();
        try {
            return await abortable(() => action(signal), signal);
        } catch (error) {
            if (this.stopping || signal?.aborted) throw new StopRequested();
            throw error;
        }
    }

    async _activity_read_events(thread_id) {
        if (this.activity_events_disabled || typeof this.client.events !== 'function') return null;
        const pending = this.activity_event_reads.get(thread_id);
        if (pending) return pending;
        const request = this._request(signal => this.client.events(thread_id, { signal })).then(events => Array.isArray(events) ? events : null, error => {
            if ([401, 403].includes(error.status)) this.activity_events_disabled = true;
            return null;
        }).finally(() => {
            if (this.activity_event_reads.get(thread_id) === request) this.activity_event_reads.delete(thread_id);
        });
        this.activity_event_reads.set(thread_id, request);
        return request;
    }

    async _activity_prepare(thread_id) {
        if (!thread_id || this.activity_events_disabled || typeof this.client.events !== 'function') return;
        if (Number.isFinite(this.activity_baselines.get(thread_id))) return;
        let timer;
        const request = this._activity_read_events(thread_id);
        try {
            const events = await this._request(() => Promise.race([
                request,
                new Promise(resolve => { timer = setTimeout(() => resolve(null), activity_read_timeout_ms); }),
            ]));
            const sequences = Array.isArray(events) ? events.map(event => event?.sequence).filter(Number.isFinite) : [];
            this.activity_baselines.set(thread_id, events ? sequences.reduce((max, sequence) => Math.max(max, sequence), -1) : null);
        } finally {
            clearTimeout(timer);
        }
    }

    _activity_start(thread_id, message_id, run_info = {}) {
        if (thread_id !== this.state.thread_id) return null;
        if (!this.activity_data || this.activity_data.thread_id !== thread_id) this.activity_data = { thread_id, runs: [] };
        const run_key = `run-${_activity_hash(`${thread_id}\u0000${message_id}`)}`;
        let run = this.activity_data.runs.find(item => item.run_key === run_key);
        if (!run) {
            run = { run_key, state: 'running', source: 'unavailable', current_key: null, items: [], _item_map: new Map() };
            this.activity_data.runs.push(run);
        }
        run._run_id = _activity_run_id(run_info, null);
        run._fresh_thread = Boolean(run_info._new_thread);
        run._signal = this.controller?.signal;
        run._closed = false;
        run._terminal = null;
        run._has_events = false;
        run._finished = new Promise(resolve => { run._resolve_finished = resolve; });
        this.activity_run_baselines.set(run_key, this.activity_baselines.has(thread_id) ? this.activity_baselines.get(thread_id) : null);
        return run;
    }

    _activity_apply(run, payload, source, fallback_state) {
        if (!run) return;
        const previous = JSON.stringify(this._activity_snapshot());
        if (payload?.items?.length) {
            run.items = payload.items.map(item => ({
                key: `${run.run_key}:${item.key}`, sequence: Number(item.sequence),
                label: typeof item.label === 'string' ? item.label : null,
                tool_name: typeof item.tool_name === 'string' ? item.tool_name : null,
                status: activity_states.has(item.status) ? item.status : 'unknown',
                parameters: typeof item.parameters === 'string' ? item.parameters : null,
                result: typeof item.result === 'string' ? item.result : null,
            }));
            run.source = source;
        }
        const event_state = payload?.state && activity_states.has(payload.state) ? payload.state : null;
        const next_state = event_state || (fallback_state ? _activity_state(fallback_state) : run.state);
        const preserve_event_end = !event_state && ['failed', 'cancelled', 'waiting'].includes(run.state) && ['running', 'completed'].includes(next_state);
        if (!preserve_event_end) run.state = next_state;
        const terminal = new Set(['completed', 'failed', 'cancelled', 'waiting']);
        if (terminal.has(run.state)) {
            for (const item of run.items) if (item.status === 'running') item.status = run.state === 'completed' ? 'unknown' : run.state;
        }
        const current = run.state === 'running' ? [...run.items].reverse().find(item => item.status === 'running') : null;
        run.current_key = current?.key || null;
        if (!run.items.length) run.source = 'unavailable';
        this._activity_changed(previous);
    }

    _activity_live(thread_id, run) {
        return run && !run._closed && !run._signal?.aborted && thread_id === this.state.thread_id && this.activity_data?.runs.includes(run);
    }

    _activity_refresh(thread_id, message_id, run_state, run, known_messages = null) {
        if (!this._activity_live(thread_id, run)) return;
        const apply_messages = messages => {
            if (!this._activity_live(thread_id, run) || run._has_events) return;
            const payload = _activity_messages(messages, message_id, run_state || run.state);
            this._activity_apply(run, payload, payload ? 'messages' : 'unavailable', run_state);
        };
        if (known_messages) apply_messages(known_messages);
        if (!known_messages && !run._terminal && !run._events_pending && !this.activity_events_disabled) {
            run._events_pending = this._activity_read_events(thread_id).then(events => {
                if (!this._activity_live(thread_id, run) || !events) return;
                const payload = _activity_events(events, message_id, this.activity_run_baselines.get(run.run_key), run._run_id, run._fresh_thread);
                if (!payload) return;
                const sequences = events.map(event => event?.sequence).filter(Number.isFinite);
                if (sequences.length) this.activity_baselines.set(thread_id, sequences.reduce((max, sequence) => Math.max(max, sequence), -1));
                run._has_events = Boolean(payload.items.length || payload.state);
                this._activity_apply(run, payload, 'events', run_state);
                if (['completed', 'failed', 'cancelled', 'waiting'].includes(payload.state) && !run._terminal) {
                    run._terminal = { state: payload.state, response_id: null };
                    run._resolve_finished({ run: run._terminal });
                }
            }).catch(() => {}).finally(() => { run._events_pending = null; });
        }
        if (!known_messages && !run._has_events && !run._messages_pending) {
            run._messages_pending = this._request(signal => this.client.messages(thread_id, { signal }), run._signal)
                .then(apply_messages).catch(() => {}).finally(() => { run._messages_pending = null; });
        }
    }

    _activity_finish(thread_id, message_id, state) {
        const run = this.activity_data?.runs.find(item => item.run_key === `run-${_activity_hash(`${thread_id}\u0000${message_id}`)}`);
        if (run) this._activity_apply(run, null, run.source, state);
    }

    _activity_stop() {
        const run = [...(this.activity_data?.runs || [])].reverse().find(item => item.state === 'running');
        if (!run || run.items.length === 0) return;
        const previous = JSON.stringify(this._activity_snapshot());
        run.state = 'cancelled';
        for (const item of run.items) if (item.status === 'running') item.status = 'cancelled';
        run.current_key = null;
        this._activity_changed(previous);
    }

    _save() {
        this.store.save(this.state);
    }

    // --- credits ---
    /** Sum of creditsUsed of the given threads (thread details, no admin rights needed): {used, error}; used = null if not readable. */
    async _thread_credits(ids) {
        try {
            const threads = await Promise.all([...new Set(ids.filter(Boolean))].map(id => this._request(signal => this.client.thread(id, { signal }))));
            return { used: threads.reduce((sum, thread) => sum + (thread.usage?.creditsUsed || 0), 0), error: null };
        } catch (error) {
            if (error instanceof StopRequested) throw error;
            return { used: null, error: error.message };
        }
    }

    /** Credits of this chat, separately for the agent thread and all co-agent threads. Returns {credits, co_credits}. */
    async refresh_credits() {
        const refresh_index = ++this.credit_refresh_index;
        const thread_id = this.state.thread_id;
        const [agent, co_agents] = await Promise.all([
            this._thread_credits([this.state.thread_id]),
            this._thread_credits(Object.values(this.state.co_agents).map(co_agent => co_agent.thread_id)),
        ]);
        if (refresh_index !== this.credit_refresh_index || thread_id !== this.state.thread_id) return { credits: this.credits, co_credits: this.co_credits };
        Object.assign(this, { credits: agent.used, credit_error: agent.error, co_credits: co_agents.used, co_credit_error: co_agents.error, credits_at: Date.now() });
        this._emit();
        return { credits: this.credits, co_credits: this.co_credits };
    }

    async _check_budget(strict) {
        await this.refresh_credits();
        const budgets = [
            ['maxCredits', 'Credits', this.credits, this.max_credits(), this.credit_error],
            ['maxCoAgentCredits', 'Co-agent credits', this.co_credits, this.max_co_credits(), this.co_credit_error],
        ];
        for (const [setting, name, used, limit, error] of budgets) {
            if (!limit) continue;
            if (used === null) {
                if (strict) throw new Error(`${name} not readable (${error}). Set monarch.${setting} to 0 to chat without this credit cap.`);
                continue;
            }
            if (used >= limit) {
                await this.stop(`${setting} reached (${used}/${limit})`);
                throw new StopRequested();
            }
        }
    }

    async _tick() {
        if (this.stopping) throw new StopRequested();
        if (Date.now() - this.credits_at >= this.credit_refresh_ms) await this._check_budget(false);
        await this.sleep(this.limits.pollInterval * 1000, this.controller.signal);
    }

    // --- runs ---
    async _run_state(thread_id, message_id, signal = this.controller?.signal) {
        const status = await this._request(request_signal => this.client.message_status(thread_id, message_id, { signal: request_signal }), signal);
        const state = (status.status || '').toLowerCase();
        const key = `${thread_id}:${message_id}`;
        if (this.last_states.get(key) !== state) log(`run ${key}: status "${state}"${status.hasAgentResponse ? ' with response' : ''}${status.error ? `, error: ${status.error}` : ''}`);
        this.last_states.set(key, state);
        if (active_states.has(state)) return { state: null };
        // "completed" can be reported before the answer is stored
        if (state === 'completed' && !status.hasAgentResponse) {
            const polls = (this.empty_polls.get(key) || 0) + 1;
            this.empty_polls.set(key, polls);
            if (polls < max_empty_polls) return { state: null };
            log(`run ${key}: completed without response after ${polls} checks, taking the messages as they are`);
        }
        this.empty_polls.delete(key);
        this.last_states.delete(key);
        return { state, response_id: status.responseId };
    }

    async _accepted_id(thread_id, accepted) {
        if (accepted.acceptedMessageId) return accepted.acceptedMessageId;
        const messages = await this._request(signal => this.client.messages(thread_id, { signal }));
        return [...messages].reverse().find(_is_user)?.id;
    }

    async _wait_for_run(thread_id, message_id, run_info = {}) {
        const activity_run = this._activity_start(thread_id, message_id, run_info);
        let run;
        let checked_at = Date.now();
        try {
            while (true) {
                if (activity_run?._terminal) { run = activity_run._terminal; break; }
                this._activity_refresh(thread_id, message_id, 'running', activity_run);
                const poll_controller = new AbortController();
                try {
                    const choices = [this._run_state(thread_id, message_id, poll_controller.signal).then(value => ({ run: value }), error => ({ error }))];
                    if (activity_run) choices.push(activity_run._finished);
                    const outcome = await this._request(() => Promise.race(choices));
                    if (outcome.error) throw outcome.error;
                    run = activity_run?._terminal || outcome.run;
                } finally {
                    poll_controller.abort();
                }
                if (run.state) break;
                const every = (this.limits.syncInterval || 0) * 1000;
                if (every && thread_id === this.state.thread_id && Date.now() - checked_at >= every) {
                    checked_at = Date.now();
                    const sync = this._check_superseded(thread_id, message_id);
                    await this._request(() => activity_run ? Promise.race([sync, activity_run._finished]) : sync);
                }
                const tick = this._tick();
                await this._request(() => activity_run ? Promise.race([tick, activity_run._finished]) : tick);
            }
            let messages, answer;
            for (let attempt = 0; attempt < max_empty_polls; attempt++) {
                messages = await this._request(signal => this.client.messages(thread_id, { signal }));
                await this._check_superseded(thread_id, message_id, messages);
                answer = answer_of(messages, message_id, run.response_id);
                if (run.state !== 'completed' || answer.answer.some(message => message.content && !message.isStreaming) || attempt === max_empty_polls - 1) break;
                await this._request(signal => this.sleep(this.limits.pollInterval * 1000, signal));
            }
            if (thread_id === this.state.thread_id) this.synced = _signature(messages);
            this._activity_refresh(thread_id, message_id, run.state, activity_run, messages);
            this._activity_finish(thread_id, message_id, run.state);
            return { ...answer, state: run.state };
        } catch (error) {
            this._activity_finish(thread_id, message_id, this.stopping ? 'cancelled' : error instanceof Superseded ? 'waiting' : 'unknown');
            throw error;
        } finally {
            if (activity_run) activity_run._closed = true;
            const key = `${thread_id}:${message_id}`;
            this.last_states.delete(key);
            this.empty_polls.delete(key);
        }
    }

    /** Throw Superseded if a newer user message (written elsewhere) follows message_id. */
    async _check_superseded(thread_id, message_id, known_messages = null) {
        const messages = known_messages || await this._request(signal => this.client.messages(thread_id, { signal }));
        const index = messages.findIndex(message => message.id === message_id);
        if (index < 0 || !messages.slice(index + 1).some(_is_user)) return;
        log(`chat ${thread_id}: continued elsewhere, stop waiting for ${message_id}`);
        throw new Superseded();
    }

    /** Send one message; context = repo context line contained in content, remembered once the message is accepted. */
    async _post(content, attachments, context = null, interrupt_id = null) {
        const started = Date.now();
        if (this.state.thread_id) await this._activity_prepare(this.state.thread_id);
        if (this.stopping) throw new StopRequested();
        this._set_phase('agent');
        let accepted;
        const options = { ...this._model_options(), ...(interrupt_id ? { answerToInterruptId: interrupt_id } : {}) };
        if (this.state.thread_id) {
            accepted = await this._request(signal => this.client.send_message(this.state.thread_id, content, attachments, options, { signal }));
        } else {
            accepted = await this._request(signal => this.client.create_thread(this.agent.agentId, content, `monarch – ${this.agent.name} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, attachments, options, { signal }));
            accepted = { ...accepted, _new_thread: true };
            this.state.thread_id = accepted.id;
            if (!this.activity_baselines.has(accepted.id)) this.activity_baselines.set(accepted.id, -1);
            this._save();
        }
        if (context) {
            this.state.context = context;
            this._save();
        }
        const run = await this._wait_for_run(this.state.thread_id, await this._accepted_id(this.state.thread_id, accepted), accepted);
        return { ...run, duration_ms: Date.now() - started };
    }

    /**
     * Send a user message (with uploads [{name, data, mime_type}]) and run the relay until the agent stops issuing commands.
     * The repo context line is only added when it differs from the last one sent in this chat.
     * Resolves when the agent is done or stopped.
     */
    /** interrupt_id: id of the open question this text answers (answerToInterruptId). */
    async send(text, uploads = [], context = '', interrupt_id = null) {
        if (this.busy) throw new Notice('The agent is still working.');
        if (!this.agent.agentId) throw new Notice(`Set agentId for ${this.agent.name} in monarch.agents.`);
        if (uploads.length > max_attachments) throw new Notice(`Max. ${max_attachments} attachments per message.`);
        Object.assign(this, { busy: true, stopping: false, controller: new AbortController() });
        this._emit();
        try {
            await this._check_budget(true);
            if (!this.state.thread_id && !this.state.title) this.state.title = _first_line(text);
            const fresh = context && context !== this.state.context ? context : null;
            let next = { content: fresh ? `${text}\n\n${fresh}` : text, attachments: await this._upload(uploads), context: fresh, interrupt_id };
            this.ui.message({ role: 'user', text });
            while (next) next = await this._handle_answer(await this._post(next.content, next.attachments, next.context, next.interrupt_id));
        } catch (error) {
            if (error instanceof Superseded) this.ui.info('chat continued in awork: stopped waiting, the chat is reloaded');
            else if (!(error instanceof StopRequested)) throw error;
        } finally {
            this.controller?.abort();
            Object.assign(this, { busy: false, controller: null, phase: null, phase_since: null });
            this._emit();
            this.refresh_credits().catch(error => { if (!(error instanceof StopRequested)) log(`credits refresh failed: ${error.message}`); });
        }
    }

    async _upload(uploads) {
        const attachments = [];
        for (const { name, data, mime_type } of uploads) attachments.push({ temporaryFileId: await this._request(signal => this.client.upload_temporary_file(name, data, mime_type, { signal })) });
        return attachments;
    }

    // --- answer handling ---
    async _pending_questions(messages) {
        if (!this.state.thread_id || !messages.some(_is_question)) return [];
        try {
            const card = pending_question(await this._request(signal => this.client.events(this.state.thread_id, { signal })));
            if (!card) log('question: no open question found in the run events');
            return card ? [card] : [];
        } catch (error) {
            if (error instanceof StopRequested) throw error;
            log(`question: answer options not readable (${_reason(error)})`);
            return [];
        }
    }

    async _handle_answer({ answer, run, state, duration_ms }) {
        const { text, commands } = parse_commands(answer_text(answer));
        const written = await this._write_repo_files(run);
        const questions = [...questions_of(run), ...await this._pending_questions(run)];
        const shown = _without_questions(text, questions);
        this.ui.message({ role: 'agent', text: shown || (questions.length ? '' : state === 'completed' ? '(no answer)' : `(run ${state})`), files: written.files, warnings: written.warnings, duration_ms });
        questions.forEach(question => this.ui.message(question));
        if (!commands.length) return null;
        const results = [];
        const spawn_context = { ids: new Map(), count: commands.filter(command => command.action === 'spawn').length };
        let spawn_index = 0;
        for (const command of commands) {
            const item = command.action === 'spawn' ? { ...command, spawn_index: ++spawn_index, spawn_context } : command;
            results.push(await this._execute(item));
        }
        this._resolve_spawn_refs(results, spawn_context);
        results.forEach(result => this.ui.info(`${result.ok ? 'ok' : 'refused'}: ${result.line}`));
        this._save();
        this._emit();
        const waits = results.some(result => result.ok && ['spawn', 'send', 'wait'].includes(result.action));
        const relay = waits ? await this._relay_wait(results) : null;
        if (relay || results.every(result => result.ok)) return relay;
        return this._build_relay([], this._co_agents(co_agent => ['working', 'waiting'].includes(co_agent.state)), results, false);
    }

    /**
     * Download the output files of a run (temporaryFiles below /workspace/output/): {files: [{path, data, url}], warnings}.
     * Per path the last one wins; Python caches are skipped.
     */
    async _download_files(run) {
        const found = new Map();
        const warnings = [];
        for (const file of run.flatMap(message => message.temporaryFiles || []).filter(file => files.output_path(file))) {
            const sent = files.output_path(file);
            const path = files.safe_rel_path(sent);
            if (path && files.is_junk(path)) continue;
            if (!path) { warnings.push(`${sent} not written (unsafe path)`); continue; }
            if (!file.downloadUrl) { warnings.push(`${path} not downloaded (no download link)`); continue; }
            try {
                found.set(path, { path, data: await this.client.download(file.downloadUrl), url: file.downloadUrl });
                log(`download ${path}: ok`);
            } catch (error) {
                log(`download ${path}: ${error.message}`);
                warnings.push(`${path} not downloaded (${_reason(error)})`);
            }
        }
        return { files: [...found.values()], warnings };
    }

    /** Write one file into the repo; returns an error text or null. */
    async _write(path, data) {
        if (!this.workspace) return 'no folder open';
        try {
            await this.workspace.write(path, data);
            return null;
        } catch (error) {
            return error.message;
        }
    }

    async _write_repo_files(run) {
        const { files: found, warnings } = await this._download_files(run);
        const written = [];
        for (const file of found) {
            const error = await this._write(file.path, file.data);
            if (error) warnings.push(`${file.path} not written (${error})`);
            else written.push({ path: file.path });
        }
        return { files: written, warnings };
    }

    /** Content of a staged co-agent file; downloaded again if it is not in memory (e.g. after a reload). */
    async _staged_file(path) {
        if (!this.staged_data.has(path)) this.staged_data.set(path, await this.client.download(this.state.staged[path].url));
        return this.staged_data.get(path);
    }

    /** Write all staged co-agent files into the repo; failed ones stay staged. Returns a command result. */
    async _commit() {
        const paths = Object.keys(this.state.staged);
        if (!paths.length) return { ok: false, line: 'commit: no staged files' };
        const written = [];
        const failed = [];
        for (const path of paths) {
            let error;
            try {
                error = await this._write(path, await this._staged_file(path));
            } catch (download_error) {
                error = `not downloaded (${_reason(download_error)})`;
            }
            if (error) {
                failed.push(`${path} (${error})`);
                this.ui.message({ role: 'warning', text: `commit: ${path} not written (${error})` });
                continue;
            }
            written.push(path);
            delete this.state.staged[path];
            this.staged_data.delete(path);
        }
        log(`commit: written ${written.join(', ') || 'none'}${failed.length ? `; failed ${failed.join(', ')}` : ''}`);
        const line = `commit: ${written.length} files written${written.length ? ` (${written.join(', ')})` : ''}${failed.length ? `, not written: ${failed.join(', ')}` : ''}`;
        return { ok: !failed.length, line };
    }

    // --- ORCA commands ---
    _limit_error(new_co_agent) {
        const max_co_agents = this.max_co_agents();
        const max_credits = this.max_credits();
        const max_co_credits = this.max_co_credits();
        if (!this.agent.coAgentId) return `no coAgentId configured for ${this.agent.name}`;
        const alive = this._co_agents(co_agent => co_agent.state !== 'cancelled').length;
        if (new_co_agent && max_co_agents && alive >= max_co_agents) return `maxCoAgents reached (${alive}/${max_co_agents}), cancel one first`;
        if (max_credits && this.credits !== null && this.credits >= max_credits) return `maxCredits reached (${this.credits}/${max_credits})`;
        if (max_co_credits && this.co_credits !== null && this.co_credits >= max_co_credits) return `maxCoAgentCredits reached (${this.co_credits}/${max_co_credits})`;
        return null;
    }

    /**
     * Turn "ATTACH: <repo path>" lines of a brief into attachments: staged co-agent files first, else the local repo.
     * "ATTACH: <co-agent id>" attaches all staged files of that co-agent.
     */
    async _brief(body) {
        const lines = body.split('\n');
        const entries = lines.map(line => attach_pattern.exec(line)?.[1].trim()).filter(Boolean);
        if (!entries.length) return { content: body, attachments: [] };
        const expanded = entries.map(entry => (this.state.co_agents[entry] ? Object.keys(this.state.staged).filter(path => this.state.staged[path].from === entry) : [entry]));
        const empty = entries.filter((entry, index) => !expanded[index].length);
        if (empty.length) throw new Error(`no staged files of ${empty.join(', ')}`);
        const paths = [...new Set(expanded.flat())];
        if (paths.length > max_attachments) throw new Error(`max. ${max_attachments} files per message`);
        const unsafe = paths.filter(path => !files.safe_rel_path(path) || files.is_junk(path));
        if (unsafe.length) throw new Error(`unsafe attachment path ${unsafe.join(', ')}`);
        const attachments = [];
        for (const path of paths.map(files.safe_rel_path)) {
            let data;
            try {
                if (this.state.staged[path]) data = await this._staged_file(path);
                else if (!this.workspace?.read) throw new Error('no folder open');
                else data = await this.workspace.read(path);
            } catch (error) {
                throw new Error(`attachment ${path} not readable (${error.status ? _reason(error) : error.message})`);
            }
            attachments.push({ temporaryFileId: await this.client.upload_temporary_file(files.basename(path), data) });
        }
        const content = lines.filter(line => !attach_pattern.test(line)).join('\n').trim();
        return { content: `${content}\n\nAttached files (relative to repo root): ${paths.join(', ')}`, attachments };
    }

    async _execute({ action, target, body, spawn_index, spawn_context }) {
        const result = (ok, line) => ({ ok, action, line });
        const co_agent = target ? this.state.co_agents[target] : null;
        try {
            if (action === 'spawn') {
                const parsed = parse_spawn_body(body, this.agent.coAgentName || 'coagent');
                if (parsed.invalid_after.length) return result(false, `spawn: invalid ${parsed.invalid_after.join(', ')}`);
                if (!parsed.body) return result(false, 'spawn: empty brief');
                const error = this._limit_error(true);
                if (error) return result(false, `spawn: ${error}`);
                for (const reference of [...parsed.after, ...parsed.attachment_spawns]) {
                    const spawn_match = reference.match(/^spawn_(\d+)$/i);
                    if (spawn_match && (!spawn_context || Number(spawn_match[1]) < 1 || Number(spawn_match[1]) > spawn_context.count)) {
                        return result(false, `spawn: unknown ${reference} in this response`);
                    }
                    if (parsed.after.includes(reference) && !spawn_match && !this.state.co_agents[reference]) {
                        return result(false, `spawn: unknown dependency ${reference}`);
                    }
                }
                const id = `${this.agent.coAgentName || 'coagent'}_${this.state.next_index}`;
                const deferred = parsed.after.length > 0 || parsed.attachment_spawns.length > 0;
                if (deferred) {
                    this.state.next_index += 1;
                    this.state.co_agents[id] = {
                        thread_id: null, message_id: null, state: 'waiting', relayed: null,
                        pending_spawn: {
                            body: parsed.body,
                            after: parsed.after,
                            attachment_spawns: parsed.attachment_spawns,
                            unresolved_refs: true,
                        },
                    };
                    spawn_context?.ids.set(spawn_index, id);
                    return { ...result(true, `spawn ${id}`), pending_id: id };
                }
                const { content, attachments } = await this._brief(parsed.body);
                this.state.next_index += 1;
                const thread = await this.client.create_thread(this.agent.coAgentId, content, `${id} – ${_first_line(content)}`, attachments);
                this.state.co_agents[id] = { thread_id: thread.id, message_id: await this._accepted_id(thread.id, thread), state: 'working', relayed: null };
                spawn_context?.ids.set(spawn_index, id);
                return result(true, `spawn ${id}`);
            }
            if (['send', 'cancel'].includes(action) && !co_agent) return result(false, `${action}: unknown co-agent "${target || ''}", known: ${Object.keys(this.state.co_agents).join(', ') || 'none'}`);
            if (action === 'send') {
                if (co_agent.state === 'cancelled') return result(false, `send ${target}: cancelled, spawn a new one`);
                if (co_agent.state === 'waiting') return result(false, `send ${target}: waiting for dependencies, cancel or wait`);
                if (!body) return result(false, `send ${target}: empty message`);
                const error = this._limit_error(false);
                if (error) return result(false, `send ${target}: ${error}`);
                const { content, attachments } = await this._brief(body);
                const accepted = await this.client.send_message(co_agent.thread_id, content, attachments);
                this.staged_outputs.delete(target);
                Object.assign(co_agent, { message_id: await this._accepted_id(co_agent.thread_id, accepted), state: 'working' });
                return result(true, `send ${target}`);
            }
            if (action === 'cancel') {
                if (co_agent.state === 'working') await this.client.cancel(co_agent.thread_id).catch(() => {});
                Object.assign(co_agent, { state: 'cancelled', relayed: co_agent.message_id });
                delete co_agent.pending_spawn;
                return result(true, `cancel ${target}`);
            }
            if (action === 'wait') return this._co_agents(item => item.state === 'working' || item.state === 'waiting').length ? result(true, 'wait') : result(false, 'wait: no co-agent is working');
            if (action === 'commit') {
                const { ok, line } = await this._commit();
                return result(ok, line);
            }
            if (action === 'stopzilla') return result(true, `stopzilla: ${await this._stop_co_agents()} co-agents stopped, job closed`);
            return result(false, `unknown command "${action}"`);
        } catch (error) {
            if (error instanceof StopRequested) throw error;
            return result(false, `${action}${target ? ` ${target}` : ''}: ${error.message.slice(0, 200)}`);
        }
    }

    _resolve_spawn_refs(results, spawn_context) {
        const spawn_ids = Object.fromEntries(spawn_context.ids);
        for (const [id, co_agent] of Object.entries(this.state.co_agents)) {
            const pending = co_agent.pending_spawn;
            if (co_agent.state !== 'waiting' || !pending?.unresolved_refs) continue;
            const result = results.find(item => item.pending_id === id);
            let missing = null;
            const resolve = reference => {
                const match = reference.match(/^spawn_(\d+)$/i);
                if (!match) return reference;
                const resolved = spawn_ids[Number(match[1])];
                if (!resolved || resolved === id) missing = reference;
                return resolved;
            };
            pending.dependencies = [...new Set(pending.after.map(resolve))];
            pending.attachment_ids = Object.fromEntries(pending.attachment_spawns.map(reference => {
                const resolved = resolve(reference);
                return [reference, resolved];
            }));
            delete pending.unresolved_refs;
            if (missing) {
                Object.assign(co_agent, { state: 'cancelled', relayed: co_agent.message_id });
                delete co_agent.pending_spawn;
                if (result) Object.assign(result, { ok: false, line: `spawn ${id}: not started, unresolved ${missing}` });
                continue;
            }
            if (result) {
                const waiting_for = pending.dependencies;
                result.line = waiting_for.length ? `spawn ${id} (waiting for ${waiting_for.join(', ')})` : `spawn ${id}`;
                delete result.pending_id;
            }
        }
    }

    async _launch_spawn(id, pending) {
        const body = pending.body.split('\n').map(line => {
            const match = line.match(/^(\s*ATTACH:\s*`?)spawn_(\d+)(`?\s*)$/i);
            if (!match) return line;
            const target = pending.attachment_ids?.[`spawn_${match[2]}`];
            if (!target) throw new Error(`unresolved spawn_${match[2]} attachment`);
            return `${match[1]}${target}${match[3]}`;
        }).join('\n');
        const { content, attachments } = await this._brief(body);
        const thread = await this.client.create_thread(this.agent.coAgentId, content, `${id} – ${_first_line(content)}`, attachments);
        const co_agent = this.state.co_agents[id];
        Object.assign(co_agent, { thread_id: thread.id, message_id: await this._accepted_id(thread.id, thread), state: 'working', relayed: null });
        delete co_agent.pending_spawn;
    }

    async _advance_waiting_spawns() {
        const failures = [];
        for (const id of this._co_agents(co_agent => co_agent.state === 'waiting')) {
            const co_agent = this.state.co_agents[id];
            const pending = co_agent.pending_spawn;
            if (!pending) continue;
            let waiting = false;
            let failed = null;
            for (const dependency_id of pending.dependencies || []) {
                const dependency = this.state.co_agents[dependency_id];
                if (!dependency || dependency.state === 'cancelled') {
                    failed = `${dependency_id} was cancelled`;
                    break;
                }
                if (dependency.state === 'working' || dependency.state === 'waiting') {
                    waiting = true;
                    continue;
                }
                if (dependency.state !== 'answered') {
                    failed = `${dependency_id} did not complete successfully`;
                    break;
                }
                if (await this._is_urgent(dependency_id)) {
                    failed = `${dependency_id} answered with STATUS: question or STATUS: blocked`;
                    break;
                }
            }
            if (failed) {
                Object.assign(co_agent, { state: 'cancelled', relayed: co_agent.message_id });
                delete co_agent.pending_spawn;
                failures.push({ ok: false, action: 'spawn', line: `spawn ${id}: not started, ${failed}` });
                continue;
            }
            if (waiting) continue;
            try {
                for (const dependency_id of pending.dependencies || []) await this._stage_outputs(dependency_id);
                for (const dependency_id of Object.values(pending.attachment_ids || {})) {
                    if (this.state.co_agents[dependency_id]?.state === 'answered') await this._stage_outputs(dependency_id);
                }
                await this._launch_spawn(id, pending);
                this._save();
            } catch (error) {
                Object.assign(co_agent, { state: 'failed', relayed: co_agent.message_id });
                delete co_agent.pending_spawn;
                failures.push({ ok: false, action: 'spawn', line: `spawn ${id}: not started (${error.message.slice(0, 160)})` });
            }
        }
        if (failures.length) this._save();
        return failures;
    }

    async _stop_co_agents() {
        const working = Object.values(this.state.co_agents).filter(co_agent => co_agent.state === 'working');
        await Promise.all(working.map(co_agent => this.client.cancel(co_agent.thread_id).catch(() => {})));
        Object.values(this.state.co_agents).forEach(co_agent => {
            Object.assign(co_agent, { state: 'cancelled', relayed: co_agent.message_id });
            delete co_agent.pending_spawn;
        });
        return working.length;
    }

    // --- relay ---
    async _refresh_co_agents() {
        for (const id of this._co_agents(co_agent => co_agent.state === 'working')) {
            const co_agent = this.state.co_agents[id];
            const run = await this._run_state(co_agent.thread_id, co_agent.message_id);
            if (!run.state) continue;
            this.answers.set(id, answer_of(await this.client.messages(co_agent.thread_id), co_agent.message_id, run.response_id));
            co_agent.state = run.state === 'completed' ? 'answered' : run.state;
            this._save();
        }
        this._emit();
    }

    async _answer_for(id) {
        if (!this.answers.has(id)) {
            const co_agent = this.state.co_agents[id];
            this.answers.set(id, answer_of(await this.client.messages(co_agent.thread_id), co_agent.message_id, null));
        }
        return this.answers.get(id);
    }

    async _is_urgent(id) {
        const match = answer_text((await this._answer_for(id)).answer).match(status_pattern);
        return Boolean(match) && urgent_states.has(match[1].toLowerCase());
    }

    /** Wait for co-agent answers without waking the agent. Returns the relay message or null if nothing runs. */
    async _relay_wait(results) {
        const deadline = this.limits.relayTimeout ? Date.now() + this.limits.relayTimeout * 1000 : null;
        this.ui.info('relay: waiting for co-agents');
        this._set_phase('relay');
        for (;;) {
            await this._refresh_co_agents();
            const failures = await this._advance_waiting_spawns();
            if (failures.length) results.push(...failures);
            const fresh = this._co_agents(co_agent => !['working', 'waiting', 'cancelled'].includes(co_agent.state) && co_agent.relayed !== co_agent.message_id);
            const pending = this._co_agents(co_agent => ['working', 'waiting'].includes(co_agent.state));
            const timed_out = deadline !== null && Date.now() >= deadline;
            if (!fresh.length && !pending.length) {
                if (failures.length) return this._build_relay(fresh, pending, results, timed_out);
                return null;
            }
            let urgent = false;
            for (const id of fresh) urgent = urgent || await this._is_urgent(id);
            if (failures.length || (fresh.length && (!pending.length || urgent)) || (timed_out && pending.length)) return this._build_relay(fresh, pending, results, timed_out);
            await this._tick();
        }
    }

    async _stage_outputs(id, run = null) {
        if (this.staged_outputs.has(id)) return this.staged_outputs.get(id);
        if (!run) ({ run } = await this._answer_for(id));
        const output = await this._download_files(run);
        for (const file of output.files) {
            this.state.staged[file.path] = { from: id, url: file.url };
            this.staged_data.set(file.path, file.data);
        }
        this.staged_outputs.set(id, output);
        this._save();
        return output;
    }

    /** Relay part of one co-agent answer; its output files are downloaded and staged (written into the repo only by commit). */
    async _forward(id) {
        const co_agent = this.state.co_agents[id];
        const { answer, run } = await this._answer_for(id);
        const text = answer_text(answer);
        const { files: found, warnings } = await this._stage_outputs(id, run);
        warnings.forEach(warning => this.ui.message({ role: 'warning', text: `${id}: ${warning}` }));
        co_agent.relayed = co_agent.message_id;
        this.answers.delete(id);
        this.ui.info(`relay: ${id} ${co_agent.state}, ${found.length} files staged`);
        const lines = [`## ${id} (${co_agent.state})`, text || '(no answer text)'];
        if (found.length) lines.push(`files (staged, not in the repo yet): ${found.map(file => file.path).join(', ')}`);
        return [...lines, ...warnings.map(warning => `warning: ${warning}`)].join('\n');
    }

    _status_text(pending, timed_out) {
        const budget = (used, limit) => `${used ?? 'unknown'}/${limit || 'no cap'}`;
        const lines = ['status:', ...Object.entries(this.state.co_agents).map(([id, co_agent]) => `- ${id}: ${co_agent.state}`)];
        lines.push(`credits: agent ${budget(this.credits, this.max_credits())}, co-agents ${budget(this.co_credits, this.max_co_credits())}`);
        if (pending.length) lines.push(`${pending.some(id => this.state.co_agents[id].state === 'waiting') ? 'still pending' : 'still working'}: ${pending.join(', ')}${timed_out ? ' (relayTimeout reached)' : ''}`);
        return lines.join('\n');
    }

    async _build_relay(fresh, pending, results, timed_out) {
        const parts = [`${relay_prefix} co-agent update`];
        if (results.length) parts.push(['commands:', ...results.map(result => `- ${result.ok ? 'ok' : 'refused'}: ${result.line}`)].join('\n'));
        for (const id of fresh) parts.push(await this._forward(id));
        parts.push(this._status_text(pending, timed_out));
        this._save();
        this._emit();
        return { content: parts.join('\n\n'), attachments: [] };
    }

    // --- model ---
    _model_options() {
        const model = this.state.model;
        if (!model) return {};
        return { modelProvider: model.provider, modelName: model.name, ...(model.reasoning ? { reasoningLevel: model.reasoning } : {}) };
    }

    /** Set the model override {provider, name, reasoning} for the next messages of this chat; null = agent default. */
    set_model(model) {
        this.state.model = model ? { provider: model.provider, name: model.name, reasoning: model.reasoning || null } : null;
        this._save();
        this._emit();
    }

    // --- control ---
    /** Emergency stop: cancel the agent run and all co-agents, close the job. */
    async stop(reason = 'manual') {
        this.stopping = true;
        this._activity_stop();
        if (this.controller) this.controller.abort();
        const working = this._co_agents(co_agent => co_agent.state === 'working').length;
        if (this.state.thread_id) await this.client.cancel(this.state.thread_id).catch(() => {}); // finished runs cannot be cancelled
        await this._stop_co_agents();
        this._save();
        this.ui.info(`stop (${reason}): agent and ${working} co-agents stopped`);
        this._emit();
    }

    /** Forget the current chat; the next message starts a new thread. */
    new_chat() {
        if (this.busy) throw new Notice('Stop the agent first.');
        this.state = _new_state();
        this.activity_data = null;
        this.activity_baselines.clear();
        this.activity_run_baselines.clear();
        this.staged_data.clear();
        this.staged_outputs.clear();
        Object.assign(this, { credits: 0, co_credits: 0 });
        this._save();
        this._emit();
    }

    /** Switch to a stored chat state. */
    load_state(state) {
        if (this.busy) throw new Notice('Stop the agent first.');
        const previous_thread_id = this.state.thread_id;
        this.state = _new_state(state);
        if (previous_thread_id !== this.state.thread_id) {
            this.activity_data = null;
            this.activity_baselines.clear();
            this.activity_run_baselines.clear();
        }
        this.answers.clear();
        this.staged_data.clear();
        this.staged_outputs.clear();
        Object.assign(this, { credits: null, co_credits: null });
        this._save();
        this._emit();
    }

    /** True if the current chat has messages that are not shown yet (written elsewhere); false while busy or without chat. */
    async has_updates() {
        if (this.busy || !this.state.thread_id) return false;
        const thread_id = this.state.thread_id;
        const signature = _signature(await this.client.messages(thread_id));
        return !this.busy && thread_id === this.state.thread_id && signature !== this.synced;
    }

    /** Messages of the current chat for display: [{role, text, duration_ms?}] plus question cards. */
    async history() {
        if (!this.state.thread_id) return [];
        const messages = await this.client.messages(this.state.thread_id);
        this.synced = _signature(messages);
        const seen = new Set();
        let asked_at = null;
        const pending_at = messages.map(_is_question).lastIndexOf(true);
        const open = pending_at >= 0 && !messages.slice(pending_at + 1).some(_is_user);
        const pending = open ? (await this._pending_questions([messages[pending_at]]))[0] : null;
        return messages.flatMap((message, index) => {
            if (pending && index === pending_at) return [pending];
            const role = (message.role || '').toLowerCase();
            const questions = questions_of([message], seen);
            if (!message.content || ['tool', 'system'].includes(role)) return questions;
            const text = files.clean_text(message.content);
            const created = Date.parse(message.createdOn || '') || null;
            if (_is_user(message)) {
                asked_at = created;
                return [text.startsWith(relay_prefix) ? { role: 'info', text: 'relay: co-agent update' } : { role: 'user', text: strip_context(text) }];
            }
            const shown = _without_questions(parse_commands(text).text, questions);
            return [{ role: 'agent', text: shown, duration_ms: asked_at && created ? created - asked_at : null }, ...questions];
        });
    }
}

module.exports = { ChatSession, Notice, StopRequested, Superseded, answer_of, answer_text, pending_question, questions_of, relay_prefix };
