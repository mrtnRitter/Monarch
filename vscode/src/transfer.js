'use strict';
/** Files sent by the monarch-transfer skill as MONARCH-FILE lines in tool results: reassemble, unpack and verify them. */
const crypto = require('crypto');
const zlib = require('zlib');

// only chars that awork does not escape in stored tool results (no "+", "/", quotes)
const line_pattern = /MONARCH-FILE v1 path=([A-Za-z0-9_-]+) sha256=([0-9a-f]{64}) part=(\d+)of(\d+) data=([A-Za-z0-9_-]*)/g;

function _responses(messages) {
    return messages.flatMap(message => message.toolCalls || []).map(call => (typeof call.response === 'string' ? call.response : JSON.stringify(call.response ?? '')));
}

/** Versions per path in the order they were seen: Map(path -> Map(sha -> {total, parts: Map(number -> data)})). */
function _versions(messages) {
    const versions = new Map();
    for (const text of _responses(messages)) {
        for (const [, path64, sha, part, total, data] of text.matchAll(line_pattern)) {
            const path = Buffer.from(path64, 'base64url').toString('utf8');
            const by_sha = versions.get(path) || versions.set(path, new Map()).get(path);
            const version = by_sha.get(sha) || { total: Number(total), parts: new Map() };
            // re-insert so that the version seen last comes last
            by_sha.delete(sha);
            by_sha.set(sha, version);
            version.parts.set(Number(part), data);
        }
    }
    return versions;
}

function _complete(version) {
    return Array.from({ length: version.total }, (_, index) => version.parts.has(index + 1)).every(Boolean);
}

function _unpack(sha, version, max_bytes) {
    const packed = Buffer.from(Array.from({ length: version.total }, (_, index) => version.parts.get(index + 1)).join(''), 'base64url');
    let data;
    try {
        data = zlib.gunzipSync(packed, { maxOutputLength: max_bytes });
    } catch (error) {
        return { reason: error.code === 'ERR_BUFFER_TOO_LARGE' ? `transfer larger than ${max_bytes} bytes` : 'transfer not readable' };
    }
    return crypto.createHash('sha256').update(data).digest('hex') === sha ? { data } : { reason: 'checksum mismatch' };
}

/**
 * Files transferred in the tool results of messages: {files: [{path, data}], failed: [{path, reason}]}.
 * path = path below output/ as sent (not checked for safety); per path the last completely sent version wins.
 */
function collect_transfers(messages, max_bytes) {
    const files = [];
    const failed = [];
    for (const [path, by_sha] of _versions(messages)) {
        const candidates = [...by_sha.entries()];
        const complete = candidates.filter(([, version]) => _complete(version)).pop();
        if (!complete) {
            const [, last] = candidates.at(-1);
            failed.push({ path, reason: `transfer incomplete (${last.parts.size}/${last.total} parts)` });
            continue;
        }
        const result = _unpack(complete[0], complete[1], max_bytes);
        if (result.data) files.push({ path, data: result.data });
        else failed.push({ path, reason: result.reason });
    }
    return { files, failed };
}

module.exports = { collect_transfers };
