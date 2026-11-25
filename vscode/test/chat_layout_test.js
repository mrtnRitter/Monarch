'use strict';

const assert = require('assert');
const layout = require('../media/chat_layout');

function close(actual, expected) {
  assert.strictEqual(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= 1e-9, `${value} != ${expected[index]}`));
}

close(layout.equal_sizes(3), [1 / 3, 1 / 3, 1 / 3]);
close(layout.equal_sizes(1), [1]);
close(layout.equal_sizes(0), []);
assert.strictEqual(layout.auto_input_height({ text_px: 50, line_px: 20, base_px: 80, max_px: 500, empty_lines: 3 }), 110);
assert.strictEqual(layout.auto_input_height({ text_px: 10, line_px: 20, base_px: 80, max_px: 500, empty_lines: 3 }), 80);
assert.strictEqual(layout.auto_input_height({ text_px: 600, line_px: 20, base_px: 80, max_px: 500, empty_lines: 3 }), 500);
assert.strictEqual(layout.auto_input_height({ text_px: 50.4, line_px: 19.6, base_px: 0, max_px: 500, empty_lines: 3 }), 109);
assert.strictEqual(layout.auto_input_height({ text_px: 50, line_px: 20, base_px: 0, max_px: 500, empty_lines: 1 }), 70);
assert.strictEqual(layout.input_empty_lines(undefined), 1);
assert.strictEqual(layout.input_empty_lines(null), 1);
assert.strictEqual(layout.input_empty_lines('2'), 1);
assert.strictEqual(layout.input_empty_lines(NaN), 1);
assert.strictEqual(layout.input_empty_lines(2), 2);
assert.strictEqual(layout.input_empty_lines(2.6), 3);
assert.strictEqual(layout.input_empty_lines(0), 1);
assert.strictEqual(layout.input_empty_lines(-1), 1);
assert.strictEqual(layout.input_empty_lines(99), 10);
close(layout.drag_split([0.5, 0.5], 0, 100, 1000, 300), [0.6, 0.4]);
close(layout.drag_split([0.5, 0.5], 0, 400, 1000, 300), [0.7, 0.3]);
close(layout.drag_split([0.5, 0.5], 0, -400, 1000, 300), [0.3, 0.7]);
close(layout.drag_split([0.25, 0.25, 0.5], 1, 100, 1200, 100), [0.25, 400 / 1200, 500 / 1200]);
close(layout.drag_split([0.2, 0.2, 0.6], 0, 50, 1000, 300), [0.2, 0.2, 0.6]);
const original = [0.4, 0.6];
const before = original.slice();
layout.drag_split(original, 0, 10, 100, 5);
assert.deepStrictEqual(original, before);
assert.strictEqual(layout.insert_index(2, 'right'), 2);
assert.strictEqual(layout.insert_index(2, 'left'), 0);
assert.strictEqual(layout.insert_index(3, undefined), 3);
assert.strictEqual(layout.next_active([1, 2, 3], 2, 2), 1);
assert.strictEqual(layout.next_active([1, 2, 3], 1, 1), 2);
assert.strictEqual(layout.next_active([1, 2, 3], 3, 2), 2);
assert.strictEqual(layout.next_active([1], 1, 1), null);

console.log('chat_layout tests passed');
