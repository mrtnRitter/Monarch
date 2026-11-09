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
// these answers wake the agent at once, even while other co-agents still work, and stop AFTER dependents
const urgent_states = new Set(['question', 'blocked', 'plan']);
// co-agent states set by monarch; an awork run status with the same name must not be mistaken for them
const own_co_states = new Set(['working', 'waiting', 'answered', 'cancelled']);
const skip_roles = new Set(['user', 'tool', 'system']);
const status_pattern = /^\W*STATUS:\W*(\w+)/im;
const max_attachments = 20;
const attach_pattern = /^\s*ATTACH:\s*`?([^`\n]+?)`?\s*$/;
const relay_prefix = '[monarch relay]';
// inspect only reads files; with these commands its answer would be mixed with a relay wait or a repo write
const inspect_conflicts = new Set(['spawn', 'send', 'wait', 'commit', 'stopzilla']);
const repo_prefix = /^repo:\s*/i;

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

/** File name not used yet: "a.py", "a-2.py", "a-3.py" … */
function _unique_name(name, used) {
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let candidate = name;
    for (let index = 2; used.has(candidate); index++) candidate = `${stem}-${index}${ext}`;
    used.add(candidate);
    return candidate;
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

/** Chat state with defaults: thread, title, model override, last sent repo context, staged co-agent files {path: {from, url}}, job (co-agents), agent credits per answer {message id: credits}. */
function _new_state(state) {
    return { thread_id: null, title: null, model: null, context: null, staged: {}, next_index: 1, co_agents: {}, answer_credits: {}, extra_credits: 0, extra_co_credits: 0, extra_co_agents: 0, ...(state || {}) };
}

const terminal_states = new Set(['completed', 'failed', 'cancelled', 'waiting']);
const max_step_chars = 200;
const progress_steps = 3;
const max_answer_credits = 500;

function _redact(text) {
    return text
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+={0,2}/gi, 'Bearer [REDACTED]')
        .replace(/\b(password|passwd|secret|credential|authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1$2[REDACTED]')
        .replace(/<((?:password|passwd|secret|token|authorization|api[_-]?key))>[^<]*<\/\1>/gi, '<$1>[REDACTED]</$1>')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED]')
        .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Text in one line with secrets redacted. */
function _one_line(text) {
    return _redact(String(text)).replace(/\s+/g, ' ').trim();
}

function _text(value) {
    return typeof value === 'string' && value.trim() ? _one_line(value) : null;
}

/** Tool call arguments as object (JSON string or object); null if missing or not complete yet. */
function _parse_args(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            return null;
        }
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/** Display line of an agent step: "Agent step: <intent>"; null without intent. */
function step_text(intent) {
    return _tool_step_text(intent);
}

function _tool_step_text(intent, tool_name) {
    const parts = [intent, tool_name].filter(Boolean);
    if (!parts.length) return null;
    const text = `Agent step: ${parts.join(' · ')}`;
    return text.length > max_step_chars ? `${text.slice(0, max_step_chars - 1)}…` : text;
}

/** Display line of a relay event: "ok: X" -> "Relay: X", "refused: X" -> "Relay: refused – X", "relay: X" -> "Relay: X". */
function relay_text(text) {
    const match = /^(ok|refused|relay):\s*/.exec(text);
    const rest = match ? text.slice(match[0].length) : text;
    return _one_line(match?.[1] === 'refused' ? `Relay: refused – ${rest}` : `Relay: ${rest}`);
}

function _event_state(value) {
    const state = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (['completed', 'complete', 'success', 'succeeded', 'successful', 'ok', 'finished', 'done'].includes(state)) return 'completed';
    if (['failed', 'failure', 'error', 'errored'].includes(state)) return 'failed';
    if (['cancelled', 'canceled', 'aborted', 'stopped', 'interrupted'].includes(state)) return 'cancelled';
    if (['waiting', 'awaiting', 'awaiting_input', 'input_required', 'requires_action', 'requires_info', 'paused'].includes(state)) return 'waiting';
    return null;
}

function _event_object(event) {
    if (!event || typeof event.dataJson !== 'string') return null;
    try {
        let value = JSON.parse(event.dataJson);
        for (let depth = 0; depth < 4 && typeof value === 'string'; depth++) value = JSON.parse(value);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

function _event_field(data, event, keys) {
    for (const source of [data, data?.data, data?.metadata, event]) {
        if (!source || typeof source !== 'object') continue;
        for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
    }
    return undefined;
}

function _event_run_id(data, event) {
    const id = _event_field(data, event, ['threadRunId', 'thread_run_id', 'run_id', 'runId']);
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

function _event_has_interrupt(value) {
    let interrupt = value;
    for (let depth = 0; depth < 4 && typeof interrupt === 'string'; depth++) {
        try { interrupt = JSON.parse(interrupt); } catch { break; }
    }
    if (Array.isArray(interrupt)) return interrupt.length > 0;
    if (interrupt && typeof interrupt === 'object') return Object.keys(interrupt).length > 0;
    return Boolean(interrupt);
}

function _event_call_id(data) {
    const id = data?.tool_call_id ?? data?.toolCallId ?? data?.toolCallID;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/** Events of the run of message_id: [{event, data}] in order, or null if the run is not found (another user's run must not be taken). */
function _run_events(events, message_id, expected_run_id, fresh_thread) {
    if (!Array.isArray(events)) return null;
    const unique = new Map();
    for (const event of events) {
        if (!event || !Number.isFinite(event.sequence) || typeof event.eventName !== 'string') continue;
        const data = _event_object(event);
        if (data && !unique.has(event.sequence)) unique.set(event.sequence, { event, data, run_id: _event_run_id(data, event) });
    }
    const ordered = [...unique.values()].sort((a, b) => a.event.sequence - b.event.sequence);
    let run_id = expected_run_id;
    if (!run_id) {
        const is_own = ({ event, data }) => ['USER_MESSAGE_ADDED', 'RUN_STARTED'].includes(event.eventName) && String(_event_field(data, event, ['acceptedMessageId', 'accepted_message_id', 'messageId', 'message_id'])) === String(message_id);
        const anchor = ordered.findIndex(is_own);
        if (anchor >= 0) {
            run_id = ordered[anchor].run_id;
            if (!run_id) {
                const following = ordered.slice(anchor + 1);
                const next_user = following.findIndex(item => item.event.eventName === 'USER_MESSAGE_ADDED');
                run_id = (next_user < 0 ? following : following.slice(0, next_user)).find(item => item.event.eventName === 'RUN_STARTED')?.run_id || null;
            }
        } else if (fresh_thread) {
            run_id = ordered.find(item => item.event.eventName === 'RUN_STARTED')?.run_id || null;
        }
    }
    if (!run_id) return null;
    const selected = ordered.filter(item => item.run_id === run_id);
    return selected.length ? selected : null;
}

/**
 * Tool calls and end state of the run of message_id from the run events: {items: [{key, has_id, sequence, intent, tool_name, ready}], state}, or null.
 * Events without tool call id are ignored, so the same call from the messages cannot appear twice.
 */
function _event_calls(events, message_id, expected_run_id = null, fresh_thread = false) {
    const selected = _run_events(events, message_id, expected_run_id, fresh_thread);
    if (!selected) return null;
    const calls = new Map();
    let state = null;
    const get_call = (key, sequence) => {
        if (!calls.has(key)) calls.set(key, { key, sequence, tool_name: null, explicit: null, parameters: undefined, args: [], ended: false });
        return calls.get(key);
    };
    for (const { event, data } of selected) {
        const name = event.eventName.toUpperCase();
        const call_id = _event_call_id(data);
        if (name === 'RUN_ERROR') state = 'failed';
        else if (name === 'RUN_FINISHED' && state !== 'failed') state = _event_has_interrupt(data.interrupt) ? 'waiting' : data.status !== undefined ? _event_state(data.status) : 'completed';
        if (!call_id) continue;
        if (name === 'RUN_INTENT') {
            const item = get_call(call_id, event.sequence);
            item.explicit = _text(data.intent) || item.explicit;
        } else if (name === 'TOOL_CALL_START') {
            const item = get_call(call_id, event.sequence);
            item.tool_name = _text(data.tool_call_name ?? data.toolCallName ?? data.toolName) || item.tool_name;
            item.explicit = _text(data.tool_intent ?? data.intent) || item.explicit;
            item.parameters = data.tool_parameters ?? data.toolParameters ?? item.parameters;
        } else if (name === 'TOOL_CALL_ARGS') {
            const delta = data.delta ?? data.args?.delta ?? data.tool_arguments_delta;
            if (delta !== undefined && delta !== null) get_call(call_id, event.sequence).args.push(typeof delta === 'string' ? delta : JSON.stringify(delta));
        } else if (name === 'TOOL_CALL_END') {
            get_call(call_id, event.sequence).ended = true;
        }
    }
    const items = [...calls.values()].sort((a, b) => a.sequence - b.sequence).map(item => {
        const args = _parse_args(item.parameters !== undefined ? item.parameters : item.args.join('') || undefined);
        return { key: item.key, has_id: true, sequence: item.sequence, tool_name: item.tool_name, intent: item.explicit || _text(args?.intent), ready: Boolean(item.explicit) || item.ended || args !== null };
    });
    return { items, state: terminal_states.has(state) ? state : null };
}

/** Tool calls of messages in order: [{key, has_id, sequence, intent, tool_name, ready}]; key = tool call id, else prefix and position. */
function _message_calls(messages, prefix = 'message') {
    const calls = new Map();
    let position = 0;
    for (const message of messages) {
        for (const call of Array.isArray(message?.toolCalls) ? message.toolCalls : []) {
            if (!call || typeof call !== 'object') continue;
            const has_id = typeof call.id === 'string' || typeof call.id === 'number';
            const key = has_id ? String(call.id) : `${prefix}-${position}`;
            position++;
            if (calls.has(key)) continue;
            const explicit = _text(call.intent);
            const args = _parse_args(call.arguments ?? call.function?.arguments);
            const done = (call.response !== undefined && call.response !== null) || call.status !== undefined;
            calls.set(key, { key, has_id, sequence: calls.size, tool_name: _text(call.toolName ?? call.name ?? call.function?.name), intent: explicit || _text(args?.intent), ready: Boolean(explicit) || args !== null || done });
        }
    }
    return [...calls.values()];
}

/** Step items of one message's tool calls, each call once per history. */
function _history_steps(message, keys) {
    return _message_calls([message], `${message.id}`).filter(call => !keys.has(call.key) && keys.add(call.key)).map(call => step_text(call.intent)).filter(Boolean).map(text => ({ role: 'step', text }));
}

/** Tool calls of the run started by the user message message_id. */
function _run_calls(messages, message_id) {
    if (!Array.isArray(messages)) return [];
    const start = messages.findIndex(message => message?.id === message_id && _is_user(message));
    if (start < 0) return [];
    const rest = messages.slice(start + 1);
    const end = rest.findIndex(_is_user);
    return _message_calls(end < 0 ? rest : rest.slice(0, end));
}

class ChatSession {
    /**
     * @param {object} options
     * @param {import('./awork').AworkClient} options.client
     * @param {{name, agentId, coAgentId?, coAgentName?}} options.agent
     * @param {{maxCredits, maxCoAgentCredits, maxCoAgents, relayTimeout, pollInterval}} options.limits 0 = no cap
     * @param {{load?: () => object|undefined, save: (state: object) => void}} options.store persisted chat state; without load the session starts with a new chat
     * @param {{write: (path: string, data: string|Uint8Array) => Promise<string>}|null} options.workspace repo access
     * @param {{message, status, answer_credits?}} options.ui callbacks for the chat window; steps come as message({role: 'step', text})
     */
    constructor({ client, agent, limits, store, workspace, ui, sleep, credit_refresh_ms = 10_000, credit_read_timeout_ms = 15_000, progress_timeout_ms = 5_000 }) {
        Object.assign(this, { client, agent, limits, store, workspace, ui, credit_refresh_ms, credit_read_timeout_ms, progress_timeout_ms });
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
        Object.assign(this, { credits: null, credit_error: null, co_credits: null, co_credit_error: null, credits_at: 0, busy: false, stopping: false, controller: null, answers: new Map(), staged_outputs: new Map(), phase: null, phase_since: null, last_states: new Map(), empty_polls: new Map(), staged_data: new Map(), event_reads: new Map(), events_disabled: false, credit_refresh_index: 0, agent_run_active: false, idle_credit_read: null, budget_check: null, local_keys: 0, chat_controller: new AbortController() });
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
            busy: this.busy, thread_id: this.state.thread_id,
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

    async _request(action, signal = this.controller?.signal) {
        if (this.stopping || signal?.aborted) throw new StopRequested();
        try {
            return await abortable(() => action(signal), signal);
        } catch (error) {
            if (this.stopping || signal?.aborted) throw new StopRequested();
            throw error;
        }
    }

    _save() {
        this.store.save(this.state);
    }

    // --- steps (display only: never awaited on the critical path) ---
    _step(text) {
        if (text) this.ui.message({ role: 'step', text });
    }

    _info(text) {
        this._step(relay_text(text));
    }

    _events_available() {
        return !this.events_disabled && typeof this.client.events === 'function';
    }

    /** One events read per thread at a time; null if not readable (401/403 switch the events off for this session). */
    _read_events(thread_id) {
        if (!this._events_available()) return Promise.resolve(null);
        const pending = this.event_reads.get(thread_id);
        if (pending) return pending;
        const request = this._request(signal => this.client.events(thread_id, { signal })).then(events => (Array.isArray(events) ? events : null), error => {
            if ([401, 403].includes(error.status)) this.events_disabled = true;
            return null;
        }).finally(() => {
            if (this.event_reads.get(thread_id) === request) this.event_reads.delete(thread_id);
        });
        this.event_reads.set(thread_id, request);
        return request;
    }

    _steps_start(thread_id, message_id, run_info = {}) {
        const run = { thread_id, message_id, run_id: _event_run_id(run_info, null), fresh: Boolean(run_info._new_thread), signal: this.controller?.signal, emitted: new Set(), event_items: [], has_events: false, closed: false, terminal: null, events_pending: null, messages_pending: null };
        run.finished = new Promise(resolve => { run.resolve_finished = resolve; });
        return run;
    }

    _steps_live(run) {
        return !run.closed && !run.signal?.aborted && run.thread_id === this.state.thread_id;
    }

    /** Show calls not shown yet, in order; before the end only the ready prefix (a later call makes the earlier ones ready). */
    _steps_emit(run, items, final = false) {
        const ordered = [...items].sort((a, b) => a.sequence - b.sequence);
        for (const [index, item] of ordered.entries()) {
            if (run.emitted.has(item.key)) continue;
            if (!final && !item.ready && index === ordered.length - 1) break;
            run.emitted.add(item.key);
            this._step(step_text(item.intent));
        }
    }

    /** Start background reads of the run's tool calls (events, else messages); results of a closed run are dropped. */
    _steps_refresh(run) {
        if (!this._steps_live(run)) return;
        if (!run.terminal && !run.events_pending && this._events_available()) {
            run.events_pending = this._read_events(run.thread_id).then(events => {
                if (!this._steps_live(run) || !events) return;
                const payload = _event_calls(events, run.message_id, run.run_id, run.fresh);
                if (!payload) return;
                if (payload.items.length || payload.state) run.has_events = true;
                run.event_items = payload.items;
                this._steps_emit(run, payload.items);
                if (payload.state && !run.terminal) {
                    run.terminal = { state: payload.state, response_id: null };
                    run.resolve_finished({ run: run.terminal });
                }
            }).catch(error => log(`steps: events not applied (${error.message})`)).finally(() => { run.events_pending = null; });
        }
        // the messages are read live only without events; with events they only fill gaps at the end
        if (!this._events_available() && !run.has_events && !run.messages_pending) {
            run.messages_pending = this._request(signal => this.client.messages(run.thread_id, { signal }), run.signal).then(messages => {
                if (this._steps_live(run) && !run.has_events) this._steps_emit(run, _run_calls(messages, run.message_id));
            }).catch(() => {}).finally(() => { run.messages_pending = null; });
        }
    }

    /** Show the remaining calls of the finished run from the last events and the final messages; called before the answer is shown. */
    _steps_finish(run, messages) {
        if (!this._steps_live(run)) return;
        this._steps_emit(run, run.event_items, true);
        const calls = _run_calls(messages, run.message_id);
        this._steps_emit(run, run.has_events ? calls.filter(call => call.has_id) : calls, true);
        run.closed = true;
    }

    /** Abort the reads of the current chat (chat switched); late results are dropped. */
    _reset_chat_reads() {
        this.chat_controller.abort();
        Object.assign(this, { chat_controller: new AbortController(), idle_credit_read: null });
    }

    // --- credits ---
    /** Run action(signal) with the credit read time limit; aborted by any of signals. */
    _credit_call(action, signals = []) {
        const controller = new AbortController();
        const sources = signals.filter(Boolean);
        const on_abort = () => controller.abort(new StopRequested('credit read stopped'));
        const timer = setTimeout(() => controller.abort(new Error('credit read timed out')), this.credit_read_timeout_ms);
        timer.unref?.();
        sources.forEach(signal => (signal.aborted ? on_abort() : signal.addEventListener('abort', on_abort, { once: true })));
        return abortable(() => action(controller.signal), controller.signal).finally(() => {
            clearTimeout(timer);
            sources.forEach(signal => signal.removeEventListener('abort', on_abort));
        });
    }

    /** Sum of creditsUsed of the given threads (thread details, no admin rights needed): {used, error}; used = null if not readable. Never rejects. */
    async _thread_credits(ids, signals = []) {
        try {
            const threads = await Promise.all([...new Set(ids.filter(Boolean))].map(id => this._credit_call(signal => this.client.thread(id, { signal }), signals)));
            return { used: threads.reduce((sum, thread) => sum + (thread?.usage?.creditsUsed || 0), 0), error: null };
        } catch (error) {
            return { used: null, error: error?.message || String(error) };
        }
    }

    /** Credits of the agent thread; a read started while no agent run is active is the baseline for the next answer. */
    _agent_credit_read(thread_id, signals) {
        const promise = this._thread_credits([thread_id], signals);
        if (thread_id && !this.agent_run_active) this.idle_credit_read = { thread_id, promise };
        return promise;
    }

    /** Credits of this chat, separately for the agent thread and all co-agent threads. Returns {credits, co_credits}; never rejects. */
    async refresh_credits() {
        const refresh_index = ++this.credit_refresh_index;
        const thread_id = this.state.thread_id;
        const signals = [this.controller?.signal, this.chat_controller.signal];
        const [agent, co_agents] = await Promise.all([
            this._agent_credit_read(thread_id, signals),
            this._thread_credits(Object.values(this.state.co_agents).map(co_agent => co_agent.thread_id), signals),
        ]);
        if (refresh_index !== this.credit_refresh_index || thread_id !== this.state.thread_id) return { credits: this.credits, co_credits: this.co_credits };
        Object.assign(this, { credits: agent.used, credit_error: agent.error, co_credits: co_agents.used, co_credit_error: co_agents.error, credits_at: Date.now() });
        this._emit();
        return { credits: this.credits, co_credits: this.co_credits };
    }

    /** Agent credits of one answer (agent thread after the run minus baseline): reported via ui.answer_credits and saved; never awaited. */
    _answer_credits(thread_id, key, baseline, persist) {
        if (!thread_id || !baseline) return;
        const chat = this.chat_controller;
        const after = this._agent_credit_read(thread_id, [chat.signal]);
        Promise.all([baseline, after]).then(([before, now]) => {
            if (chat.signal.aborted || thread_id !== this.state.thread_id || before.used === null || now.used === null) return;
            const credits = now.used - before.used;
            if (!Number.isFinite(credits) || credits < 0) return;
            if (persist) this._store_answer_credits(key, credits);
            this.ui.answer_credits?.({ thread_id, key, credits });
        }).catch(error => log(`answer credits not shown: ${error.message}`));
    }

    _store_answer_credits(key, credits) {
        const stored = { ...this.state.answer_credits };
        delete stored[key];
        stored[key] = credits;
        this.state.answer_credits = Object.fromEntries(Object.entries(stored).slice(-max_answer_credits));
        this._save();
    }

    /** Check the credit caps. strict (before sending): waits for the read only if a cap is set (bounded by credit_read_timeout_ms). */
    async _check_budget(strict) {
        if (strict && !this.max_credits() && !this.max_co_credits()) {
            this.refresh_credits();
            return;
        }
        const controller = this.controller;
        await this.refresh_credits();
        if (this.stopping) throw new StopRequested();
        // a background check that ends after its send must not stop the next one
        if (!strict && controller !== this.controller) return;
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

    /** Wait one poll interval; the periodic budget check runs in the background (one at a time) and never delays the wait. */
    async _tick() {
        if (this.stopping) throw new StopRequested();
        if (!this.budget_check && Date.now() - this.credits_at >= this.credit_refresh_ms) {
            this.budget_check = this._check_budget(false).catch(error => {
                if (!(error instanceof StopRequested)) log(`credit check failed: ${error.message}`);
            }).finally(() => { this.budget_check = null; });
        }
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
        const steps = this._steps_start(thread_id, message_id, run_info);
        let run;
        let checked_at = Date.now();
        try {
            while (true) {
                if (steps.terminal) { run = steps.terminal; break; }
                this._steps_refresh(steps);
                const poll_controller = new AbortController();
                try {
                    const status = this._run_state(thread_id, message_id, poll_controller.signal).then(value => ({ run: value }), error => ({ error }));
                    const outcome = await this._request(() => Promise.race([status, steps.finished]));
                    if (outcome.error) throw outcome.error;
                    run = steps.terminal || outcome.run;
                } finally {
                    poll_controller.abort();
                }
                if (run.state) break;
                const every = (this.limits.syncInterval || 0) * 1000;
                if (every && thread_id === this.state.thread_id && Date.now() - checked_at >= every) {
                    checked_at = Date.now();
                    const sync = this._check_superseded(thread_id, message_id);
                    await this._request(() => Promise.race([sync, steps.finished]));
                }
                const tick = this._tick();
                await this._request(() => Promise.race([tick, steps.finished]));
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
            this._steps_finish(steps, messages);
            return { ...answer, state: run.state };
        } finally {
            steps.closed = true;
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
        if (this.stopping) throw new StopRequested();
        this._set_phase('agent');
        const thread_before = this.state.thread_id;
        const idle = this.idle_credit_read;
        const baseline = !thread_before ? Promise.resolve({ used: 0, error: null }) : idle?.thread_id === thread_before ? idle.promise : null;
        this.agent_run_active = true;
        try {
            let accepted;
            const options = { ...this._model_options(), ...(interrupt_id ? { answerToInterruptId: interrupt_id } : {}) };
            if (this.state.thread_id) {
                accepted = await this._request(signal => this.client.send_message(this.state.thread_id, content, attachments, options, { signal }));
            } else {
                accepted = await this._request(signal => this.client.create_thread(this.agent.agentId, content, `monarch – ${this.agent.name} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, attachments, options, { signal }));
                accepted = { ...accepted, _new_thread: true };
                this.state.thread_id = accepted.id;
                this._save();
            }
            if (context) {
                this.state.context = context;
                this._save();
            }
            const run = await this._wait_for_run(this.state.thread_id, await this._accepted_id(this.state.thread_id, accepted), accepted);
            return { ...run, duration_ms: Date.now() - started, thread_id: this.state.thread_id, baseline };
        } finally {
            this.agent_run_active = false;
        }
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
            if (error instanceof Superseded) this._info('chat continued in awork: stopped waiting, the chat is reloaded');
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

    async _handle_answer({ answer, run, state, duration_ms, thread_id, baseline }) {
        const { text, commands } = parse_commands(answer_text(answer));
        const written = await this._write_repo_files(run);
        log(`answer: ${run.length} run message(s), question message ${run.some(_is_question)}`);
        const questions = [...questions_of(run), ...await this._pending_questions(run)];
        const shown = _without_questions(text, questions);
        const message_id = [...answer].reverse().find(message => message.content)?.id;
        const credit_key = message_id ? String(message_id) : `local-${++this.local_keys}`;
        this.ui.message({ role: 'agent', text: shown || (questions.length ? '' : state === 'completed' ? '(no answer)' : `(run ${state})`), files: written.files, warnings: written.warnings, duration_ms, credit_key, credits: null });
        this._answer_credits(thread_id, credit_key, baseline, Boolean(message_id));
        questions.forEach(question => this.ui.message(question));
        if (!commands.length) return null;
        this._set_phase('commands');
        const results = [];
        const spawn_context = { ids: new Map(), count: commands.filter(command => command.action === 'spawn').length };
        const conflicts = [...new Set(commands.map(command => command.action).filter(action => inspect_conflicts.has(action)))];
        const inspect_context = { count: 0, conflicts };
        let spawn_index = 0;
        for (const command of commands) {
            const item = command.action === 'spawn' ? { ...command, spawn_index: ++spawn_index, spawn_context } : command.action === 'inspect' ? { ...command, inspect_context } : command;
            results.push(await this._execute(item));
        }
        this._resolve_spawn_refs(results, spawn_context);
        results.forEach(result => this._info(`${result.ok ? 'ok' : 'refused'}: ${result.line}`));
        this._save();
        this._emit();
        if (results.some(result => result.ok && result.action === 'inspect')) return this._inspect_relay(results);
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
                found.set(path, { path, data: await this._request(signal => this.client.download(file.downloadUrl, { signal })), url: file.downloadUrl });
                log(`download ${path}: ok`);
            } catch (error) {
                if (error instanceof StopRequested) throw error;
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
        if (!this.staged_data.has(path)) this.staged_data.set(path, await this._request(signal => this.client.download(this.state.staged[path].url, { signal })));
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
                if (download_error instanceof StopRequested) throw download_error;
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
                if (error instanceof StopRequested) throw error;
                throw new Error(`attachment ${path} not readable (${error.status ? _reason(error) : error.message})`);
            }
            attachments.push({ temporaryFileId: await this._request(signal => this.client.upload_temporary_file(files.basename(path), data, undefined, { signal })) });
        }
        const content = lines.filter(line => !attach_pattern.test(line)).join('\n').trim();
        return { content: `${content}\n\nAttached files (relative to repo root): ${paths.join(', ')}`, attachments };
    }

    /**
     * Files of an inspect block for the agent's own review: "ATTACH: <co-agent id>" (all its staged files),
     * "ATTACH: <repo path>" (staged version, else local repo) and "ATTACH: repo:<repo path>" (local repo version).
     * Nothing is sent to a co-agent and nothing is written. Returns {files: [{name, path, source, upload}], missing, line}.
     */
    async _inspect(body, context = { count: 0 }) {
        const entries = (body || '').split('\n').map(line => attach_pattern.exec(line)?.[1].trim()).filter(Boolean);
        if (!entries.length) return { files: [], missing: [], line: 'inspect: no ATTACH lines' };
        const wanted = [];
        const missing = [];
        const add = (path, local, from = null) => {
            const safe = files.safe_rel_path(path);
            if (!safe || files.is_junk(safe)) return missing.push(`${path} (unsafe path)`);
            const source = local ? 'local repo' : `staged by ${from}`;
            if (!wanted.some(item => item.path === safe && item.source === source)) wanted.push({ path: safe, local, source });
        };
        for (const entry of entries) {
            if (repo_prefix.test(entry)) add(entry.replace(repo_prefix, ''), true);
            else if (this.state.co_agents[entry]) {
                const paths = Object.keys(this.state.staged).filter(path => this.state.staged[path].from === entry);
                if (!paths.length) missing.push(`${entry} (no staged files)`);
                paths.forEach(path => add(path, false, entry));
            } else {
                const path = files.safe_rel_path(entry);
                const staged = path && this.state.staged[path];
                add(entry, !staged, staged?.from);
            }
        }
        if (context.count + wanted.length > max_attachments) return { files: [], missing, line: `inspect: max. ${max_attachments} files per message (${context.count + wanted.length} requested), split into several rounds` };
        const found = [];
        const names = new Set();
        for (const item of wanted) {
            let data;
            try {
                if (!item.local) data = await this._staged_file(item.path);
                else if (!this.workspace?.read) throw new Error('no folder open');
                else data = await this.workspace.read(item.path);
            } catch (error) {
                if (error instanceof StopRequested) throw error;
                missing.push(`${item.local ? 'repo:' : ''}${item.path} (${item.local ? 'not in the local repo or not readable' : 'not downloaded'}: ${error.status ? _reason(error) : error.message.slice(0, 120)})`);
                continue;
            }
            const name = _unique_name(files.basename(item.path), names);
            found.push({ name, path: item.path, source: item.source, upload: await this._request(signal => this.client.upload_temporary_file(name, data, undefined, { signal })) });
        }
        context.count += found.length;
        if (!found.length) return { files: found, missing, line: `inspect: no file attached (${missing.join('; ').slice(0, 300)})` };
        return { files: found, missing, line: `inspect: ${found.length} files attached${missing.length ? `, not attached: ${missing.length}` : ''}` };
    }

    /** Relay message with the inspected files as attachments; returned at once, without waiting for co-agents. */
    _inspect_relay(results) {
        const inspected = results.filter(result => result.action === 'inspect');
        const found = inspected.flatMap(result => result.files || []);
        const missing = inspected.flatMap(result => result.missing || []);
        const parts = [`${relay_prefix} inspect`, ['commands:', ...results.map(result => `- ${result.ok ? 'ok' : 'refused'}: ${result.line}`)].join('\n')];
        if (found.length) parts.push(['attachments (file name = repo path, source):', ...found.map(file => `- ${file.name} = ${file.path}, ${file.source}`)].join('\n'));
        if (missing.length) parts.push(['not attached:', ...missing.map(item => `- ${item}`)].join('\n'));
        parts.push(this._status_text(this._co_agents(co_agent => ['working', 'waiting'].includes(co_agent.state)), false));
        return { content: parts.join('\n\n'), attachments: found.map(file => ({ temporaryFileId: file.upload })) };
    }

    async _execute({ action, target, body, spawn_index, spawn_context, inspect_context }) {
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
                const message_id = await this._accepted_id(thread.id, thread);
                this.state.co_agents[id] = { thread_id: thread.id, message_id, first_message_id: message_id, state: 'working', relayed: null };
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
            if (action === 'inspect') {
                if (inspect_context?.conflicts.length) return result(false, `inspect: not allowed together with ${inspect_context.conflicts.join(', ')}, send it in an answer of its own`);
                const { files: found, missing, line } = await this._inspect(body, inspect_context);
                return { ...result(found.length > 0, line), files: found, missing };
            }
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
        const message_id = await this._accepted_id(thread.id, thread);
        Object.assign(co_agent, { thread_id: thread.id, message_id, first_message_id: message_id, state: 'working', relayed: null });
        delete co_agent.pending_spawn;
    }

    async _advance_waiting_spawns() {
        const failures = [];
        let launched = 0;
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
                    failed = `${dependency_id} answered with STATUS: question, blocked or plan`;
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
                launched += 1;
                this._save();
            } catch (error) {
                if (error instanceof StopRequested) throw error;
                Object.assign(co_agent, { state: 'failed', relayed: co_agent.message_id });
                delete co_agent.pending_spawn;
                failures.push({ ok: false, action: 'spawn', line: `spawn ${id}: not started (${error.message.slice(0, 160)})` });
            }
        }
        // nothing changed and no co-agent works: the waiting spawns wait for each other (circular AFTER) and would never start
        if (!launched && !failures.length && !this._co_agents(co_agent => co_agent.state === 'working').length) {
            for (const id of this._co_agents(co_agent => co_agent.state === 'waiting')) {
                const co_agent = this.state.co_agents[id];
                Object.assign(co_agent, { state: 'cancelled', relayed: co_agent.message_id });
                delete co_agent.pending_spawn;
                failures.push({ ok: false, action: 'spawn', line: `spawn ${id}: not started, circular AFTER dependencies` });
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
            this.answers.set(id, answer_of(await this._request(signal => this.client.messages(co_agent.thread_id, { signal })), co_agent.message_id, run.response_id));
            co_agent.state = run.state === 'completed' ? 'answered' : own_co_states.has(run.state) ? `run_${run.state}` : run.state;
            this._save();
        }
        this._emit();
    }

    async _answer_for(id) {
        if (!this.answers.has(id)) {
            const co_agent = this.state.co_agents[id];
            this.answers.set(id, answer_of(await this._request(signal => this.client.messages(co_agent.thread_id, { signal })), co_agent.message_id, null));
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
        this._info('relay: waiting for co-agents');
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
        this._info(`relay: ${id} ${co_agent.state}, ${found.length} files staged`);
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

    /**
     * Progress lines of working co-agents for a timeout relay: "- <id>: <n> steps, last: <a> | <b> | <c>".
     * Display only: bounded by progress_timeout_ms and never rejects; a read that ends later is dropped.
     */
    async _co_agent_progress(ids) {
        if (!ids.length || !this._events_available()) return [];
        const unreadable = id => `- ${id}: steps not readable`;
        const read = async id => {
            const co_agent = this.state.co_agents[id];
            const events = await this._read_events(co_agent.thread_id);
            const payload = events && _event_calls(events, co_agent.message_id, null, co_agent.message_id === co_agent.first_message_id);
            if (!payload) return unreadable(id);
            const steps = payload.items.map(item => _tool_step_text(item.intent, item.tool_name)?.replace(/^Agent step: /, '')).filter(Boolean);
            return `- ${id}: ${steps.length} steps${steps.length ? `, last: ${steps.slice(-progress_steps).join(' | ')}` : ''}`;
        };
        let timer;
        const limit = new Promise(resolve => {
            timer = setTimeout(() => resolve(null), this.progress_timeout_ms);
            timer.unref?.();
        });
        try {
            const lines = await Promise.race([Promise.all(ids.map(id => read(id).catch(() => unreadable(id)))), limit]);
            return lines || ids.map(id => `${unreadable(id)} (timed out)`);
        } finally {
            clearTimeout(timer);
        }
    }

    async _build_relay(fresh, pending, results, timed_out) {
        const parts = [`${relay_prefix} co-agent update`];
        if (results.length) parts.push(['commands:', ...results.map(result => `- ${result.ok ? 'ok' : 'refused'}: ${result.line}`)].join('\n'));
        for (const id of fresh) parts.push(await this._forward(id));
        const progress = timed_out ? await this._co_agent_progress(pending.filter(id => this.state.co_agents[id].state === 'working')) : [];
        if (this.stopping) throw new StopRequested();
        if (progress.length) parts.push(['progress (working co-agents):', ...progress].join('\n'));
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
        if (this.controller) this.controller.abort();
        const working = this._co_agents(co_agent => co_agent.state === 'working').length;
        if (this.state.thread_id) await this.client.cancel(this.state.thread_id).catch(() => {}); // finished runs cannot be cancelled
        await this._stop_co_agents();
        this._save();
        this._info(`stop (${reason}): agent and ${working} co-agents stopped`);
        this._emit();
    }

    /** Forget the current chat; the next message starts a new thread. */
    new_chat() {
        if (this.busy) throw new Notice('Stop the agent first.');
        this.state = _new_state();
        this._reset_chat_reads();
        this.staged_data.clear();
        this.staged_outputs.clear();
        Object.assign(this, { credits: 0, co_credits: 0 });
        this._save();
        this._emit();
    }

    /** Switch to a stored chat state. */
    load_state(state) {
        if (this.busy) throw new Notice('Stop the agent first.');
        this.state = _new_state(state);
        this._reset_chat_reads();
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

    /** Messages of the current chat for display: [{role, text, duration_ms?, credit_key?, credits?}], agent steps before their answer, plus question cards. */
    async history() {
        if (!this.state.thread_id) return [];
        const messages = await this.client.messages(this.state.thread_id);
        this.synced = _signature(messages);
        const seen = new Set();
        const step_keys = new Set();
        let asked_at = null;
        const pending_at = messages.map(_is_question).lastIndexOf(true);
        const open = pending_at >= 0 && !messages.slice(pending_at + 1).some(_is_user);
        const pending = open ? (await this._pending_questions([messages[pending_at]]))[0] : null;
        return messages.flatMap((message, index) => {
            if (pending && index === pending_at) return [pending];
            const role = (message.role || '').toLowerCase();
            const questions = questions_of([message], seen);
            const steps = _is_user(message) || ['tool', 'system'].includes(role) ? [] : _history_steps(message, step_keys);
            if (!message.content || ['tool', 'system'].includes(role)) return [...steps, ...questions];
            const text = files.clean_text(message.content);
            const created = Date.parse(message.createdOn || '') || null;
            if (_is_user(message)) {
                asked_at = created;
                return [text.startsWith(relay_prefix) ? { role: 'step', text: relay_text(`relay: ${_first_line(text.slice(relay_prefix.length)) || 'co-agent update'}`) } : { role: 'user', text: strip_context(text) }];
            }
            const shown = _without_questions(parse_commands(text).text, questions);
            const credit_key = message.id ? String(message.id) : null;
            const credits = credit_key ? this.state.answer_credits?.[credit_key] : null;
            return [...steps, { role: 'agent', text: shown, duration_ms: asked_at && created ? created - asked_at : null, credit_key, credits: Number.isFinite(credits) ? credits : null }, ...questions];
        });
    }
}

module.exports = { ChatSession, Notice, StopRequested, Superseded, answer_of, answer_text, pending_question, questions_of, relay_prefix, relay_text, step_text };
