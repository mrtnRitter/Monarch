'use strict';

const assert = require('node:assert/strict');
const { ChatSession } = require('../src/session');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function make_session({ state = {}, read_thread = null, co_agent_id = 'co-agent-1' } = {}) {
    const calls = { threads: [], creates: [], sends: [], cancels: [] };
    const client = {
        thread(id, options) {
            calls.threads.push({ id, options });
            return read_thread ? read_thread(id, options, calls) : Promise.resolve({ usage: { creditsUsed: 0 } });
        },
        async create_thread(agent_id, content, title, attachments) {
            calls.creates.push({ agent_id, content, title, attachments });
            const id = `co-thread-${calls.creates.length}`;
            return { id, acceptedMessageId: `accepted-${id}` };
        },
        async send_message(thread_id, content, attachments) {
            calls.sends.push({ thread_id, content, attachments });
            return { acceptedMessageId: `sent-${thread_id}` };
        },
        async cancel(thread_id) { calls.cancels.push(thread_id); return {}; },
        async messages() { return []; },
    };
    const statuses = [];
    const ui = { status(value) { statuses.push(value); }, message() {} };
    const session = new ChatSession({
        client,
        agent: { name: 'Test Agent', agentId: 'agent-1', coAgentId: co_agent_id, coAgentName: 'worker' },
        limits: { maxCredits: 100, maxCoAgentCredits: 100, maxCoAgents: 12, creditStep: 100, pollInterval: 0, relayTimeout: 0 },
        store: { load: () => state, save() {} },
        workspace: {},
        ui,
        sleep: () => Promise.resolve(),
        credit_refresh_ms: 0,
        credit_read_timeout_ms: 10_000,
    });
    return { session, calls, statuses };
}

async function test_spawn_has_no_active_agent_limit() {
    const state = { next_index: 13, co_agents: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
        `worker_${index + 1}`, { state: 'working', thread_id: `thread-${index + 1}`, message_id: `message-${index + 1}` },
    ])) };
    const { session, calls } = make_session({ state });
    const result = await session._execute({ action: 'spawn', body: 'Handle this task' });
    assert.equal(result.ok, true);
    assert.equal(calls.creates.length, 1);
    assert.equal(session._co_agents(agent => agent.state !== 'cancelled').length, 13);
}

async function test_high_credits_do_not_stop_agent_or_co_agents() {
    const { session, calls } = make_session({
        state: {
            thread_id: 'agent-thread',
            co_agents: { worker_1: { state: 'working', thread_id: 'worker-thread', message_id: 'old-message' } },
        },
        read_thread: async () => ({ usage: { creditsUsed: 999999 } }),
    });
    await session.refresh_credits();
    assert.equal(session.credits, 999999);
    assert.equal(session.co_credits, 999999);
    session._post = async () => ({});
    session._handle_answer = async () => null;
    await session.send('Continue the work');
    assert.equal(calls.cancels.length, 0);
    assert.equal(session.credits, 999999);
    const sent = await session._execute({ action: 'send', target: 'worker_1', body: 'Continue too' });
    assert.equal(sent.ok, true);
    assert.equal(calls.sends.length, 1);
    assert.equal(calls.cancels.length, 0);
}

async function test_never_resolving_credit_reads_do_not_delay_send_or_tick() {
    const never = () => new Promise(() => {});
    const send_fixture = make_session({ state: { thread_id: 'agent-thread' }, read_thread: never });
    send_fixture.session.credits = 42;
    send_fixture.session._post = async () => ({});
    send_fixture.session._handle_answer = async () => null;
    let started = Date.now();
    await send_fixture.session.send('Send without waiting for credits');
    assert.ok(Date.now() - started < 200, 'send() waited for the never-resolving credit read');
    assert.equal(send_fixture.session.credits, 42, 'a pending read replaced the previous displayed value');

    const tick_fixture = make_session({ state: { thread_id: 'agent-thread' }, read_thread: never });
    tick_fixture.session.controller = new AbortController();
    tick_fixture.session.credits = 19;
    started = Date.now();
    await tick_fixture.session._tick();
    assert.ok(Date.now() - started < 200, '_tick() waited for the never-resolving credit read');
    assert.equal(tick_fixture.session.credits, 19, 'a pending read replaced the previous displayed value');
    assert.equal(tick_fixture.calls.threads.length, 1);
    const refresh = tick_fixture.session.refresh_credits();
    tick_fixture.session.controller.abort();
    await refresh;
}

async function test_stop_does_not_wait_for_credit_read() {
    const fixture = make_session({ state: { thread_id: 'agent-thread' }, read_thread: () => new Promise(() => {}) });
    const { session, calls } = fixture;
    session.credits = 33;
    session.controller = new AbortController();
    const refresh = session.refresh_credits();
    const started = Date.now();
    await session.stop('test');
    assert.ok(Date.now() - started < 200, 'stop() waited for the never-resolving credit read');
    assert.deepEqual(calls.cancels, ['agent-thread']);
    assert.equal(session.credits, 33, 'a cancelled read replaced the previous displayed value');
    await refresh;
}

async function test_tick_shares_pending_read_and_late_value_only_updates_display() {
    const read = deferred();
    const fixture = make_session({ state: { thread_id: 'agent-thread' }, read_thread: () => read.promise });
    const { session, calls } = fixture;
    session.credits = 7;
    session.co_credits = 4;
    session.controller = new AbortController();
    const refresh = session.refresh_credits();
    assert.equal(session.refresh_credits(), refresh);
    await session._tick();
    await session._tick();
    assert.equal(calls.threads.length, 1, '_tick() started a second credit read while one was pending');
    read.resolve({ usage: { creditsUsed: 120 } });
    await refresh;
    assert.equal(session.credits, 120);
    assert.equal(calls.cancels.length, 0, 'a late credit result stopped an agent or co-agent');
}

async function test_rejected_credit_read_is_handled() {
    const fixture = make_session({ state: { thread_id: 'agent-thread' }, read_thread: async () => { throw new Error('offline'); } });
    const unhandled = [];
    const on_unhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', on_unhandled);
    try {
        await assert.doesNotReject(fixture.session.refresh_credits());
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(unhandled, []);
    } finally {
        process.removeListener('unhandledRejection', on_unhandled);
    }
}

async function test_removed_limit_interface_and_legacy_state() {
    const state = { extra_credits: 500, extra_co_credits: 500, extra_co_agents: 20 };
    const { session } = make_session({ state });
    for (const field of Object.keys(state)) assert.equal(Object.hasOwn(session.state, field), false);
    for (const method of ['max_credits', 'max_co_credits', 'max_co_agents', '_credit_step', '_adjust', 'adjust_credits', 'adjust_co_credits', 'adjust_co_agents', '_check_budget', '_limit_error']) {
        assert.equal(session[method], undefined);
    }
    for (const field of Object.keys(session.status())) assert.equal(/^(max_|credit_step|can_less_|can_more_)/.test(field), false);
    assert.equal(session._co_agent_error(), null);
    const missing_agent = make_session({ co_agent_id: null }).session;
    assert.equal(missing_agent._co_agent_error(), 'no coAgentId configured for Test Agent');
}

async function test_status_relay_credit_line() {
    const { session } = make_session();
    session.credits = 120;
    session.co_credits = null;
    const credit_line = session._status_text([], false).split('\n').find(line => line.startsWith('credits:'));
    assert.equal(credit_line, 'credits: agent 120, co-agents unknown');
}

async function main() {
    await test_spawn_has_no_active_agent_limit();
    await test_high_credits_do_not_stop_agent_or_co_agents();
    await test_never_resolving_credit_reads_do_not_delay_send_or_tick();
    await test_stop_does_not_wait_for_credit_read();
    await test_tick_shares_pending_read_and_late_value_only_updates_display();
    await test_rejected_credit_read_is_handled();
    await test_removed_limit_interface_and_legacy_state();
    await test_status_relay_credit_line();
    process.stdout.write('All session limit tests passed.\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
