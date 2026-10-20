'use strict';
/** ORCA commands: "### ORCA: <action> [target]" blocks at the end of an agent answer. */

const header_pattern = /^###[ \t]*ORCA:[ \t]*(\w+)[ \t]*(\S*)[ \t]*$/;
const fence_pattern = /^(`{3,}|~{3,})/;

function _closes_fence(line, fence) {
    const trimmed = line.trim();
    return trimmed.length >= fence.length && trimmed[0] === fence[0] && /^(`+|~+)$/.test(trimmed);
}

/**
 * Split an answer into the text for the user and its ORCA commands.
 * Headers inside fenced code blocks are ignored. Each body runs until the next header or the end.
 * Returns {text, commands: [{action, target, body}]}.
 */
function parse_commands(text) {
    const lines = (text || '').split('\n');
    const headers = [];
    let fence = null;
    lines.forEach((line, index) => {
        if (fence) {
            if (_closes_fence(line, fence)) fence = null;
            return;
        }
        const opening = line.match(fence_pattern);
        if (opening) {
            fence = opening[1];
            return;
        }
        const match = line.match(header_pattern);
        if (match) headers.push({ index, action: match[1].toLowerCase(), target: match[2] || null });
    });
    if (!headers.length) return { text: (text || '').trim(), commands: [] };
    const commands = headers.map((header, position) => {
        const end = position + 1 < headers.length ? headers[position + 1].index : lines.length;
        return { action: header.action, target: header.target, body: lines.slice(header.index + 1, end).join('\n').trim() };
    });
    return { text: lines.slice(0, headers[0].index).join('\n').trim(), commands };
}

module.exports = { parse_commands };
