'use strict';
/** Bundles of the monarch-transfer skill: gzip JSON {format: 'monarch-bundle', version: 1, thread, files: [{path, sha256, data (base64)}]}. */
const crypto = require('crypto');
const zlib = require('zlib');

const name_pattern = /^monarch_([0-9a-f-]{36})_\d{8}T\d{9}Z\.json\.gz$/i;

/** Chat id from a bundle file name; null if the name has another form. */
function bundle_thread(name) {
    return name_pattern.exec(name || '')?.[1].toLowerCase() || null;
}

/**
 * Unpack a bundle: {thread, files: [{path, data}], failed: [{path, reason}]}.
 * Throws if the bundle itself is not readable; max_bytes limits the unpacked size.
 */
function unpack_bundle(data, max_bytes) {
    let bundle;
    try {
        bundle = JSON.parse(zlib.gunzipSync(data, { maxOutputLength: max_bytes }).toString('utf8'));
    } catch (error) {
        throw new Error(error.code === 'ERR_BUFFER_TOO_LARGE' ? `bundle larger than ${max_bytes} bytes` : 'bundle not readable');
    }
    if (bundle?.format !== 'monarch-bundle' || bundle.version !== 1 || !Array.isArray(bundle.files)) throw new Error('not a monarch bundle (version 1)');
    const files = [];
    const failed = [];
    for (const item of bundle.files) {
        const path = typeof item?.path === 'string' ? item.path : '?';
        const content = Buffer.from(typeof item?.data === 'string' ? item.data : '', 'base64');
        if (crypto.createHash('sha256').update(content).digest('hex') === item?.sha256) files.push({ path, data: content });
        else failed.push({ path, reason: 'checksum mismatch' });
    }
    return { thread: String(bundle.thread || '').toLowerCase(), files, failed };
}

module.exports = { bundle_thread, unpack_bundle };
