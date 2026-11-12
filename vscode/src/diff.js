'use strict';
/** Unified text diffs and relay size planning. */

function _lines(text) {
    if (!text) return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}

function _line_tokens(text) {
    const lines = _lines(text);
    const has_final_newline = text.endsWith('\n');
    return lines.map((value, index) => ({ value, terminated: index < lines.length - 1 || has_final_newline }));
}

function _same_line(left, right) {
    return left.value === right.value && left.terminated === right.terminated;
}

function _bisect(old_lines, new_lines) {
    const old_length = old_lines.length;
    const new_length = new_lines.length;
    const max_distance = Math.ceil((old_length + new_length) / 2);
    const offset = max_distance + 1;
    const vector_length = 2 * max_distance + 3;
    const forward = new Int32Array(vector_length).fill(-1);
    const reverse = new Int32Array(vector_length).fill(-1);
    forward[offset + 1] = 0;
    reverse[offset + 1] = 0;
    const delta = old_length - new_length;
    const odd_delta = delta % 2 !== 0;
    let forward_start = 0;
    let forward_end = 0;
    let reverse_start = 0;
    let reverse_end = 0;

    for (let distance = 0; distance <= max_distance; distance++) {
        for (let diagonal = -distance + forward_start; diagonal <= distance - forward_end; diagonal += 2) {
            const index = offset + diagonal;
            let x = diagonal === -distance || (diagonal !== distance && forward[index - 1] < forward[index + 1])
                ? forward[index + 1]
                : forward[index - 1] + 1;
            let y = x - diagonal;
            while (x < old_length && y < new_length && _same_line(old_lines[x], new_lines[y])) {
                x++;
                y++;
            }
            forward[index] = x;
            if (x > old_length) forward_end += 2;
            else if (y > new_length) forward_start += 2;
            else if (odd_delta) {
                const reverse_index = offset + delta - diagonal;
                const reverse_x = reverse[reverse_index];
                if (reverse_x !== -1 && x >= old_length - reverse_x) return { x, y };
            }
        }

        for (let diagonal = -distance + reverse_start; diagonal <= distance - reverse_end; diagonal += 2) {
            const index = offset + diagonal;
            let x = diagonal === -distance || (diagonal !== distance && reverse[index - 1] < reverse[index + 1])
                ? reverse[index + 1]
                : reverse[index - 1] + 1;
            let y = x - diagonal;
            while (x < old_length && y < new_length && _same_line(old_lines[old_length - x - 1], new_lines[new_length - y - 1])) {
                x++;
                y++;
            }
            reverse[index] = x;
            if (x > old_length) reverse_end += 2;
            else if (y > new_length) reverse_start += 2;
            else if (!odd_delta) {
                const forward_index = offset + delta - diagonal;
                const forward_x = forward[forward_index];
                const forward_y = forward_x - (delta - diagonal);
                if (forward_x !== -1 && forward_x >= old_length - x) return { x: forward_x, y: forward_y };
            }
        }
    }
    return null;
}

function _myers(old_lines, new_lines) {
    if (!old_lines.length) return new_lines.map(line => ({ type: 'add', line }));
    if (!new_lines.length) return old_lines.map(line => ({ type: 'delete', line }));

    let prefix = 0;
    while (prefix < old_lines.length && prefix < new_lines.length && _same_line(old_lines[prefix], new_lines[prefix])) prefix++;
    let suffix = 0;
    while (suffix < old_lines.length - prefix && suffix < new_lines.length - prefix
        && _same_line(old_lines[old_lines.length - suffix - 1], new_lines[new_lines.length - suffix - 1])) suffix++;
    const old_middle = old_lines.slice(prefix, old_lines.length - suffix);
    const new_middle = new_lines.slice(prefix, new_lines.length - suffix);
    if (!old_middle.length || !new_middle.length) {
        return [
            ...old_lines.slice(0, prefix).map(line => ({ type: 'equal', line })),
            ...old_middle.map(line => ({ type: 'delete', line })),
            ...new_middle.map(line => ({ type: 'add', line })),
            ...old_lines.slice(old_lines.length - suffix).map(line => ({ type: 'equal', line })),
        ];
    }

    const split = _bisect(old_middle, new_middle);
    if (!split || (!split.x && !split.y) || (split.x === old_middle.length && split.y === new_middle.length)) {
        return [
            ...old_lines.slice(0, prefix).map(line => ({ type: 'equal', line })),
            ...old_middle.map(line => ({ type: 'delete', line })),
            ...new_middle.map(line => ({ type: 'add', line })),
            ...old_lines.slice(old_lines.length - suffix).map(line => ({ type: 'equal', line })),
        ];
    }
    return [
        ...old_lines.slice(0, prefix).map(line => ({ type: 'equal', line })),
        ..._myers(old_middle.slice(0, split.x), new_middle.slice(0, split.y)),
        ..._myers(old_middle.slice(split.x), new_middle.slice(split.y)),
        ...old_lines.slice(old_lines.length - suffix).map(line => ({ type: 'equal', line })),
    ];
}

/**
 * Return a unified diff and its added/deleted line counts.
 * @param {string} old_text
 * @param {string} new_text
 * @param {number} [context=3]
 * @returns {{text: string, added: number, deleted: number}}
 */
function unified_diff(old_text, new_text, context = 3) {
    const old_lines = _line_tokens(old_text);
    const new_lines = _line_tokens(new_text);
    if (old_lines.length === new_lines.length && old_lines.every((line, index) => _same_line(line, new_lines[index]))) return { text: '', added: 0, deleted: 0 };

    let prefix = 0;
    while (prefix < old_lines.length && prefix < new_lines.length && _same_line(old_lines[prefix], new_lines[prefix])) prefix++;
    let suffix = 0;
    while (suffix < old_lines.length - prefix && suffix < new_lines.length - prefix
        && _same_line(old_lines[old_lines.length - suffix - 1], new_lines[new_lines.length - suffix - 1])) suffix++;

    const operations = [
        ...old_lines.slice(0, prefix).map(line => ({ type: 'equal', line })),
        ..._myers(old_lines.slice(prefix, old_lines.length - suffix), new_lines.slice(prefix, new_lines.length - suffix)),
        ...old_lines.slice(old_lines.length - suffix).map(line => ({ type: 'equal', line })),
    ];
    const changed = operations.map((operation, index) => operation.type === 'equal' ? -1 : index).filter(index => index >= 0);
    if (!changed.length) return { text: '', added: 0, deleted: 0 };

    const context_lines = Math.max(0, Math.trunc(context) || 0);
    const ranges = [];
    for (const index of changed) {
        const start = Math.max(0, index - context_lines);
        const end = Math.min(operations.length, index + context_lines + 1);
        const previous = ranges[ranges.length - 1];
        if (previous && start <= previous.end) previous.end = end;
        else ranges.push({ start, end });
    }

    let old_before = 0;
    let new_before = 0;
    let added = 0;
    let deleted = 0;
    const lines = [];
    let range_index = 0;
    for (let index = 0; index <= operations.length; index++) {
        while (range_index < ranges.length && ranges[range_index].start === index) {
            const range = ranges[range_index++];
            let old_count = 0;
            let new_count = 0;
            for (const operation of operations.slice(range.start, range.end)) {
                if (operation.type !== 'add') old_count++;
                if (operation.type !== 'delete') new_count++;
            }
            const old_start = old_count ? old_before + 1 : old_before;
            const new_start = new_count ? new_before + 1 : new_before;
            lines.push(`@@ -${old_start},${old_count} +${new_start},${new_count} @@`);
            for (const operation of operations.slice(range.start, range.end)) {
                const marker = operation.type === 'equal' ? ' ' : operation.type === 'add' ? '+' : '-';
                lines.push(`${marker}${operation.line.value}`);
                if (!operation.line.terminated) lines.push('\\ No newline at end of file');
                if (operation.type === 'add') added++;
                if (operation.type === 'delete') deleted++;
            }
        }
        if (index === operations.length) break;
        const operation = operations[index];
        if (operation.type !== 'add') old_before++;
        if (operation.type !== 'delete') new_before++;
    }
    return { text: lines.join('\n'), added, deleted };
}

/**
 * Choose inline diffs while keeping their combined size within the byte limit.
 * @param {{path: string, size: number}[]} entries
 * @param {'inline'|'attach'|'off'} [mode='inline']
 * @param {number} [max_kb=40]
 * @returns {{inline: string[], attached: string[]}}
 */
function plan_diffs(entries, mode = 'inline', max_kb = 40) {
    if (mode === 'off') return { inline: [], attached: [] };
    if (mode === 'attach') return { inline: [], attached: entries.map(entry => entry.path) };
    const attached = new Set();
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const limit = max_kb * 1024;
    while (total > limit && attached.size < entries.length) {
        let largest = -1;
        for (let index = 0; index < entries.length; index++) {
            if (attached.has(index)) continue;
            if (largest < 0 || entries[index].size > entries[largest].size) largest = index;
        }
        if (largest < 0) break;
        attached.add(largest);
        total -= entries[largest].size;
    }
    return {
        inline: entries.filter((_, index) => !attached.has(index)).map(entry => entry.path),
        attached: entries.filter((_, index) => attached.has(index)).map(entry => entry.path),
    };
}

module.exports = { unified_diff, plan_diffs };
