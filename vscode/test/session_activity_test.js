'use strict';

const assert = require('node:assert/strict');
const { activity_summary } = require('../src/session');

assert.equal(activity_summary([], []), '');
assert.equal(activity_summary([{ action: 'inspect' }], []), 'Commands: inspect');
assert.equal(activity_summary([{ action: 'spawn' }, { action: 'spawn' }, { action: 'send' }], []), 'Commands: spawn ×2, send');
assert.equal(activity_summary([{ action: 'commit' }], [{ path: 'a.js' }, { path: 'b.css' }]), 'Commands: commit · Files: a.js, b.css');
assert.equal(activity_summary([], ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'].map(path => ({ path }))), 'Files: f1, f2, f3, f4, f5, +2 more');
