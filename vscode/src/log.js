'use strict';
/** Shared diagnostic log; the extension connects it to the "monarch" output channel, tests keep it silent. */

let sink = () => {};

/** Send log lines to fn(line); fn = null switches logging off. */
function set_log(fn) {
    sink = fn || (() => {});
}

/** Write one line with time stamp. */
function log(text) {
    sink(`${new Date().toISOString().slice(11, 19)} ${text}`);
}

module.exports = { set_log, log };
