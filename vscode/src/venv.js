'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Return the shell command for activating the repository's first available venv, or null. */
function venv_command(root_path, shell_path, exists = fs.existsSync, platform = process.platform) {
    const shell_name = path.win32.basename(shell_path).toLowerCase().replace(/\.exe$/, '');
    const shell = shell_name === 'pwsh' || shell_name === 'powershell' ? 'pwsh'
        : shell_name === 'cmd' ? 'cmd'
            : shell_name === 'fish' ? 'fish'
                : !shell_name && platform === 'win32' ? 'pwsh'
                    : 'posix';
    const candidates = {
        pwsh: ['Scripts/Activate.ps1', 'bin/Activate.ps1'],
        cmd: ['Scripts/activate.bat'],
        fish: ['bin/activate.fish'],
        posix: ['bin/activate', 'Scripts/activate'],
    }[shell];

    for (const directory of ['.venv', 'venv']) {
        for (const candidate of candidates) {
            const relative_path = `${directory}/${candidate}`;
            if (!exists(path.join(root_path, relative_path))) continue;
            if (shell === 'pwsh') return `& './${relative_path}'`;
            if (shell === 'cmd') return relative_path.replaceAll('/', '\\');
            if (shell === 'fish') return `source ./${relative_path}`;
            return `. ./${relative_path}`;
        }
    }
    return null;
}

module.exports = { venv_command };
