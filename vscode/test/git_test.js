'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { run_git, eol_default, repo_state, repo_info } = require('../src/git');

const exec_file = promisify(execFile);
const git_timeout_ms = 5000;

async function git(cwd, args) {
    const { stdout } = await exec_file('git', args, { cwd, encoding: 'utf8', timeout: git_timeout_ms, windowsHide: true });
    return stdout;
}

async function write_file(root, relative_path, content) {
    const file_path = path.join(root, relative_path);
    await fs.mkdir(path.dirname(file_path), { recursive: true });
    await fs.writeFile(file_path, content);
}

async function main() {
    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), 'monarch-git-test-'));
    assert.ok(temp_root.startsWith(os.tmpdir()));
    const repo_dir = path.join(temp_root, 'repo');
    await fs.mkdir(repo_dir);
    try {
        const repo_info_empty = path.join(temp_root, 'repo-info-empty');
        await fs.mkdir(repo_info_empty);
        assert.deepEqual(await repo_info(repo_info_empty), { git: false });
        assert.deepEqual(await repo_info(path.join(temp_root, 'missing-repo')), { git: null });

        const info_repo = path.join(temp_root, 'info-repo');
        await fs.mkdir(info_repo);
        await git(info_repo, ['init', '-q', '-b', 'main']);
        await write_file(info_repo, 'info.txt', 'initial\n');
        await git(info_repo, ['add', 'info.txt']);
        await git(info_repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'initial']);
        assert.deepEqual(await repo_info(info_repo), { git: true, remote: null, branch: 'main', changes: 0, ahead: null });

        const remote_dir = path.join(temp_root, 'remote.git');
        await git(temp_root, ['init', '--bare', '-q', remote_dir]);
        await git(info_repo, ['remote', 'add', 'origin', remote_dir]);
        await git(info_repo, ['push', '-q', '-u', 'origin', 'main']);
        assert.deepEqual(await repo_info(info_repo), { git: true, remote: remote_dir, branch: 'main', changes: 0, ahead: 0 });

        const nested_remote_dir = path.join(temp_root, 'nested-remote.git');
        await git(temp_root, ['init', '--bare', '-q', nested_remote_dir]);
        await git(info_repo, ['remote', 'add', 'team/repo', nested_remote_dir]);
        await git(info_repo, ['push', '-q', 'team/repo', 'main']);
        await git(info_repo, ['branch', '--set-upstream-to=team/repo/main', 'main']);
        const nested_remote_info = await repo_info(info_repo);
        assert.equal(nested_remote_info.remote, nested_remote_dir);
        assert.equal(nested_remote_info.ahead, 0);

        await write_file(info_repo, 'second.txt', 'second\n');
        await git(info_repo, ['add', 'second.txt']);
        await git(info_repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'second']);
        assert.equal((await repo_info(info_repo)).ahead, 1);
        await write_file(info_repo, 'info.txt', 'modified\n');
        assert.equal((await repo_info(info_repo)).changes, 1);

        const aborted_info = new AbortController();
        aborted_info.abort();
        await assert.rejects(repo_info(info_repo, { signal: aborted_info.signal }), error => error.name === 'AbortError');

        await git(repo_dir, ['init', '-q']);
        await write_file(repo_dir, '.gitignore', '.venv/\nnode_modules/\n.data/\n');
        await write_file(repo_dir, 'a.txt', 'initial\n');
        await write_file(repo_dir, 'd.txt', 'to be deleted\n');
        await git(repo_dir, ['add', '-A']);
        await git(repo_dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'initial']);

        const changed_content = 'modified content\n';
        await write_file(repo_dir, 'a.txt', changed_content);
        await fs.rm(path.join(repo_dir, 'd.txt'));
        await write_file(repo_dir, 'sub/b.js', 'module.exports = 1;\n');
        await write_file(repo_dir, '.venv/x.py', 'ignored\n');
        await write_file(repo_dir, 'node_modules/m.js', 'ignored\n');
        await write_file(repo_dir, '.data/db', 'ignored\n');
        await write_file(repo_dir, '.monarch/tasks.md', 'private\n');
        await write_file(repo_dir, '__pycache__/c.pyc', 'cache\n');

        const state = await repo_state(repo_dir);
        assert.deepEqual(state.files.map(file => file.path).sort(), ['.gitignore', 'a.txt', 'sub/b.js']);
        assert.equal(state.files.find(file => file.path === 'a.txt').size, Buffer.byteLength(changed_content));
        assert.deepEqual(state.changed, ['a.txt', 'sub/b.js']);
        assert.deepEqual(state.deleted, ['d.txt']);
        assert.equal(state.branch, (await git(repo_dir, ['branch', '--show-current'])).trim() || null);
        assert.match(state.head, /^[0-9a-f]{40}$/);
        const all_reported_paths = [...state.files.map(file => file.path), ...state.changed, ...state.deleted];
        for (const ignored_path of ['.monarch/', '.venv/', 'node_modules/', '.data/', '__pycache__/']) {
            assert.ok(all_reported_paths.every(file_path => !file_path.startsWith(ignored_path)), `${ignored_path} leaked into repo state`);
        }

        const empty_dir = path.join(temp_root, 'not-a-repo');
        await fs.mkdir(empty_dir);
        await assert.rejects(repo_state(empty_dir));
        assert.equal(await eol_default(empty_dir), null);
        assert.equal(await eol_default(repo_dir), 'lf');
        await write_file(repo_dir, '.gitattributes', '* text eol=crlf\n');
        assert.equal(await eol_default(repo_dir), 'crlf');

        const timeout_started = Date.now();
        await assert.rejects(run_git(repo_dir, ['hash-object', '--stdin'], { timeout_ms: 300 }));
        assert.ok(Date.now() - timeout_started < 3000, 'git timeout exceeded 3 seconds');

        const controller = new AbortController();
        const abort_started = Date.now();
        const abort_timer = setTimeout(() => controller.abort(), 100);
        try {
            await assert.rejects(run_git(repo_dir, ['hash-object', '--stdin'], { signal: controller.signal }), error => error.name === 'AbortError');
        } finally {
            clearTimeout(abort_timer);
        }
        assert.ok(Date.now() - abort_started < 2000, 'git abort exceeded 2 seconds');

        const already_aborted = new AbortController();
        already_aborted.abort();
        const immediate_started = Date.now();
        await assert.rejects(run_git(repo_dir, ['hash-object', '--stdin'], { signal: already_aborted.signal }), error => error.name === 'AbortError');
        assert.ok(Date.now() - immediate_started < 2000, 'already-aborted git call was not immediate');

        const empty_repo = path.join(temp_root, 'empty-repo');
        await fs.mkdir(empty_repo);
        await git(empty_repo, ['init', '-q']);
        await write_file(empty_repo, 'only.txt', 'uncommitted\n');
        const empty_state = await repo_state(empty_repo);
        assert.equal(empty_state.head, null);
        assert.deepEqual(empty_state.files.map(file => file.path), ['only.txt']);
    } finally {
        await fs.rm(temp_root, { recursive: true, force: true });
    }
}

main().then(() => console.log('ok'), error => {
    console.error(error);
    process.exitCode = 1;
});
