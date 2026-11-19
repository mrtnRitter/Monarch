'use strict';

const assert = require('node:assert/strict');
const { ChatSession, StopRequested, files_preamble } = require('../src/session');
const { has_crlf, is_text, suffix_copy, to_lf } = require('../src/files');

function make_session({ repo = {}, staged = {}, downloads = {}, eol = 'lf', limits = {}, exists, read, eol_default } = {}) {
    const download_map = new Map(Object.entries(downloads).map(([url, data]) => [url, Buffer.isBuffer(data) ? data : Buffer.from(data)]));
    let temporary_index = 0;
    const client = {
        download: async url => download_map.get(url),
        upload_temporary_file: async () => `tmp-${++temporary_index}`,
    };
    const workspace = {
        read: read || (async path => {
            if (!Object.hasOwn(repo, path)) throw new Error('not found');
            return Buffer.from(repo[path]);
        }),
        exists: exists || (async path => Object.hasOwn(repo, path)),
        eol_default: eol_default || (async () => eol),
    };
    const store = { load: () => ({ staged }), save() {} };
    const ui = { message() {}, status() {} };
    const agent = { name: 'A', agentId: 'a', coAgentId: 'c', coAgentName: 'minizilla' };
    return new ChatSession({ client, agent, limits, store, workspace, ui });
}

function run_file(path, url) {
    return [{ temporaryFiles: [{ sandboxPath: `/workspace/output/${path}`, downloadUrl: url }] }];
}

async function main() {
    assert.equal(files_preamble, '[monarch files] Liefere jede Datei vollständig unter /workspace/output/<repo-pfad>, mit LF-Zeilenenden. Vorhandene Dateien dort überschreibst Du unter demselben Pfad. Keine Kopien mit Suffix (-1, -2, …).');
    assert.deepEqual(suffix_copy('tests/test_run-1.py'), { base: 'tests/test_run.py', n: 1 });
    for (const path of ['foo.py', 'foo-0.py', 'notes-1', 'monarch-0.21.1.vsix']) assert.equal(suffix_copy(path), null);
    assert.equal(is_text('hello'), true);
    assert.equal(is_text(Buffer.from([0, 65])), false);
    assert.equal(is_text(Buffer.from([0xc3, 0x28])), false);
    assert.equal(has_crlf(Buffer.from('a\r\nb')), true);
    assert.deepEqual(to_lf(Buffer.from('a\r\nb\rc')), Buffer.from('a\nb\rc'));

    const mapped = make_session({ repo: { 'tests/test_run.py': 'repo' }, downloads: { u1: 'agent' } });
    const mapped_output = await mapped._stage_outputs('co1', run_file('tests/test_run-1.py', 'u1'));
    assert.equal(mapped.state.staged['tests/test_run.py'].url, 'u1');
    assert.equal(Object.hasOwn(mapped.state.staged, 'tests/test_run-1.py'), false);
    assert.deepEqual(mapped_output.warnings, ['tests/test_run-1.py mapped to tests/test_run.py']);
    assert.equal(mapped_output.files[0].path, 'tests/test_run.py');

    const unpaired = make_session({ downloads: { u1: 'agent' } });
    const unpaired_output = await unpaired._stage_outputs('co1', run_file('foo-1.py', 'u1'));
    assert.equal(unpaired.state.staged['foo-1.py'].url, 'u1');
    assert.equal(unpaired_output.warnings.some(warning => warning.includes('mapped to')), false);

    const highest = make_session({ repo: { 'a.py': 'repo' }, downloads: { u1: 'old', u2: 'new' } });
    const highest_output = await highest._stage_outputs('co1', [{ temporaryFiles: [
        { sandboxPath: '/workspace/output/a-1.py', downloadUrl: 'u1' },
        { sandboxPath: '/workspace/output/a-2.py', downloadUrl: 'u2' },
    ] }]);
    assert.equal(highest.state.staged['a.py'].url, 'u2');
    assert.deepEqual(highest_output.warnings, ['a-1.py ignored (a-2.py mapped to a.py)', 'a-2.py mapped to a.py']);
    assert.deepEqual(highest_output.files.map(file => file.path), ['a.py']);

    const warning_order = make_session({ repo: { 'q.py': 'repo\n' }, downloads: { u1: 'q\r\n', u2: 'y\r\n' }, eol: 'lf' });
    const ordered_output = await warning_order._stage_outputs('co1', [{ temporaryFiles: [
        { sandboxPath: '/workspace/output/q-1.py', downloadUrl: 'u1' },
        { sandboxPath: '/workspace/output/y.py', downloadUrl: 'u2' },
    ] }]);
    assert.deepEqual(ordered_output.warnings, ['q-1.py mapped to q.py', 'CRLF in q.py', 'CRLF in y.py']);

    const already_staged = make_session({ staged: { 'b.py': { from: 'old', url: 'old-url' } }, downloads: { u1: 'new' } });
    const staged_output = await already_staged._stage_outputs('co1', run_file('b-1.py', 'u1'));
    assert.equal(already_staged.state.staged['b.py'].url, 'u1');
    assert.equal(staged_output.files[0].path, 'b.py');

    const suffix_disabled = make_session({ repo: { 'c.py': 'repo' }, downloads: { u1: 'agent' }, limits: { normalizeSuffixCopies: false } });
    const disabled_output = await suffix_disabled._stage_outputs('co1', run_file('c-1.py', 'u1'));
    assert.equal(suffix_disabled.state.staged['c-1.py'].url, 'u1');
    assert.equal(disabled_output.warnings.some(warning => warning.includes('mapped to')), false);

    const crlf_data = Buffer.from('first\r\nsecond\r\n');
    const crlf_warn = make_session({ repo: { 'x.py': 'first\nsecond\n' }, downloads: { u1: crlf_data } });
    const crlf_warn_output = await crlf_warn._stage_outputs('co1', run_file('x.py', 'u1'));
    assert.deepEqual(crlf_warn_output.warnings, ['CRLF in x.py']);
    assert.deepEqual(crlf_warn.staged_data.get('x.py'), crlf_data);

    const crlf_convert = make_session({ repo: { 'x.py': 'first\nsecond\n' }, downloads: { u1: crlf_data }, limits: { normalizeLineEndings: true } });
    const crlf_convert_output = await crlf_convert._stage_outputs('co1', run_file('x.py', 'u1'));
    assert.deepEqual(crlf_convert_output.warnings, ['CRLF in x.py (converted to LF)']);
    assert.deepEqual(crlf_convert.staged_data.get('x.py'), Buffer.from('first\nsecond\n'));
    assert.equal(crlf_convert.state.staged['x.py'].lf, true);
    crlf_convert.staged_data.clear();
    assert.deepEqual(await crlf_convert._staged_file('x.py'), Buffer.from('first\nsecond\n'));

    const new_lf = make_session({ downloads: { u1: crlf_data }, eol: 'lf' });
    assert.deepEqual((await new_lf._stage_outputs('co1', run_file('new.py', 'u1'))).warnings, ['CRLF in new.py']);
    const new_crlf = make_session({ downloads: { u1: crlf_data }, eol: 'crlf' });
    assert.deepEqual((await new_crlf._stage_outputs('co1', run_file('new.py', 'u1'))).warnings, []);
    const eol_error = make_session({ downloads: { u1: crlf_data }, read: async () => { throw new Error('not found'); }, eol_default: async () => { throw new Error('unknown default'); } });
    assert.deepEqual((await eol_error._stage_outputs('co1', run_file('new.py', 'u1'))).warnings, []);
    let eol_calls = 0;
    const eol_once = make_session({ downloads: { u1: crlf_data, u2: crlf_data }, read: async () => { throw new Error('not found'); }, eol_default: async () => { eol_calls += 1; return 'lf'; } });
    await eol_once._stage_outputs('co1', [{ temporaryFiles: [
        { sandboxPath: '/workspace/output/one.py', downloadUrl: 'u1' },
        { sandboxPath: '/workspace/output/two.py', downloadUrl: 'u2' },
    ] }]);
    assert.equal(eol_calls, 1);
    const legacy_workspace = make_session({ downloads: { u1: crlf_data }, read: async () => { throw new Error('not found'); } });
    delete legacy_workspace.workspace.eol_default;
    assert.deepEqual((await legacy_workspace._stage_outputs('co1', run_file('new.py', 'u1'))).warnings, []);
    const repo_crlf = make_session({ repo: { 'x.py': crlf_data }, downloads: { u1: crlf_data } });
    assert.deepEqual((await repo_crlf._stage_outputs('co1', run_file('x.py', 'u1'))).warnings, []);
    const binary = make_session({ repo: { 'bin.dat': 'text' }, downloads: { u1: Buffer.from([0, 13, 10, 65]) } });
    assert.deepEqual((await binary._stage_outputs('co1', run_file('bin.dat', 'u1'))).warnings, []);

    const brief = make_session({ staged: { 'a.py': { from: 'co1', url: 'u1' } }, downloads: { u1: 'file' } });
    const with_attachment = await brief._brief('Do X\nATTACH: a.py');
    assert.ok(with_attachment.content.startsWith(`${files_preamble}\n\n`));
    assert.equal(with_attachment.title, 'Do X');
    assert.equal(with_attachment.attachments.length, 1);
    const plain = await brief._brief('Nur Text');
    assert.ok(plain.content.startsWith(`${files_preamble}\n\n`));
    let created_title;
    brief.client.create_thread = async (co_agent_id, content, title) => {
        assert.ok(content.startsWith(`${files_preamble}\n\n`));
        created_title = title;
        return { id: 'thread-1' };
    };
    brief._accepted_id = async () => 'message-1';
    await brief._execute({ action: 'spawn', body: 'Do X\nATTACH: a.py' });
    assert.equal(created_title, 'minizilla_1 – Do X');
    brief.state.co_agents.minizilla_2 = {};
    await brief._launch_spawn('minizilla_2', { body: 'Next task' });
    assert.equal(created_title, 'minizilla_2 – Next task');

    const errors_are_absent = make_session({ downloads: { u1: 'agent' }, exists: async () => { throw new Error('no workspace entry'); } });
    const exists_error_output = await errors_are_absent._stage_outputs('co1', run_file('z-1.py', 'u1'));
    assert.equal(errors_are_absent.state.staged['z-1.py'].url, 'u1');
    assert.deepEqual(exists_error_output.warnings, []);
    const legacy_exists = make_session({ downloads: { u1: 'agent' } });
    delete legacy_exists.workspace.exists;
    const legacy_exists_output = await legacy_exists._stage_outputs('co1', run_file('z-1.py', 'u1'));
    assert.equal(legacy_exists.state.staged['z-1.py'].url, 'u1');
    assert.deepEqual(legacy_exists_output.warnings, []);

    const stalled = make_session({ downloads: { u1: 'agent' }, exists: () => new Promise(() => {}) });
    stalled.controller = new AbortController();
    const pending = stalled._stage_outputs('co1', run_file('z-1.py', 'u1'));
    await new Promise(resolve => setTimeout(resolve, 50));
    stalled.stopping = true;
    stalled.controller.abort();
    let timeout;
    await assert.rejects(Promise.race([
        pending,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('staging did not stop')), 1000); }),
    ]), StopRequested);
    clearTimeout(timeout);

    console.log('ok');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
