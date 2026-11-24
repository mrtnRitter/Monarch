'use strict';

const assert = require('node:assert/strict');
const { context_line } = require('../src/repo');

const base = context_line({ folder: 'A', git: true, remote: 'git@github.com:u/A.git', branch: 'main' });
assert.equal(base, '[monarch context] "this repo" = the repo open in VS Code: A · online: https://github.com/u/A · branch: main · local state differs from online (branch not pushed); ask for attachments if needed · files: save them in /workspace/output/ with their repo path, monarch downloads them');

const with_others = context_line({
    folder: 'A', git: true, remote: 'git@github.com:u/A.git', branch: 'main',
    others: [{ folder: 'B', git: true, remote: 'https://github.com/u/B.git' }, { folder: 'C', git: false, remote: null }],
});
const other_part = 'other repos in this VS Code window (read only, ATTACH: read:<repo>:<path> or repo-snapshot:<repo>): B (online: https://github.com/u/B), C (not online)';
assert.ok(with_others.includes(other_part));
assert.ok(with_others.indexOf(other_part) < with_others.indexOf('files:'));
