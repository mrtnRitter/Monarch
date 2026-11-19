'use strict';

const assert = require('node:assert/strict');
const { ChatSession } = require('../src/session');
const { notes_block, strip_notes, notes_marker, notes_end } = require('../src/notes');
const { strip_context } = require('../src/repo');

const header = `${notes_marker} Notes of this chat, shown next to the chat (not in the repo). To change them, end your answer with "### ORCA: notes" followed by the complete new notes.`;
const limits = { maxCredits: 0, maxCoAgentCredits: 0, maxCoAgents: 0, creditStep: 0, pollInterval: 0, relayTimeout: 0, syncInterval: 0 };

function harness({ answers = [], on_status = null, initial_messages = [] } = {}) {
    const sent = [];
    const messages = [...initial_messages];
    const answer_by_user = new Map();
    let index = 0;
    function accept(content) {
        const run = ++index;
        const user_id = `user-${run}`;
        const answer_id = `answer-${run}`;
        sent.push(content);
        messages.push({ id: user_id, role: 'user', content });
        messages.push({ id: answer_id, role: 'assistant', content: answers.shift() ?? 'ok', isStreaming: false });
        answer_by_user.set(user_id, answer_id);
        return { id: 'thread-1', acceptedMessageId: user_id };
    }
    const client = {
        async create_thread(agent_id, content) { return accept(content); },
        async send_message(thread_id, content) { return accept(content); },
        async message_status(thread_id, message_id) {
            await on_status?.(message_id);
            return { status: 'completed', hasAgentResponse: true, responseId: answer_by_user.get(message_id) };
        },
        async messages() { return messages; },
        async thread() { return { usage: { creditsUsed: 0 } }; },
        async upload_temporary_file(name) { return { id: name }; },
        async cancel() { return {}; },
    };
    const ui = {
        messages: [], notes_calls: [],
        message(item) { this.messages.push(item); },
        status() {},
        notes(item) { this.notes_calls.push(item); },
    };
    const saved = [];
    const store = { save(state) { saved.push({ ...state }); } };
    const session = new ChatSession({ client, agent: { agentId: 'agent-1', name: 'Test' }, limits, store, workspace: {}, ui, sleep: () => Promise.resolve() });
    return { session, sent, messages, ui, saved };
}

async function test_notes_helpers() {
    assert.equal(notes_block('a\nb'), `${header}\na\nb\n${notes_end}`);
    assert.equal(notes_block(''), `${header}\n${notes_end}`);
    assert.equal(strip_notes(strip_context(`hi\n\n${notes_block('a\nb')}\n\n[monarch context] x`)), 'hi');
    assert.equal(strip_notes(strip_context(`hi\n\n${notes_block('')}\n\n[monarch context] x`)), 'hi');
    assert.equal(strip_notes('plain text\nwithout a notes block'), 'plain text\nwithout a notes block');
    const literal = 'Example text:\n[monarch notes] this is user prose\n[/monarch notes]';
    assert.equal(strip_notes(literal), literal);
}

async function test_send_and_notes_snapshot() {
    const { session, sent } = harness();
    assert.equal(session.set_notes('n1', session.notes().rev), true);
    await session.send('text', [], '[monarch context] repo');
    assert.equal(sent[0], ['text', notes_block('n1'), '[monarch context] repo'].join('\n\n'));
    await session.send('second', [], '[monarch context] repo');
    assert.equal(sent[1], 'second');
    assert.equal(sent[1].includes(notes_marker), false);
    assert.equal(session.set_notes('', session.notes().rev), true);
    await session.send('clear', [], '[monarch context] repo');
    assert.equal(sent[2], ['clear', notes_block('')].join('\n\n'));
    assert.equal(notes_block('').split('\n').length, 2);
}

async function test_stale_revision() {
    const { session } = harness();
    const old_rev = session.notes().rev;
    session.set_notes('n1', old_rev);
    session.new_chat();
    assert.equal(session.set_notes('stale', old_rev), false);
    assert.equal(session.notes().text, '');
}

async function test_agent_updates_notes() {
    const { session, sent, ui } = harness({ answers: ['ok\n\n### ORCA: notes\nX\nY', 'later'] });
    const old_rev = session.notes().rev;
    await session.send('prompt');
    assert.equal(session.notes().text, 'X\nY');
    assert.notEqual(session.notes().rev, old_rev);
    assert.deepEqual(ui.notes_calls.at(-1), { text: 'X\nY', rev: session.notes().rev });
    assert.equal(sent.length, 1);
    await session.send('next');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].includes(notes_marker), false);
}

async function test_agent_update_refused_after_user_edit() {
    let session;
    let edited = false;
    const fixture = harness({
        answers: ['ok\n\n### ORCA: notes\nagent text', 'relay received'],
        on_status: async () => {
            if (!edited) {
                edited = true;
                assert.equal(session.set_notes('user text', session.notes().rev), true);
            }
        },
    });
    session = fixture.session;
    await session.send('prompt');
    assert.equal(session.notes().text, 'user text');
    assert.equal(fixture.sent.length, 2);
    assert.equal(fixture.sent[1].startsWith('[monarch relay]'), true);
    assert.equal(fixture.sent[1].includes(notes_block('user text')), true);
}

async function test_history_strips_notes_and_context() {
    const content = `hi\n\n${notes_block('a')}\n\n[monarch context] x`;
    const { session } = harness({ initial_messages: [{ id: 'u', role: 'user', content }] });
    session.load_state({ thread_id: 'thread-1' });
    const history = await session.history();
    assert.equal(history.length, 1);
    assert.equal(history[0].text, 'hi');
}

async function test_chat_switch_notifies_notes() {
    const { session, ui, saved } = harness();
    const initial_rev = session.notes().rev;
    session.new_chat();
    assert.equal(ui.notes_calls.at(-1).text, '');
    assert.notEqual(ui.notes_calls.at(-1).rev, initial_rev);
    const new_chat_rev = session.notes().rev;
    session.load_state({ thread_id: 't', notes: 'z' });
    assert.deepEqual(ui.notes_calls.at(-1), { text: 'z', rev: session.notes().rev });
    assert.notEqual(session.notes().rev, new_chat_rev);
    assert.equal(saved.at(-1).notes, 'z');
}

async function main() {
    await test_notes_helpers();
    await test_send_and_notes_snapshot();
    await test_stale_revision();
    await test_agent_updates_notes();
    await test_agent_update_refused_after_user_edit();
    await test_history_strips_notes_and_context();
    await test_chat_switch_notifies_notes();
    process.stdout.write('All notes tests passed.\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
