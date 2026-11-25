'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { JSDOM } = require('jsdom');
const layout = require('../media/chat_layout');
const markdown = require('../media/markdown');
const time = require('../media/chat_time');
const scroll = require('../media/chat_scroll');

const original_load = Module._load;
Module._load = function (request, parent, is_main) {
    if (request === 'vscode') {
        return {
            Uri: {
                joinPath(base, ...parts) {
                    return { path: path.posix.join(base.path, ...parts.map(part => part.path || part)) };
                },
            },
        };
    }
    return original_load.call(this, request, parent, is_main);
};
const { chat_html } = require('../src/chat_html');
Module._load = original_load;

const webview = { cspSource: 'vscode-resource:', asWebviewUri: uri => uri.path };
const html = chat_html({ webview, extension_uri: { path: '/extension' } });
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.monarch_layout = layout;
window.monarch_markdown = markdown;
window.monarch_time = time;
window.monarch_scroll = scroll;
window.eval(fs.readFileSync(path.join(__dirname, '../media/chat.js'), 'utf8'));

const root = window.document.querySelector('#area_template').content.firstElementChild.cloneNode(true);
window.document.body.appendChild(root);
const posted = [];
const chat = window.monarch_chat.create({ root, chat_id: 'chat-a', post: message => posted.push(message), input_height: 84 });
chat.on_message({
    type: 'message',
    item: {
        role: 'question',
        interrupt_id: 'interrupt-a',
        questions: [
            { text: 'Single choice', options: ['A', 'B'], multi: false, custom: false },
            { text: 'Multiple choice', options: ['X', 'Y'], multi: true, custom: false },
        ],
    },
});

const first = [...root.querySelectorAll('.question .option')].filter(button => ['A', 'B'].includes(button.textContent));
const multiple = [...root.querySelectorAll('.question .option')].filter(button => ['X', 'Y'].includes(button.textContent));
const submit = root.querySelector('.question-send');

first[0].click();
assert.equal(first[0].classList.contains('chosen'), true, 'clicking A selects it');
first[0].click();
assert.equal(first.some(button => button.classList.contains('chosen')), false, 'clicking A again deselects it');
assert.equal(submit.disabled, true, 'Send answer is disabled when no answer is selected');
first[0].click();
first[1].click();
assert.equal(first[0].classList.contains('chosen'), false, 'selecting B replaces A');
assert.equal(first[1].classList.contains('chosen'), true, 'B is the only selected single-choice option');

multiple[0].click();
multiple[1].click();
assert.equal(multiple.every(button => button.classList.contains('chosen')), true, 'multi-select allows both options');
multiple[0].click();
assert.equal(multiple[0].classList.contains('chosen'), false, 'multi-select toggles X off');
assert.equal(multiple[1].classList.contains('chosen'), true, 'Y remains selected');

chat.dispose();
dom.window.close();
