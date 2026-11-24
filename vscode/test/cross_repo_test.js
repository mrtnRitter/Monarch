'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { ChatSession, StopRequested } = require('../src/session');
const { snapshot_label } = require('../src/snapshot');

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

function make_session({ staged = {}, other, limits = {} } = {}) {
    const uploads = [];
    let download_calls = 0;
    const client = {
        upload_temporary_file: async (name, data, mime, options) => {
            uploads.push({ name, data: Buffer.from(data), mime, options });
            return `upload-${uploads.length}`;
        },
        download: async () => { download_calls++; throw new Error('unexpected download'); },
    };
    const workspace = {
        read: async () => { throw new Error('not in local repo'); },
        other: other || (() => null),
    };
    const session = new ChatSession({
        client, agent: { name: 'A', agentId: 'a', coAgentId: 'c', coAgentName: 'minizilla' },
        store: { load: () => ({ staged }), save() {} }, workspace, limits, ui: { message() {}, status() {} },
    });
    return { session, uploads, get download_calls() { return download_calls; } };
}

function repo_b() {
    return {
        name: 'B',
        read: async path => {
            if (path !== 'api.py') throw new Error('not found');
            return Buffer.from('B:api.py');
        },
        repo_state: async () => ({
            files: [{ path: 'api.py', size: 8 }], branch: 'main', head: 'abcdef1234', changed: [], deleted: [],
        }),
    };
}

async function main() {
    const readable = make_session({ other: name => name === 'B' ? repo_b() : null });
    const brief = await readable.session._brief('Do it\nATTACH: read:B:api.py');
    assert.equal(readable.uploads.length, 1);
    assert.equal(readable.uploads[0].name, 'api.py');
    assert.equal(readable.uploads[0].data.toString(), 'B:api.py');
    assert.ok(brief.content.includes('Attached files from other repos (read only): B:api.py'));

    const unopened = make_session({ other: name => name === 'B' ? repo_b() : null });
    await assert.rejects(unopened.session._brief('x\nATTACH: read:X:api.py'), /repo X not open in this VS Code window/);

    const unsafe = make_session({ other: name => name === 'B' ? repo_b() : null });
    await assert.rejects(unsafe.session._brief('x\nATTACH: read:B:..\/x'), /unsafe attachment path read:B:\.\.\/x/);

    const snapshot = make_session({
        staged: { 'api.py': { from: 'minizilla_1', url: 'u' } },
        other: name => name === 'B' ? repo_b() : null,
    });
    const snapshot_brief = await snapshot.session._brief('x\nATTACH: repo-snapshot:B');
    assert.equal(snapshot.uploads.length, 1);
    assert.equal(snapshot.uploads[0].name, 'repo-snapshot-B.zip');
    const archive = read_zip(snapshot.uploads[0].data);
    assert.equal(archive.get('api.py').toString(), 'B:api.py');
    assert.ok(archive.get('SNAPSHOT.md').toString().includes('## staged files (overlaid)\n- none'));
    assert.ok(snapshot_brief.content.includes('Attached repo snapshot: repo-snapshot-B.zip = main@abcdef1 + 0 staged'));
    assert.equal(snapshot.download_calls, 0);

    const filtered_snapshot = make_session({ other: name => name === 'B' ? {
        name: 'B',
        read: async path => {
            if (path !== 'api.py') throw new Error('not found');
            return Buffer.from('B:api.py');
        },
        repo_state: async () => ({
            files: [{ path: 'api.py', size: 8 }, { path: '__pycache__/x.pyc', size: 3 }],
            branch: 'main', head: 'abcdef1234', changed: [], deleted: [],
        }),
    } : null });
    await filtered_snapshot.session._brief('x\nATTACH: repo-snapshot:B');
    const filtered_archive = read_zip(filtered_snapshot.uploads[0].data);
    assert.ok(filtered_archive.has('api.py'));
    assert.ok(!filtered_archive.has('__pycache__/x.pyc'));

    const mixed_over_limit = make_session({
        staged: Object.fromEntries(Array.from({ length: 19 }, (_, index) => [`local-${index}.txt`, { from: 'co', url: 'u' }])),
        other: name => name === 'B' ? repo_b() : null,
    });
    const over_limit_body = [
        'x',
        ...Array.from({ length: 19 }, (_, index) => `ATTACH: local-${index}.txt`),
        'ATTACH: read:B:api.py',
        'ATTACH: repo-snapshot:B',
    ].join('\n');
    await assert.rejects(mixed_over_limit.session._brief(over_limit_body), /max\. 20 files per message/);
    assert.equal(mixed_over_limit.uploads.length, 0);

    const stopped_read = make_session({ other: () => ({ read: async () => { throw new StopRequested(); } }) });
    await assert.rejects(stopped_read.session._brief('x\nATTACH: read:B:api.py'), error => error instanceof StopRequested);

    const stopped_snapshot = make_session({ other: () => ({
        repo_state: async () => ({ files: [{ path: 'api.py', size: 1 }], branch: 'main', head: 'a', changed: [], deleted: [] }),
        read: async () => { throw new StopRequested(); },
    }) });
    await assert.rejects(stopped_snapshot.session._brief('x\nATTACH: repo-snapshot:B'), error => error instanceof StopRequested);

    const inspect = make_session({ other: name => name === 'B' ? repo_b() : null });
    const inspected = await inspect.session._inspect('ATTACH: read:B:api.py');
    assert.equal(inspected.files[0].path, 'B:api.py');
    assert.equal(inspected.files[0].source, 'repo B (local)');

    const inspect_missing = make_session({ other: name => name === 'B' ? repo_b() : null });
    const missing = await inspect_missing.session._inspect('ATTACH: read:X:api.py\nATTACH: repo-snapshot:B');
    assert.ok(missing.missing.some(item => item.includes('read:X:api.py')));
    assert.ok(missing.missing.includes('repo-snapshot:B (not available in inspect)'));

    assert.equal(snapshot_label({ branch: 'main', head: 'abcdef1234', staged_count: 2 }), 'repo-snapshot.zip = main@abcdef1 + 2 staged');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
