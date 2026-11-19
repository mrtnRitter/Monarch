'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { ChatSession, StopRequested } = require('../src/session');
const { snapshot_label, largest_dirs, snapshot_md } = require('../src/snapshot');

function read_zip(data) {
    const entries = new Map();
    let offset = 0;
    while (offset + 4 <= data.length && data.readUInt32LE(offset) === 0x04034b50) {
        const method = data.readUInt16LE(offset + 8);
        const compressed_size = data.readUInt32LE(offset + 18);
        const name_size = data.readUInt16LE(offset + 26);
        const extra_size = data.readUInt16LE(offset + 28);
        const name_start = offset + 30;
        const name = data.subarray(name_start, name_start + name_size).toString('utf8');
        const body_start = name_start + name_size + extra_size;
        const body = data.subarray(body_start, body_start + compressed_size);
        assert.ok(method === 0 || method === 8, `unexpected ZIP method ${method}`);
        entries.set(name, method === 8 ? zlib.inflateRawSync(body) : body);
        offset = body_start + compressed_size;
    }
    return entries;
}

function make_session({ repo_state, repo = {}, staged = {}, staged_data = {}, limits = {}, read, upload, create_thread, send_message } = {}) {
    let upload_count = 0;
    const uploads = [];
    const client = {
        upload_temporary_file: async (name, data, mime, options) => {
            upload_count += 1;
            uploads.push({ name, data: Buffer.from(data), mime, options });
            return upload ? upload(name, data, mime, options) : `upload-${upload_count}`;
        },
        create_thread: async (...args) => create_thread ? create_thread(...args) : { id: 'thread-one' },
        send_message: async (...args) => send_message ? send_message(...args) : { acceptedMessageId: 'message-sent' },
        download: async () => { throw new Error('unexpected download'); },
    };
    const workspace = { read: read || (async path => {
        if (!Object.hasOwn(repo, path)) throw new Error('not found');
        return Buffer.from(repo[path]);
    }) };
    if (repo_state) workspace.repo_state = repo_state;
    const session = new ChatSession({
        client, agent: { name: 'A', agentId: 'a', coAgentId: 'c', coAgentName: 'minizilla' }, limits,
        store: { load: () => ({ staged }), save() {} }, workspace, ui: { message() {}, status() {} },
    });
    for (const [path, data] of Object.entries(staged_data)) session.staged_data.set(path, Buffer.from(data));
    session._accepted_id = async () => 'message-1';
    return { session, uploads, get upload_count() { return upload_count; } };
}

function make_repo_state(files = [], extras = {}) {
    return async () => ({ branch: 'main', head: 'abcdef1234567', files, changed: [], deleted: [], ...extras });
}

async function assert_stops_during(session, operation, started) {
    session.controller = new AbortController();
    const pending = operation();
    await started;
    session.stopping = true;
    session.controller.abort();
    let timeout;
    await assert.rejects(Promise.race([
        pending,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('snapshot did not stop')), 1000); }),
    ]), StopRequested);
    clearTimeout(timeout);
}

async function assert_failed_snapshot_does_not_block_following_command(options, expected) {
    let create_calls = 0;
    const { session } = make_session({ ...options, create_thread: async () => { create_calls += 1; return { id: 'unexpected' }; } });
    const lines = [];
    session._info = line => lines.push(line);
    await session._handle_answer({
        answer: [{ content: '### ORCA: spawn\nTask\nATTACH: repo-snapshot\n### ORCA: notes\ncontinued' }],
        run: [], state: 'completed', duration_ms: 0, thread_id: 'thread', baseline: null,
    });
    assert.ok(lines.some(line => line.includes(expected)), lines.join('\n'));
    assert.ok(lines.some(line => line.includes('ok: notes: updated')), lines.join('\n'));
    assert.equal(session.state.notes, 'continued');
    assert.equal(session.state.next_index, 1);
    assert.equal(create_calls, 0);
}

async function main() {
    assert.equal(snapshot_label({ branch: 'main', head: 'abcdef1234567', staged_count: 1 }), 'repo-snapshot.zip = main@abcdef1 + 1 staged');
    assert.equal(snapshot_label({ branch: 'main', staged_count: 0 }), 'repo-snapshot.zip = main@none + 0 staged');
    assert.equal(snapshot_label({ head: 'abcdef1234567', staged_count: 0 }), 'repo-snapshot.zip = HEAD@abcdef1 + 0 staged');

    assert.deepEqual(largest_dirs([
        { path: 'root.txt', size: 100 }, { path: 'a/x', size: 80 }, { path: 'b/x', size: 60 },
        { path: 'c/x', size: 40 }, { path: 'd/x', size: 20 }, { path: 'e/x', size: 10 },
        { path: 'f/x', size: 5 }, { path: 'g/x', size: 1 },
    ]), [
        { dir: '.', size: 100 }, { dir: 'a', size: 80 }, { dir: 'b', size: 60 },
        { dir: 'c', size: 40 }, { dir: 'd', size: 20 },
    ]);

    assert.equal(snapshot_md({ branch: 'main', head: 'abcdef1234567', changed: ['a.txt'], staged: [{ path: 'src/b.js', from: 'minizilla_1' }] }),
        '# repo snapshot\n\n- branch: main\n- HEAD: abcdef1234567\n\n## locally changed files\n- a.txt\n\n## staged files (overlaid)\n- src/b.js (staged by minizilla_1)\n');
    assert.equal(snapshot_md({ branch: null, head: null, changed: [], staged: [], deleted: ['old.txt'] }),
        '# repo snapshot\n\n- branch: HEAD\n- HEAD: none\n\n## locally changed files\n- none\n\n## staged files (overlaid)\n- none\n\n## deleted files (nicht enthalten)\n- old.txt\n');

    const main_repo = make_session({
        repo_state: make_repo_state([{ path: 'a.txt', size: 3 }, { path: 'src/b.js', size: 5 }], { changed: ['a.txt'], deleted: ['old.txt'] }),
        repo: { 'a.txt': 'abc', 'src/b.js': 'REPO!' },
        staged: { 'src/b.js': { from: 'minizilla_1', url: 'unused' } }, staged_data: { 'src/b.js': 'STAGED' },
    });
    const brief = await main_repo.session._brief('Task\nATTACH: repo-snapshot');
    assert.equal(main_repo.upload_count, 1);
    assert.equal(main_repo.uploads[0].name, 'repo-snapshot.zip');
    assert.equal(main_repo.uploads[0].mime, 'application/zip');

    const umlaut_repo = make_session({
        repo_state: make_repo_state([{ path: 'größe/überblick.txt', size: 5 }]),
        repo: { 'größe/überblick.txt': 'Größe' },
    });
    const umlaut_brief = await umlaut_repo.session._brief('Task\nATTACH: repo-snapshot');
    const umlaut_zip_path = '/tmp/monarch-snapshot-umlaut-test.zip';
    fs.writeFileSync(umlaut_zip_path, umlaut_repo.uploads[0].data);
    assert.ok(read_zip(umlaut_repo.uploads[0].data).has('größe/überblick.txt'));
    const archive = read_zip(main_repo.uploads[0].data);
    assert.deepEqual([...archive.keys()], ['a.txt', 'src/b.js', 'SNAPSHOT.md']);
    assert.equal(archive.get('a.txt').toString(), 'abc');
    assert.equal(archive.get('src/b.js').toString(), 'STAGED');
    const manifest = archive.get('SNAPSHOT.md').toString();
    for (const text of ['- branch: main', '- HEAD: abcdef1234567', '- src/b.js (staged by minizilla_1)', '## deleted files (nicht enthalten)', '- old.txt']) assert.ok(manifest.includes(text), text);
    assert.ok(brief.content.includes('Attached repo snapshot: repo-snapshot.zip = main@abcdef1 + 1 staged'));
    assert.ok(!brief.content.includes('Attached files (relative to repo root):'));

    const casefolded_snapshot = make_session({ repo_state: make_repo_state([]) });
    await casefolded_snapshot.session._brief('Task\nATTACH: RePo-SnApShOt');
    assert.equal(casefolded_snapshot.upload_count, 1);

    const unlimited_snapshot = make_session({
        repo_state: make_repo_state([{ path: 'large.bin', size: 21 * 1024 * 1024 }]),
        read: async () => Buffer.from('small'), limits: { maxSnapshotMB: 0 },
    });
    await unlimited_snapshot.session._brief('Task\nATTACH: repo-snapshot');
    assert.equal(unlimited_snapshot.upload_count, 1);

    let read_calls = 0;
    let create_calls = 0;
    const oversized = make_session({
        repo_state: make_repo_state([{ path: 'big/x.bin', size: 2 * 1024 * 1024 }]), limits: { maxSnapshotMB: 1 },
        read: async () => { read_calls += 1; return Buffer.alloc(2 * 1024 * 1024); },
        create_thread: async () => { create_calls += 1; return { id: 'never' }; },
    });
    const refused = await oversized.session._execute({ action: 'spawn', body: 'Task\nATTACH: repo-snapshot' });
    assert.equal(refused.ok, false);
    assert.ok(refused.line.includes('maxSnapshotMB'));
    assert.ok(refused.line.includes('big (2.0 MB)'));
    assert.equal(create_calls, 0);
    assert.equal(read_calls, 0);
    assert.equal(oversized.session.state.next_index, 1);

    await assert_failed_snapshot_does_not_block_following_command({
        repo_state: make_repo_state([{ path: 'big/x.bin', size: 2 * 1024 * 1024 }]), limits: { maxSnapshotMB: 1 },
        read: async () => { throw new Error('should not read oversized repo files'); },
    }, 'maxSnapshotMB');
    await assert_failed_snapshot_does_not_block_following_command({
        repo_state: make_repo_state([{ path: 'broken.txt', size: 3 }]),
        read: async () => { throw new Error('disk read failed'); },
    }, 'broken.txt not readable');
    await assert_failed_snapshot_does_not_block_following_command({}, 'no folder open');

    const spawn_calls = [];
    const autosnapshot = make_session({ repo_state: make_repo_state([]), limits: { autoSnapshot: 'spawn' }, create_thread: async (...args) => {
        spawn_calls.push(args);
        return { id: 'thread-one' };
    } });
    const spawned = await autosnapshot.session._execute({ action: 'spawn', body: 'Task\nATTACH: repo-snapshot' });
    assert.equal(spawned.ok, true);
    assert.equal(autosnapshot.upload_count, 1);
    assert.equal(autosnapshot.uploads[0].name, 'repo-snapshot.zip');
    assert.equal(spawn_calls.length, 1);
    assert.equal(spawn_calls[0][3].length, 1);
    assert.equal(spawned.line, 'spawn minizilla_1 (repo-snapshot.zip = main@abcdef1 + 0 staged)');
    assert.equal(autosnapshot.session.state.co_agents.minizilla_1.snapshot, 'repo-snapshot.zip = main@abcdef1 + 0 staged');

    autosnapshot.session.state.co_agents.minizilla_2 = { state: 'waiting' };
    await autosnapshot.session._launch_spawn('minizilla_2', { body: 'Deferred task' });
    assert.equal(autosnapshot.session.state.co_agents.minizilla_2.snapshot, 'repo-snapshot.zip = main@abcdef1 + 0 staged');
    assert.equal(autosnapshot.upload_count, 2);
    assert.equal(spawn_calls[1][3].length, 1);

    const delayed = make_session({
        repo_state: make_repo_state([{ path: 'base.txt', size: 4 }, { path: 'from-one.txt', size: 4 }]),
        repo: { 'base.txt': 'base', 'from-one.txt': 'repo' },
        limits: { autoSnapshot: 'spawn' },
        create_thread: async (...args) => { spawn_calls.push(args); return { id: 'delayed-thread' }; },
    });
    delayed.session.state.next_index = 4;
    delayed.session.state.co_agents.minizilla_1 = { state: 'answered' };
    delayed.session.state.co_agents.minizilla_3 = { state: 'answered' };
    delayed.session.state.staged['one.txt'] = { from: 'minizilla_1', url: 'unused-one' };
    delayed.session.state.staged['three.txt'] = { from: 'minizilla_3', url: 'unused-three' };
    delayed.session.staged_data.set('three.txt', Buffer.from('three'));
    delayed.session._stage_outputs = async id => {
        if (id === 'minizilla_1') {
            delayed.session.state.staged['one.txt'] = { from: id, url: 'unused-one' };
            delayed.session.staged_data.set('one.txt', Buffer.from('one!'));
        }
        return { files: [], warnings: [] };
    };
    delayed.session._is_urgent = async () => false;
    const deferred_context = { count: 1, ids: new Map([[1, 'minizilla_1']]) };
    const deferred_result = await delayed.session._execute({
        action: 'spawn', spawn_index: 2, spawn_context: deferred_context,
        body: 'Deferred task\nAFTER: minizilla_1\nATTACH: spawn_1\nATTACH: minizilla_3',
    });
    assert.equal(deferred_result.ok, true);
    delayed.session._resolve_spawn_refs([deferred_result], deferred_context);
    const deferred_launch = await delayed.session._advance_waiting_spawns();
    assert.deepEqual(deferred_launch, []);
    const started = delayed.session.state.co_agents.minizilla_4;
    assert.equal(started.state, 'working');
    assert.equal(started.snapshot, 'repo-snapshot.zip = main@abcdef1 + 2 staged');
    const delayed_call = spawn_calls.at(-1);
    assert.equal(delayed_call[3].length, 3);
    assert.ok(delayed_call[1].includes('Attached repo snapshot: repo-snapshot.zip = main@abcdef1 + 2 staged'));
    const delayed_archive = read_zip(delayed.uploads.at(-1).data);
    assert.equal(delayed_archive.get('one.txt').toString(), 'one!');
    assert.equal(delayed_archive.get('three.txt').toString(), 'three');

    let sent;
    const sending = make_session({ repo_state: make_repo_state([]), send_message: async (...args) => { sent = args; return { acceptedMessageId: 'sent-1' }; } });
    sending.session.state.co_agents.minizilla_1 = { thread_id: 'thread-1', message_id: 'old-message', state: 'answered' };
    const send_result = await sending.session._execute({ action: 'send', target: 'minizilla_1', body: 'Follow up\nATTACH: repo-snapshot' });
    assert.equal(send_result.line, 'send minizilla_1 (repo-snapshot.zip = main@abcdef1 + 0 staged)');
    assert.equal(sent[2].length, 1);
    assert.equal(sending.session.state.co_agents.minizilla_1.snapshot, 'repo-snapshot.zip = main@abcdef1 + 0 staged');

    const off = make_session({ repo_state: make_repo_state([]), limits: { autoSnapshot: 'off' } });
    const off_spawn = await off.session._execute({ action: 'spawn', body: 'Task' });
    assert.equal(off_spawn.ok, true);
    assert.equal(off.upload_count, 0);
    assert.equal(off_spawn.line, 'spawn minizilla_1');

    const inspect = await make_session().session._inspect('ATTACH: repo-snapshot');
    assert.ok(inspect.missing.includes('repo-snapshot (not available in inspect)'));

    const twenty = Array.from({ length: 20 }, (_, index) => `ATTACH: file-${index}.txt`).join('\n') + '\nATTACH: repo-snapshot';
    await assert.rejects(make_session().session._brief(twenty), /max\. 20 files per message/);

    let repo_state_started;
    const repo_state_waiting = new Promise(resolve => { repo_state_started = resolve; });
    const stopping_repo = make_session({ repo_state: () => { repo_state_started(); return new Promise(() => {}); } }).session;
    await assert_stops_during(stopping_repo, () => stopping_repo._brief('T\nATTACH: repo-snapshot'), repo_state_waiting);

    let read_started;
    const read_waiting = new Promise(resolve => { read_started = resolve; });
    const stopping_read = make_session({
        repo_state: make_repo_state([{ path: 'slow.txt', size: 4 }]),
        read: () => { read_started(); return new Promise(() => {}); },
    }).session;
    await assert_stops_during(stopping_read, () => stopping_read._brief('T\nATTACH: repo-snapshot'), read_waiting);

    let upload_started;
    const upload_waiting = new Promise(resolve => { upload_started = resolve; });
    const stopping_upload = make_session({
        repo_state: make_repo_state([]),
        upload: () => { upload_started(); return new Promise(() => {}); },
    }).session;
    await assert_stops_during(stopping_upload, () => stopping_upload._brief('T\nATTACH: repo-snapshot'), upload_waiting);

    const forwarding = make_session().session;
    const co_agent = forwarding.state.co_agents.minizilla_1 = { state: 'answered', message_id: 'message-1', snapshot: 'repo-snapshot.zip = main@abcdef1 + 0 staged' };
    forwarding._answer_for = async () => ({ answer: [{ content: 'answer' }], run: [] });
    forwarding._stage_outputs = async () => ({ files: [], warnings: [] });
    const first_forward = await forwarding._forward('minizilla_1');
    assert.equal(first_forward.split('\n')[0], '## minizilla_1 (answered)');
    assert.equal(first_forward.split('\n')[1], 'repo-snapshot: repo-snapshot.zip = main@abcdef1 + 0 staged');
    assert.equal(Object.hasOwn(co_agent, 'snapshot'), false);
    const second_forward = await forwarding._forward('minizilla_1');
    assert.ok(!second_forward.includes('repo-snapshot:'));

    console.log('ok');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
