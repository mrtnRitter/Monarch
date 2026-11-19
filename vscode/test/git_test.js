'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { run_git, eol_default, repo_state } = require('../src/git');

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
