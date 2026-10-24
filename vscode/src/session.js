'use strict';
/** One chat with an awork agent: messages, co-agent relay via ORCA commands, limits, credits and stop. */
const files = require('./files');
const { parse_commands } = require('./orca');
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

/** Questions with answer options that the agent asked via tool calls: [{role: 'question', text, options, custom}], each tool call once. */
function questions_of(messages, seen = new Set()) {
    return messages.flatMap(message => message.toolCalls || []).flatMap(call => {
        const args = _arguments(call);
        const key = call.id || args.question;
        if (typeof args.question !== 'string' || !Array.isArray(args.options) || !args.options.length || seen.has(key)) return [];
        seen.add(key);
        return [{ role: 'question', text: args.question, options: args.options.map(String), custom: Boolean(args.allowCustomText) }];
    });
}

/** Text without a trailing copy of the question texts (shown as cards instead). */
function _without_questions(text, questions) {
    return questions.reduce((rest, { text: question }) => (rest.trimEnd().endsWith(question.trim()) ? rest.trimEnd().slice(0, -question.trim().length).trimEnd() : rest), text);
}

/** Fingerprint of a message list to detect changes made elsewhere (e.g. in the awork web app). */
function _signature(messages) {
    return messages.map(message => `${message.id}:${(message.content || '').length}:${(message.toolCalls || []).length}:${message.isStreaming ? 1 : 0}`).join('|');
}

/** Chat state with defaults: thread, title, model override, last sent repo context, job (rounds, co-agents). */
function _new_state(state) {
    return { thread_id: null, title: null, model: null, context: null, rounds: 0, next_index: 1, co_agents: {}, ...(state || {}) };
}

class ChatSession {
    /**
     * @param {object} options
     * @param {import('./awork').AworkClient} options.client
     * @param {{name, agentId, coAgentId?, coAgentName?}} options.agent
     * @param {{maxCredits, maxCoAgents, maxRounds, relayTimeout, pollInterval}} options.limits 0 = no cap
     * @param {{load: () => object|undefined, save: (state: object) => void}} options.store persisted chat state
     * @param {{write: (path: string, data: string|Uint8Array) => Promise<string>}|null} options.workspace repo access
     * @param {{message, info, status}} options.ui callbacks for the chat window
     */
    constructor({ client, agent, limits, store, workspace, ui, sleep, credit_refresh_ms = 10_000 }) {
        Object.assign(this, { client, agent, limits, store, workspace, ui, credit_refresh_ms });
        this.sleep = sleep || ((ms, signal) => new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            signal.addEventListener('abort', () => { clearTimeout(timer); reject(new StopRequested()); }, { once: true });
        }));
        this.state = _new_state(store.load());
        Object.assign(this, { credits: null, credit_error: null, credits_at: 0, busy: false, stopping: false, controller: null, answers: new Map(), phase: null, phase_since: null, last_states: new Map(), empty_polls: new Map() });
    }

    // --- state ---
    _co_agents(filter = () => true) {
        return Object.entries(this.state.co_agents).filter(([, co_agent]) => filter(co_agent)).map(([id]) => id);
    }

    status() {
        return {
            credits: this.credits, max_credits: this.limits.maxCredits,
            co_agents: this._co_agents(co_agent => co_agent.state !== 'cancelled').length,
            working: this._co_agents(co_agent => co_agent.state === 'working').length,
            max_co_agents: this.limits.maxCoAgents, busy: this.busy, thread_id: this.state.thread_id,
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

    _save() {
        this.store.save(this.state);
    }

    // --- credits ---
    /** Credits of this chat: agent thread plus all co-agent threads (thread details, no admin rights needed). null if not readable. */
    async refresh_credits() {
        const ids = [...new Set([this.state.thread_id, ...Object.values(this.state.co_agents).map(co_agent => co_agent.thread_id)].filter(Boolean))];
        try {
            const threads = await Promise.all(ids.map(id => this.client.thread(id)));
            this.credits = threads.reduce((sum, thread) => sum + (thread.usage?.creditsUsed || 0), 0);
            this.credit_error = null;
        } catch (error) {
            Object.assign(this, { credits: null, credit_error: error.message });
        }
        this.credits_at = Date.now();
        this._emit();
        return this.credits;
    }

    async _check_budget(strict) {
        const limit = this.limits.maxCredits;
        const used = await this.refresh_credits();
        if (!limit) return;
        if (used === null) {
            if (strict) throw new Error(`Credits not readable (${this.credit_error}). Set monarch.maxCredits to 0 to chat without a credit cap.`);
            return;
        }
        if (used >= limit) {
            await this.stop(`maxCredits reached (${used}/${limit})`);
            throw new StopRequested();
        }
    }

    async _tick() {
        if (this.stopping) throw new StopRequested();
        if (Date.now() - this.credits_at >= this.credit_refresh_ms) await this._check_budget(false);
        await this.sleep(this.limits.pollInterval * 1000, this.controller.signal);
    }

    // --- runs ---
    async _run_state(thread_id, message_id) {
        const status = await this.client.message_status(thread_id, message_id);
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
        const messages = await this.client.messages(thread_id);
        return [...messages].reverse().find(_is_user)?.id;
    }

    async _wait_for_run(thread_id, message_id) {
        let run;
        let checked_at = Date.now();
        while (!(run = await this._run_state(thread_id, message_id)).state) {
            const every = (this.limits.syncInterval || 0) * 1000;
            if (every && thread_id === this.state.thread_id && Date.now() - checked_at >= every) {
                checked_at = Date.now();
                await this._check_superseded(thread_id, message_id);
            }
            await this._tick();
        }
        const messages = await this.client.messages(thread_id);
        if (thread_id === this.state.thread_id) this.synced = _signature(messages);
        return { ...answer_of(messages, message_id, run.response_id), state: run.state };
    }

    /** Throw Superseded if a newer user message (written elsewhere) follows message_id. */
    async _check_superseded(thread_id, message_id) {
        const messages = await this.client.messages(thread_id);
        const index = messages.findIndex(message => message.id === message_id);
        if (index < 0 || !messages.slice(index + 1).some(_is_user)) return;
        log(`chat ${thread_id}: continued elsewhere, stop waiting for ${message_id}`);
        throw new Superseded();
    }

    /** Send one message; context = repo context line contained in content, remembered once the message is accepted. */
    async _post(content, attachments, context = null) {
        const started = Date.now();
        this._set_phase('agent');
        let accepted;
        const options = this._model_options();
        if (this.state.thread_id) {
            accepted = await this.client.send_message(this.state.thread_id, content, attachments, options);
        } else {
            accepted = await this.client.create_thread(this.agent.agentId, content, `monarch – ${this.agent.name} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, attachments, options);
            this.state.thread_id = accepted.id;
            this._save();
        }
        if (context) {
            this.state.context = context;
            this._save();
        }
        const run = await this._wait_for_run(this.state.thread_id, await this._accepted_id(this.state.thread_id, accepted));
        return { ...run, duration_ms: Date.now() - started };
    }

    /**
     * Send a user message (with uploads [{name, data, mime_type}]) and run the relay until the agent stops issuing commands.
     * The repo context line is only added when it differs from the last one sent in this chat.
     * Resolves when the agent is done or stopped.
     */
    async send(text, uploads = [], context = '') {
        if (this.busy) throw new Notice('The agent is still working.');
        if (!this.agent.agentId) throw new Notice(`Set agentId for ${this.agent.name} in monarch.agents.`);
        if (uploads.length > max_attachments) throw new Notice(`Max. ${max_attachments} attachments per message.`);
        Object.assign(this, { busy: true, stopping: false, controller: new AbortController() });
        this._emit();
        try {
            await this._check_budget(true);
            if (!this.state.thread_id && !this.state.title) this.state.title = _first_line(text);
            const fresh = context && context !== this.state.context ? context : null;
            let next = { content: fresh ? `${text}\n\n${fresh}` : text, attachments: await this._upload(uploads), context: fresh };
            this.ui.message({ role: 'user', text });
            while (next) next = await this._handle_answer(await this._post(next.content, next.attachments, next.context));
        } catch (error) {
            if (error instanceof Superseded) this.ui.info('chat continued in awork: stopped waiting, the chat is reloaded');
            else if (!(error instanceof StopRequested)) throw error;
        } finally {
            Object.assign(this, { busy: false, controller: null, phase: null, phase_since: null });
            await this.refresh_credits();
        }
    }

    async _upload(uploads) {
        const attachments = [];
        for (const { name, data, mime_type } of uploads) attachments.push({ temporaryFileId: await this.client.upload_temporary_file(name, data, mime_type) });
        return attachments;
    }

    // --- answer handling ---
    async _handle_answer({ answer, run, state, duration_ms }) {
        const { text, commands } = parse_commands(answer_text(answer));
        const written = await this._write_repo_files(run);
        const questions = questions_of(run);
        const shown = _without_questions(text, questions);
        this.ui.message({ role: 'agent', text: shown || (questions.length ? '' : state === 'completed' ? '(no answer)' : `(run ${state})`), files: written.files, warnings: written.warnings, duration_ms });
        questions.forEach(question => this.ui.message(question));
        if (!commands.length) return null;
        const results = [];
        for (const command of commands) results.push(await this._execute(command));
        results.forEach(result => this.ui.info(`${result.ok ? 'ok' : 'refused'}: ${result.line}`));
        this._save();
        this._emit();
        const waits = results.some(result => result.ok && ['spawn', 'send', 'wait'].includes(result.action));
        const relay = waits ? await this._relay_wait(results) : null;
        if (relay || results.every(result => result.ok)) return relay;
        return this._build_relay([], this._co_agents(co_agent => co_agent.state === 'working'), results, false);
    }

    /** Download the output files of a run (message files, then hidden artifact markers): {files: [{path, data}], warnings}. */
    async _collect_files(thread_id, run) {
        const found = [];
        const warnings = [];
        const seen = new Set();
        for (const file of run.flatMap(message => [...(message.temporaryFiles || []), ...(_is_user(message) ? [] : files.marker_files(message.content))])) {
            const path = files.safe_rel_path(files.output_rel_path(file));
            if (!path || files.is_junk(path) || files.is_junk(file.sandboxPath || file.id || '') || seen.has(path)) continue;
            seen.add(path);
            try {
                found.push({ path, data: await this.client.download_file(thread_id, file) });
                log(`download ${path}: ok`);
            } catch (error) {
                const meta = Object.fromEntries(['id', 'name', 'mimeType', 'sandboxPath', 'downloadUrl'].map(key => [key, file[key] ?? null]));
                log(`download ${path}: failed, file ${JSON.stringify(meta)}: ${error.message}`);
                warnings.push(`${path} not received (download failed: ${error.message.slice(0, 160)})`);
            }
        }
        return { files: found, warnings };
    }

    async _write_repo_files(run) {
        const { files: found, warnings } = await this._collect_files(this.state.thread_id, run);
        const written = [];
        for (const file of found) {
            if (!this.workspace) {
                warnings.push(`${file.path} not written (no folder open)`);
                continue;
            }
            try {
                written.push({ path: await this.workspace.write(file.path, file.data) });
            } catch (error) {
                warnings.push(`${file.path} not written (${error.message})`);
            }
        }
        return { files: written, warnings };
    }

    // --- ORCA commands ---
    _limit_error(new_co_agent) {
        const { maxRounds, maxCoAgents, maxCredits } = this.limits;
        if (!this.agent.coAgentId) return `no coAgentId configured for ${this.agent.name}`;
        if (maxRounds && this.state.rounds >= maxRounds) return `maxRounds reached (${this.state.rounds}/${maxRounds})`;
        const alive = this._co_agents(co_agent => co_agent.state !== 'cancelled').length;
        if (new_co_agent && maxCoAgents && alive >= maxCoAgents) return `maxCoAgents reached (${alive}/${maxCoAgents}), cancel one first`;
        if (maxCredits && this.credits !== null && this.credits >= maxCredits) return `maxCredits reached (${this.credits}/${maxCredits})`;
        return null;
    }

    /** Turn "ATTACH: <repo path>" lines of a brief into attachments read from the local repo. */
    async _brief(body) {
        const lines = body.split('\n');
        const paths = lines.map(line => attach_pattern.exec(line)?.[1].trim()).filter(Boolean);
        if (!paths.length) return { content: body, attachments: [] };
        if (paths.length > max_attachments) throw new Error(`max. ${max_attachments} files per message`);
        const unsafe = paths.filter(path => !files.safe_rel_path(path) || files.is_junk(path));
        if (unsafe.length) throw new Error(`unsafe attachment path ${unsafe.join(', ')}`);
        if (!this.workspace?.read) throw new Error('no folder open for attachments');
        const attachments = [];
        for (const path of paths.map(files.safe_rel_path)) {
            let data;
            try {
                data = await this.workspace.read(path);
            } catch (error) {
                throw new Error(`attachment ${path} not readable (${error.message})`);
            }
            attachments.push({ temporaryFileId: await this.client.upload_temporary_file(files.basename(path), data) });
        }
        const content = lines.filter(line => !attach_pattern.test(line)).join('\n').trim();
        return { content: `${content}\n\nAttached files (relative to repo root): ${paths.join(', ')}`, attachments };
    }

    async _execute({ action, target, body }) {
        const result = (ok, line) => ({ ok, action, line });
        const co_agent = target ? this.state.co_agents[target] : null;
        try {
            if (action === 'spawn') {
                if (!body) return result(false, 'spawn: empty brief');
                const error = this._limit_error(true);
                if (error) return result(false, `spawn: ${error}`);
                const { content, attachments } = await this._brief(body);
                const id = `${this.agent.coAgentName || 'coagent'}_${this.state.next_index}`;
                this.state.next_index += 1;
                const thread = await this.client.create_thread(this.agent.coAgentId, content, `${id} – ${_first_line(content)}`, attachments);
                this.state.co_agents[id] = { thread_id: thread.id, message_id: await this._accepted_id(thread.id, thread), state: 'working', relayed: null };
                this.state.rounds += 1;
                return result(true, `spawn ${id}`);
            }
            if (['send', 'cancel'].includes(action) && !co_agent) return result(false, `${action}: unknown co-agent "${target || ''}", known: ${Object.keys(this.state.co_agents).join(', ') || 'none'}`);
            if (action === 'send') {
                if (co_agent.state === 'cancelled') return result(false, `send ${target}: cancelled, spawn a new one`);
                if (!body) return result(false, `send ${target}: empty message`);
                const error = this._limit_error(false);
                if (error) return result(false, `send ${target}: ${error}`);
                const { content, attachments } = await this._brief(body);
                const accepted = await this.client.send_message(co_agent.thread_id, content, attachments);
                Object.assign(co_agent, { message_id: await this._accepted_id(co_agent.thread_id, accepted), state: 'working' });
                this.state.rounds += 1;
                return result(true, `send ${target}`);
            }
            if (action === 'cancel') {
                if (co_agent.state === 'working') await this.client.cancel(co_agent.thread_id).catch(() => {});
                Object.assign(co_agent, { state: 'cancelled', relayed: co_agent.message_id });
                return result(true, `cancel ${target}`);
            }
            if (action === 'wait') return this._co_agents(item => item.state === 'working').length ? result(true, 'wait') : result(false, 'wait: no co-agent is working');
            if (action === 'stopzilla') return result(true, `stopzilla: ${await this._stop_co_agents()} co-agents stopped, job closed`);
            return result(false, `unknown command "${action}"`);
        } catch (error) {
            if (error instanceof StopRequested) throw error;
            return result(false, `${action}${target ? ` ${target}` : ''}: ${error.message.slice(0, 200)}`);
        }
    }

    async _stop_co_agents() {
        const working = Object.values(this.state.co_agents).filter(co_agent => co_agent.state === 'working');
        await Promise.all(working.map(co_agent => this.client.cancel(co_agent.thread_id).catch(() => {})));
        Object.values(this.state.co_agents).forEach(co_agent => Object.assign(co_agent, { state: 'cancelled', relayed: co_agent.message_id }));
        this.state.rounds = 0;
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
            const fresh = this._co_agents(co_agent => !['working', 'cancelled'].includes(co_agent.state) && co_agent.relayed !== co_agent.message_id);
            const pending = this._co_agents(co_agent => co_agent.state === 'working');
            const timed_out = deadline !== null && Date.now() >= deadline;
            if (!fresh.length && !pending.length) return null;
            let urgent = false;
            for (const id of fresh) urgent = urgent || await this._is_urgent(id);
            if ((fresh.length && (!pending.length || urgent)) || (timed_out && pending.length)) return this._build_relay(fresh, pending, results, timed_out);
            await this._tick();
        }
    }

    async _forward(id, attachments) {
        const co_agent = this.state.co_agents[id];
        const { answer, run } = await this._answer_for(id);
        const text = answer_text(answer);
        const collected = await this._collect_files(co_agent.thread_id, run);
        const warnings = [...collected.warnings];
        const attached = [];
        for (const file of collected.files) {
            if (attachments.length >= max_attachments) {
                warnings.push(`${file.path} not attached (max. ${max_attachments} files per message)`);
            } else {
                try {
                    attachments.push({ temporaryFileId: await this.client.upload_temporary_file(files.basename(file.path), file.data) });
                    attached.push(file.path);
                } catch (error) {
                    warnings.push(`${file.path} not attached (${error.message.slice(0, 160)})`);
                }
            }
        }
        co_agent.relayed = co_agent.message_id;
        this.answers.delete(id);
        this.ui.info(`relay: ${id} ${co_agent.state}, ${attached.length} files`);
        const lines = [`## ${id} (${co_agent.state})`, text || '(no answer text)'];
        if (attached.length) lines.push(`attached: ${attached.join(', ')}`);
        return [...lines, ...warnings.map(warning => `warning: ${warning}`)].join('\n');
    }

    _status_text(pending, timed_out) {
        const { maxRounds, maxCredits } = this.limits;
        const lines = ['status:', ...Object.entries(this.state.co_agents).map(([id, co_agent]) => `- ${id}: ${co_agent.state}`)];
        lines.push(`rounds: ${this.state.rounds}/${maxRounds || 'no cap'}`, `credits: ${this.credits ?? 'unknown'}/${maxCredits || 'no cap'}`);
        if (pending.length) lines.push(`still working: ${pending.join(', ')}${timed_out ? ' (relayTimeout reached)' : ''}`);
        return lines.join('\n');
    }

    async _build_relay(fresh, pending, results, timed_out) {
        const attachments = [];
        const parts = [`${relay_prefix} co-agent update`];
        if (results.length) parts.push(['commands:', ...results.map(result => `- ${result.ok ? 'ok' : 'refused'}: ${result.line}`)].join('\n'));
        for (const id of fresh) parts.push(await this._forward(id, attachments));
        parts.push(this._status_text(pending, timed_out));
        this._save();
        this._emit();
        return { content: parts.join('\n\n'), attachments };
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
        this.ui.info(`stop (${reason}): agent and ${working} co-agents stopped`);
        this._emit();
    }

    /** Forget the current chat; the next message starts a new thread. */
    new_chat() {
        if (this.busy) throw new Notice('Stop the agent first.');
        this.state = _new_state();
        this.credits = 0;
        this._save();
        this._emit();
    }

    /** Switch to a stored chat state. */
    load_state(state) {
        if (this.busy) throw new Notice('Stop the agent first.');
        this.state = _new_state(state);
        this.answers.clear();
        this.credits = null;
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
        return messages.flatMap(message => {
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

module.exports = { ChatSession, Notice, StopRequested, Superseded, answer_of, answer_text, questions_of, relay_prefix };
