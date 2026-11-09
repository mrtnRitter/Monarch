'use strict';

const notes_marker = '[monarch notes]';
const notes_end = '[/monarch notes]';
const notes_header = `${notes_marker} Notes of this chat, shown next to the chat (not in the repo). To change them, end your answer with "### ORCA: notes" followed by the complete new notes.`;

/** Build the marked notes block sent with an agent message. @param {string} notes Complete notes text. @returns {string} The notes block. */
function notes_block(notes) {
    return [notes_header, ...(notes ? [notes] : []), notes_end].join('\n');
}

/** Remove a trailing marked notes block from message text. @param {string} text Message text. @returns {string} Text without its trailing notes block, if present. */
function strip_notes(text) {
    const trimmed = text.trimEnd();
    if (!trimmed.endsWith(notes_end)) return text;
    let marker_index = trimmed.lastIndexOf(notes_header);
    while (marker_index >= 0 && marker_index > 0 && trimmed[marker_index - 1] !== '\n') {
        marker_index = trimmed.lastIndexOf(notes_header, marker_index - 1);
    }
    return marker_index < 0 ? text : trimmed.slice(0, marker_index).trimEnd();
}

module.exports = { notes_block, strip_notes, notes_marker, notes_end };
