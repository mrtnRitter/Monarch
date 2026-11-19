'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { ChatSession, StopRequested } = require('../src/session');
const { unified_diff, plan_diffs } = require('../src/diff');

function make_session({ repo = {}, downloads = {}, limits = {}, read, upload } = {}) {
    const reads = [];
    const uploads = [];
    const client = {
        download: async url => {
            if (!Object.hasOwn(downloads, url)) throw new Error(`missing download ${url}`);
            const data = downloads[url];
            return Buffer.from(data);
        },
        upload_temporary_file: async (name, data, mime, options) => {
            uploads.push({ name, data: Buffer.from(data), mime, options });
            return upload ? upload(name, data, mime, options) : `upload-${uploads.length}`;
        },
        send_message: async () => ({ acceptedMessageId: 'message-next' }),
        create_thread: async () => ({ id: 'thread-reviewer', acceptedMessageId: 'message-review' }),
    };
    const workspace = {
        read: read || (async path => {
            reads.push(path);
            if (!Object.hasOwn(repo, path)) throw new Error('not found');
            return Buffer.from(repo[path]);
        }),
        exists: async path => Object.hasOwn(repo, path),
    };
    const session = new ChatSession({
        client,
        agent: { name: 'A', agentId: 'a', coAgentId: 'c', coAgentName: 'minizilla' },
        limits,
        store: { load: () => ({}), save() {} },
        workspace,
        ui: { message() {}, status() {} },
    });
    return { session, reads, uploads };
}

function run_file(path, url) {
    return [{ temporaryFiles: [{ sandboxPath: `/workspace/output/${path}`, downloadUrl: url }] }];
}

function set_answer(session, id, path, url, content = 'STATUS: done') {
    session.state.co_agents[id] = { thread_id: `thread-${id}`, message_id: `message-${id}`, state: 'answered', relayed: null };
    session.answers.set(id, { answer: [{ content }], run: run_file(path, url) });
}

async function relay_one(options, id = 'minizilla_1', path = 'x.py', url = 'file-1', content = 'STATUS: done') {
    const { session, reads, uploads } = make_session(options);
    set_answer(session, id, path, url, content);
    const relay = await session._build_relay([id], [], [], false);
    return { ...relay, session, reads, uploads };
}

async function main() {
    const ten_old = Array.from({ length: 10 }, (_, index) => `l${index + 1}`).join('\n');
    const ten_new = ten_old.replace('l5', 'L5');
    assert.deepEqual(unified_diff(ten_old, ten_new), {
        text: '@@ -2,7 +2,7 @@\n l2\n l3\n l4\n-l5\n+L5\n l6\n l7\n l8',
        added: 1,
        deleted: 1,
    });
    assert.deepEqual(unified_diff('', 'a\nb\n'), { text: '@@ -0,0 +1,2 @@\n+a\n+b', added: 2, deleted: 0 });
    assert.deepEqual(unified_diff('a\r\nb\r\n', 'a\nb\n'), { text: '', added: 0, deleted: 0 });
    assert.deepEqual(unified_diff('same\n', 'same'), {
        text: '@@ -1,1 +1,1 @@\n-same\n+same\n\\ No newline at end of file', added: 1, deleted: 1,
    });
    assert.deepEqual(unified_diff('same', 'same\n'), {
        text: '@@ -1,1 +1,1 @@\n-same\n\\ No newline at end of file\n+same', added: 1, deleted: 1,
    });

    const thirty_old = Array.from({ length: 30 }, (_, index) => `l${index + 1}`);
    const thirty_new = [...thirty_old];
    thirty_new[1] = 'L2';
    thirty_new[19] = 'L20';
    const two_hunks = unified_diff(thirty_old.join('\n'), thirty_new.join('\n')).text;
    assert.equal((two_hunks.match(/^@@ /gm) || []).length, 2);

    const large_old = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`);
    const large_new = [...large_old];
    for (let index = 0; index < 50; index++) large_new[index * 97 + 20] = `changed ${index}`;
    const started = performance.now();
    assert.equal(unified_diff(large_old.join('\n'), large_new.join('\n')).added, 50);
    assert.ok(performance.now() - started < 1000, '5000-line diff with 50 changes should finish under 1000 ms');

    assert.deepEqual(plan_diffs([{ path: 'a', size: 100 }, { path: 'b', size: 50000 }], 'inline', 40), { inline: ['a'], attached: ['b'] });
    assert.deepEqual(plan_diffs([{ path: 'a', size: 100 }, { path: 'b', size: 200 }], 'inline', 40), { inline: ['a', 'b'], attached: [] });
    assert.deepEqual(plan_diffs([{ path: 'a', size: 100 }, { path: 'b', size: 200 }], 'attach', 40), { inline: [], attached: ['a', 'b'] });
    assert.deepEqual(plan_diffs([{ path: 'a', size: 100 }], 'off', 40), { inline: [], attached: [] });

    const first = await relay_one({ repo: { 'x.py': 'a\r\nb\r\nc\r\n' }, downloads: { 'file-1': 'a\nB\nc\n' } });
    assert.ok(first.content.includes('diffs:\n--- x.py (staged by minizilla_1, vs local repo, +1 -1)\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c'));

    set_answer(first.session, 'minizilla_2', 'x.py', 'file-2');
    first.session.client.download = async url => Buffer.from(url === 'file-2' ? 'a\nB\nC\n' : 'a\nB\nc\n');
    const correction = await first.session._build_relay(['minizilla_2'], [], [], false);
    assert.ok(correction.content.includes('--- x.py (staged by minizilla_2, delta to previous staged, +1 -1)'));
    assert.ok(correction.content.includes('-c\n+C'));
    assert.ok(!correction.content.includes('-b'));

    const same_worker = make_session({ repo: { 'x.py': 'repo\n' }, downloads: { original: 'old staged\n', revised: 'new staged\n' } });
    set_answer(same_worker.session, 'minizilla_1', 'x.py', 'original');
    await same_worker.session._stage_outputs('minizilla_1');
    await same_worker.session._execute({ action: 'send', target: 'minizilla_1', body: 'revise x.py' });
    set_answer(same_worker.session, 'minizilla_1', 'x.py', 'revised');
    const same_worker_correction = await same_worker.session._build_relay(['minizilla_1'], [], [], false);
    assert.ok(same_worker_correction.content.includes('delta to previous staged, +1 -1'));
    assert.ok(same_worker_correction.content.includes('-old staged\n+new staged'));

    const new_file = await relay_one({ downloads: { 'file-1': '1\n2\n' } }, 'minizilla_1', 'y.py');
    assert.ok(new_file.content.includes('--- y.py (staged by minizilla_1, new file, +2 -0)'));

    const suffix_copy = await relay_one({ repo: { 'x.py': 'repo version\n' }, downloads: { 'file-1': 'staged version\n' } }, 'minizilla_1', 'x-1.py');
    assert.ok(suffix_copy.content.includes('--- x.py (staged by minizilla_1, vs local repo, +1 -1)'));
    assert.ok(suffix_copy.content.includes('-repo version\n+staged version'));

    const after = make_session({ repo: { 'x.py': 'repo version\n' }, downloads: { worker: 'worker version\n', reviewer: 'reviewer version\n' } });
    set_answer(after.session, 'minizilla_1', 'x.py', 'worker');
    after.session.state.co_agents.minizilla_2 = {
        thread_id: null, message_id: null, state: 'waiting', relayed: null,
        pending_spawn: { body: 'Review x.py', dependencies: ['minizilla_1'], attachment_spawns: [], attachment_ids: {} },
    };
    assert.deepEqual(await after.session._advance_waiting_spawns(), []);
    assert.equal(after.session.state.co_agents.minizilla_2.state, 'working');
    set_answer(after.session, 'minizilla_2', 'x.py', 'reviewer');
    const after_reviewer = await after.session._build_relay(['minizilla_1', 'minizilla_2'], [], [], false);
    assert.ok(after_reviewer.content.includes('--- x.py (staged by minizilla_2, delta to previous staged, +1 -1)'));
    assert.ok(after_reviewer.content.includes('-worker version\n+reviewer version'));

    const large_diff = await relay_one({
        repo: { 'x.py': 'before\n' }, downloads: { 'file-1': 'after\n' }, limits: { relayDiffMaxKB: 0.05 },
    });
    assert.ok(large_diff.content.includes('diff for x.py attached (too large)'));
    assert.equal(large_diff.attachments.length, 1);
    assert.equal(large_diff.uploads[0].name, 'x.py.diff');
    assert.ok(large_diff.content.includes('- x.py.diff = x.py, staged by minizilla_1'));

    const attach_mode = await relay_one({ repo: { 'x.py': 'before\n' }, downloads: { 'file-1': 'after\n' }, limits: { relayDiff: 'attach' } });
    assert.ok(attach_mode.content.includes('diff for x.py attached'));
    assert.equal(attach_mode.attachments.length, 1);
    const off_mode = await relay_one({ repo: { 'x.py': 'before\n' }, downloads: { 'file-1': 'after\n' }, limits: { relayDiff: 'off' } });
    assert.ok(!off_mode.content.includes('diffs:'));
    assert.deepEqual(off_mode.reads, []);

    const binary_data = Buffer.from([0, 65, 66, 67]);
    const binary = await relay_one({ downloads: { 'file-1': binary_data } }, 'minizilla_1', 'img.png');
    assert.ok(binary.content.includes('binary img.png changed (4 bytes)'));
    assert.ok(!binary.content.includes('--- img.png'));

    const crlf = await relay_one({ repo: { 'x.py': 'a\nb\nc\n' }, downloads: { 'file-1': 'a\r\nB\r\nc\r\n' } });
    assert.ok(crlf.content.includes('warning: CRLF in x.py\ndiffs:'));

    const skipped = await relay_one({
        repo: { 'x.py': Array.from({ length: 10_001 }, (_, index) => `old ${index}`).join('\n') },
        downloads: { 'file-1': Array.from({ length: 10_000 }, (_, index) => `new ${index}`).join('\n') },
        limits: { relayDiff: 'attach' },
    });
    assert.ok(skipped.content.includes('diff for x.py skipped (more than 20000 lines)'));
    assert.equal(skipped.attachments.length, 0);

    const failed_upload = await relay_one({
        repo: { 'x.py': 'before\n' }, downloads: { 'file-1': 'after\n' }, limits: { relayDiff: 'attach' },
        upload: async () => { throw new Error('upload unavailable'); },
    });
    assert.ok(failed_upload.content.includes('diff for x.py not attached (upload unavailable)'));
    assert.equal(failed_upload.attachments.length, 0);

    const many_files = make_session({ limits: { relayDiff: 'attach' } });
    const many = Array.from({ length: 21 }, (_, index) => ({
        sandboxPath: `/workspace/output/file-${index}.txt`, downloadUrl: `url-${index}`,
    }));
    many_files.session.client.download = async url => Buffer.from(`content ${url.slice(4)}\n`);
    many_files.session.state.co_agents.minizilla_1 = { thread_id: 't1', message_id: 'm1', state: 'answered', relayed: null };
    many_files.session.answers.set('minizilla_1', { answer: [{ content: 'STATUS: done' }], run: [{ temporaryFiles: many }] });
    const capped = await many_files.session._build_relay(['minizilla_1'], [], [], false);
    assert.equal(capped.attachments.length, 20);
    assert.ok(capped.content.includes('diff for file-20.txt not attached (max. 20 attachments)'));

    const stuck_upload = make_session({
        repo: { 'x.py': 'before\n' }, downloads: { 'file-1': 'after\n' },
        limits: { relayDiff: 'attach' }, upload: () => new Promise(() => {}),
    });
    set_answer(stuck_upload.session, 'minizilla_1', 'x.py', 'file-1');
    stuck_upload.session.controller = new AbortController();
    const upload_pending = stuck_upload.session._build_relay(['minizilla_1'], [], [], false);
    await new Promise(resolve => setTimeout(resolve, 50));
    stuck_upload.session.stopping = true;
    stuck_upload.session.controller.abort();
    let upload_timeout;
    await assert.rejects(Promise.race([
        upload_pending,
        new Promise((_, reject) => { upload_timeout = setTimeout(() => reject(new Error('diff upload did not stop')), 1000); }),
    ]), StopRequested);
    clearTimeout(upload_timeout);

    const stuck = make_session({ downloads: { 'file-1': 'new\n' }, read: () => new Promise(() => {}) });
    set_answer(stuck.session, 'minizilla_1', 'x.py', 'file-1');
    stuck.session.controller = new AbortController();
    const pending = stuck.session._stage_outputs('minizilla_1', run_file('x.py', 'file-1'));
    await new Promise(resolve => setTimeout(resolve, 50));
    stuck.session.stopping = true;
    stuck.session.controller.abort();
    let timeout;
    await assert.rejects(Promise.race([
        pending,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('base read did not stop')), 1000); }),
    ]), StopRequested);
    clearTimeout(timeout);

    console.log('ok');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
