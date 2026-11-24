'use strict';

const assert = require('node:assert/strict');
const { time_text, date_text, day_key, divider_for } = require('../media/chat_time');

const a = new Date(2026, 10, 23, 10, 0).getTime();
const b = new Date(2026, 10, 23, 23, 59).getTime();
const c = new Date(2026, 10, 24, 0, 1).getTime();

assert.deepEqual(divider_for(null, a), { divider: null, last_day: day_key(a) });
assert.equal(divider_for(day_key(a), b).divider, null);
assert.equal(divider_for(day_key(b), c).divider, date_text(c));
assert.deepEqual(divider_for('2026-11-23', null), { divider: null, last_day: '2026-11-23' });
assert.equal(day_key(a), '2026-11-23');
assert.equal(time_text(a), new Date(a).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
