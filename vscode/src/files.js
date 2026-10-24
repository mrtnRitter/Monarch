'use strict';
/** Agent text cleanup and path safety for output files shared by the chat and the relay. */

const comment_pattern = /<!--[\s\S]*?-->/g;
const output_pattern = /^\/workspace\/output\/(.+)$/;

/** Remove hidden HTML comments from agent text. */
function clean_text(text) {
    return (text || '').replace(comment_pattern, '').trim();
}

/** Last part of a path. */
function basename(path) {
    return (path || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
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

/** Path of an agent output file below /workspace/output/ (from sandboxPath or id); null if it is not there. */
function output_path(file) {
    return (file.sandboxPath || file.id || '').match(output_pattern)?.[1] || null;
}

/** Repo-relative path of an agent output file: its path below /workspace/output/, else its name. */
function output_rel_path(file) {
    return output_path(file) || file.name || '';
}

module.exports = { clean_text, safe_rel_path, is_junk, output_path, output_rel_path, basename };
