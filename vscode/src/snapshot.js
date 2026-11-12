'use strict';
/** Repository snapshot labels, folder sizes and manifest text. */

/** Build the short label shown in the brief and relay.
 * @param {{branch: string|null, head: string|null, staged_count: number}} snapshot
 * @returns {string}
 */
function snapshot_label({ branch, head, staged_count }) {
    return `repo-snapshot.zip = ${branch || 'HEAD'}@${head ? head.slice(0, 7) : 'none'} + ${staged_count} staged`;
}

/** Return the largest top-level folders (and root files) by uncompressed size.
 * @param {{path: string, size: number}[]} files
 * @param {number} [count=5]
 * @returns {{dir: string, size: number}[]}
 */
function largest_dirs(files, count = 5) {
    const sizes = new Map();
    for (const file of files) {
        const dir = file.path.includes('/') ? file.path.split('/')[0] : '.';
        sizes.set(dir, (sizes.get(dir) || 0) + file.size);
    }
    return [...sizes].map(([dir, size]) => ({ dir, size }))
        .sort((left, right) => right.size - left.size || (left.dir < right.dir ? -1 : left.dir > right.dir ? 1 : 0))
        .slice(0, count);
}

/** Build the UTF-8 manifest describing the source tree and staged overlay.
 * @param {{branch: string|null, head: string|null, changed?: string[], staged?: {path: string, from: string}[], deleted?: string[]}} snapshot
 * @returns {string}
 */
function snapshot_md({ branch, head, changed = [], staged = [], deleted = [] }) {
    const lines = [
        '# repo snapshot', '', `- branch: ${branch || 'HEAD'}`, `- HEAD: ${head || 'none'}`,
        '', '## locally changed files', ...(changed.length ? changed.map(path => `- ${path}`) : ['- none']),
        '', '## staged files (overlaid)', ...(staged.length ? staged.map(file => `- ${file.path} (staged by ${file.from})`) : ['- none']),
    ];
    if (deleted.length) lines.push('', '## deleted files (nicht enthalten)', ...deleted.map(path => `- ${path}`));
    return `${lines.join('\n')}\n`;
}

module.exports = { snapshot_label, largest_dirs, snapshot_md };
