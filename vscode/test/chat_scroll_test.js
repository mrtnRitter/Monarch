'use strict';

const assert = require('node:assert/strict');
const { at_bottom, answer_target, reached } = require('../media/chat_scroll');

assert.equal(at_bottom({ scroll_top: 376, scroll_height: 1000, client_height: 600 }), true);
assert.equal(at_bottom({ scroll_top: 375, scroll_height: 1000, client_height: 600 }), false);
assert.equal(answer_target({ scroll_height: 1500, client_height: 600, top: 1000 }), 900);
assert.equal(answer_target({ scroll_height: 2000, client_height: 600, top: 1000 }), 900);
assert.equal(answer_target({ scroll_height: 800, client_height: 600, top: 100 }), 0);
assert.equal(answer_target({ scroll_height: 500, client_height: 600, top: 0 }), 0);
assert.equal(answer_target({ scroll_height: 3000, client_height: 600, top: 50 }), 0);
assert.equal(reached(100, 100), true);
assert.equal(reached(101, 100), false);
