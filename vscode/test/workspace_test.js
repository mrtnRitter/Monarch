'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

function uri(fsPath) {
    return { fsPath, toString: () => `file://${fsPath}` };
}
const folders = [{ name: 'A', uri: uri('/r/A'), index: 0 }, { name: 'B', uri: uri('/r/B'), index: 1 }];
const vscode = {
    Uri: { joinPath: (base, ...parts) => uri([base.fsPath, ...parts].join('/').replace(/\/{2,}/g, '/')) },
    workspace: {
        workspaceFolders: folders,
        getConfiguration: () => ({ get: () => 20 }),
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
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
