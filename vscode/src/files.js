'use strict';
/** FILE blocks, checksums and path safety shared by the chat and the relay. */
const crypto = require('crypto');

const comment_pattern = /<!--[\s\S]*?-->/g;
// "### FILE: path sha256=..." followed by a fenced block; the closing fence must match the opening one
const file_block_pattern = /^#{2,4}[ \t]*FILE:[ \t]*`?([^`\n]+?)`?(?:[ \t]+sha256=([0-9a-fA-F]{64}))?[ \t]*\n+(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\3[ \t]*$/gm;

/** Remove hidden HTML comments from agent text. */
function clean_text(text) {
    return (text || '').replace(comment_pattern, '').trim();
}

/** Normalize text for checksums: LF line endings and exactly one final line break. */
function normalize_text(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n+$/, '') + '\n';
}

/** SHA-256 hex digest of the normalized text. */
function sha256_text(text) {
    return crypto.createHash('sha256').update(normalize_text(text), 'utf8').digest('hex');
}

function _block_path(name) {
    return name.split(/\s+sha256=/)[0].trim();
}

/**
 * Return all FILE blocks of a text as {path, content, check}.
 * check is 'verified', 'mismatch' (checksum differs) or 'unverified' (no checksum).
 */
function parse_file_blocks(text) {
    return [...(text || '').matchAll(file_block_pattern)].map(match => {
        const content = normalize_text(match[4]);
        const expected = match[2] ? match[2].toLowerCase() : null;
        const check = !expected ? 'unverified' : sha256_text(content) === expected ? 'verified' : 'mismatch';
        return { path: _block_path(match[1]), content, check };
    });
}

/** Replace FILE blocks by a short [file: path] reference. */
function strip_file_blocks(text) {
    return (text || '').replace(file_block_pattern, (_, name) => `[file: ${_block_path(name)}]`).trim();
}

/** Return a safe relative POSIX path inside the repo, or null for absolute paths, "..", ".git" and empty paths. */
function safe_rel_path(path) {
    const clean = (path || '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) return null;
    const parts = clean.split('/').filter(part => part && part !== '.');
    return parts.length && !parts.includes('..') && !parts.includes('.git') ? parts.join('/') : null;
}

/** True for Python caches that are never transferred. */
function is_junk(path) {
    const parts = (path || '').replace(/\\/g, '/').split('/');
    return parts.includes('__pycache__') || parts[parts.length - 1].endsWith('.pyc');
}

/** Repo-relative path of an agent output file: its path below /workspace/output/, else its name. */
function output_rel_path(file) {
    const match = (file.sandboxPath || file.id || '').match(/^\/workspace\/output\/(.+)$/);
    return match ? match[1] : file.name || '';
}

module.exports = { clean_text, normalize_text, sha256_text, parse_file_blocks, strip_file_blocks, safe_rel_path, is_junk, output_rel_path };
