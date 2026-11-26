'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') return { Uri: { joinPath: (...parts) => parts.join('/') } };
    return original_load.call(this, request, parent, is_main);
};

let chat_html;
try {
    ({ chat_html } = require('../src/chat_html'));
} finally {
    Module._load = original_load;
}

const webview = { asWebviewUri: uri => uri, cspSource: 'x' };
const html = chat_html({ webview, extension_uri: 'ext' });
const bottom_start = html.indexOf('<div class="bottom-row">');
const bottom_end = html.indexOf('\n</div>\n</div>\n</div>\n</template>', bottom_start);
const toolbar_start = html.indexOf('<div class="input-toolbar"');
const toolbar_end = html.indexOf('</div>\n<div class="attachments"', toolbar_start);
assert.notEqual(bottom_start, -1);
assert.notEqual(bottom_end, -1);
assert.notEqual(toolbar_start, -1);
assert.notEqual(toolbar_end, -1);

const bottom = html.slice(bottom_start, bottom_end);
const toolbar = html.slice(toolbar_start, toolbar_end);
const bottom_index = name => bottom.indexOf(`data-el="${name}"`);
const toolbar_index = name => toolbar.indexOf(`data-el="${name}"`);

assert.ok(bottom_index('close') < bottom_index('terminal'));
assert.ok(bottom_index('terminal') < bottom_index('repo'));
assert.ok(bottom_index('repo') < bottom_index('send'));
assert.ok(bottom_index('send') < bottom_index('stop'));
assert.match(bottom, /<div class="bottom-left">[\s\S]*data-el="close"[\s\S]*data-el="terminal"[\s\S]*<\/div>/);
assert.match(bottom, /<div class="bottom-right">[\s\S]*data-el="send"[\s\S]*data-el="stop"[\s\S]*<\/div>/);
assert.doesNotMatch(bottom, /class="grow"/);
assert.ok(toolbar_index('attach') < toolbar_index('credits'));
assert.ok(toolbar_index('credits') < toolbar_index('model'));
assert.match(html, /class="repo-name"/);

const main_start = html.indexOf('<main class="main"');
const actionbar_start = html.indexOf('<div class="actionbar" id="actionbar">');
const actionbar_end = html.indexOf('\n</div>\n</div>\n<template id="area_template">', actionbar_start);
assert.notEqual(main_start, -1);
assert.ok(actionbar_start > main_start);
assert.equal(html.includes('class="topbar"'), false);
assert.notEqual(actionbar_end, -1);
const actionbar = html.slice(actionbar_start, actionbar_end);
assert.ok(actionbar.indexOf('id="new_chat"') < actionbar.indexOf('id="history"'));
assert.ok(actionbar.indexOf('id="history"') < actionbar.indexOf('id="notes_toggle"'));
assert.match(actionbar, /id="history_menu" class="menu hidden"/);
