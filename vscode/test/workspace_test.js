'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function uri(fsPath) {
    return { fsPath, toString: () => `file://${fsPath}` };
}
const folders = [{ name: 'A', uri: uri('/r/A'), index: 0 }, { name: 'B', uri: uri('/r/B'), index: 1 }];
let repos_root = '';
const vscode = {
    Uri: {
        file: fsPath => uri(fsPath),
        joinPath: (base, ...parts) => uri([base.fsPath, ...parts].join('/').replace(/\/{2,}/g, '/')),
    },
    workspace: {
        workspaceFolders: folders,
        getConfiguration: section => ({ get: key => section === 'monarch' && key === 'reposRoot' ? repos_root : 20 }),
        fs: {
            stat: async () => ({ size: 3 }),
            readFile: async target => Buffer.from(target.fsPath),
        },
    },
};
const git = { eol_default: async () => 'lf', repo_state: async () => ({}) };
const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return vscode;
    if (request === './git' && parent?.filename.endsWith('/src/workspace.js')) return git;
    return original_load.call(this, request, parent, is_main);
};
const workspace = require('../src/workspace');
Module._load = original_load;

async function main() {
    assert.deepEqual(workspace.folders().map(folder => folder.name), ['A', 'B']);
    assert.equal(workspace.folder_by_name('B').index, 1);
    assert.equal(workspace.folder_by_name('X'), null);
    assert.deepEqual(workspace.repo_color(7), { theme: 'terminal.ansiGreen', hex: '#23d18b', icon: 'repo_1.svg' });

    const adapter = workspace.make_workspace_adapter(() => folders[0].uri);
    assert.equal(adapter.other('A'), null);
    assert.equal(adapter.other('X'), null);
    assert.equal(String(await adapter.other('B').read('x.txt')), '/r/B/x.txt');
    assert.equal(String(await adapter.read('y')), '/r/A/y');

    const no_root = workspace.make_workspace_adapter(() => null);
    await assert.rejects(no_root.read('y'), /no folder open/);

    const temp_root = await fs.mkdtemp(path.join(os.tmpdir(), 'monarch-repos-'));
    try {
        await fs.mkdir(path.join(temp_root, 'alpha', '.git'), { recursive: true });
        await fs.mkdir(path.join(temp_root, 'Beta'));
        await fs.writeFile(path.join(temp_root, 'Beta', '.git'), 'gitdir');
        await fs.mkdir(path.join(temp_root, 'gamma'));
        await fs.mkdir(path.join(temp_root, '.hidden', '.git'), { recursive: true });

        repos_root = temp_root;
        const repos = await workspace.list_repos();
        assert.deepEqual(repos.map(repo => repo.name), ['A', 'alpha', 'B', 'Beta']);
        assert.deepEqual(repos.map(repo => repo.open), [true, false, true, false]);

        repos_root = path.join(temp_root, 'missing');
        assert.deepEqual((await workspace.list_repos()).map(repo => repo.name), ['A', 'B']);
        repos_root = '';
        assert.deepEqual(workspace.repo_roots(), ['/r']);
        repos_root = temp_root;

        assert.equal((await workspace.find_repo({ path: path.join(temp_root, 'alpha') })).name, 'alpha');
        assert.equal((await workspace.find_repo({ name: 'Beta' })).name, 'Beta');
        assert.equal(await workspace.find_repo({ name: 'x', path: '/nicht/da' }), null);
    } finally {
        repos_root = '';
        await fs.rm(temp_root, { recursive: true, force: true });
    }

    assert.equal(workspace.pick_slot({}, []), 0);
    assert.equal(workspace.pick_slot({ a: 0, b: 1 }, [0]), 2);
    assert.equal(workspace.pick_slot({ a: 0, b: 0, c: 1 }, [1, 2, 3, 4, 5]), 0);
    assert.equal(workspace.pick_slot({ a: 0 }, [0, 1, 2, 3, 4, 5]), 1);

    const stored = {};
    const memento = {
        get: key => key === 'monarch.repoColors' ? stored : undefined,
        update: async (key, value) => { stored[key] = value; },
    };
    const colors = workspace.make_repo_colors(memento, () => ['A']);
    assert.equal(colors.slot('A'), 0);
    assert.equal(colors.slot('B'), 1);
    assert.equal(colors.slot('a'), 0);
    assert.equal(colors.peek('C'), null);
    assert.equal(colors.color('B').hex, '#23d18b');
    assert.deepEqual(stored['monarch.repoColors'], { a: 0, b: 1 });

    const unhandled = [];
    const on_unhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', on_unhandled);
    try {
        const failing = workspace.make_repo_colors({
            get: () => ({}),
            update: () => Promise.reject(new Error('storage unavailable')),
        });
        failing.slot('rejected-update');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(unhandled, []);
    } finally {
        process.removeListener('unhandledRejection', on_unhandled);
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
