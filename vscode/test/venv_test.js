'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { venv_command } = require('../src/venv');

function check(root_path, shell_path, present, expected, platform = process.platform) {
    const existing = new Set(present.map(relative_path => path.join(root_path, relative_path)));
    assert.equal(venv_command(root_path, shell_path, candidate => existing.has(candidate), platform), expected);
}

check('/repo', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', ['.venv/Scripts/Activate.ps1'], "& './.venv/Scripts/Activate.ps1'");
check('/repo', 'C:\\Windows\\System32\\cmd.exe', ['.venv/Scripts/activate.bat'], '.venv\\Scripts\\activate.bat');
check('/repo', '/bin/zsh', ['.venv/bin/activate'], '. ./.venv/bin/activate');
check('/repo', '/usr/bin/fish', ['venv/bin/activate.fish'], 'source ./venv/bin/activate.fish');
check('/repo', '/bin/bash', ['.venv/bin/activate', 'venv/bin/activate'], '. ./.venv/bin/activate');
check('/repo', 'C:\\Program Files\\Git\\bin\\bash.exe', ['.venv/Scripts/activate'], '. ./.venv/Scripts/activate');
check('/repo', '/bin/bash', [], null);
check('/repo', '', ['.venv/Scripts/Activate.ps1'], "& './.venv/Scripts/Activate.ps1'", 'win32');
check('/repo', '', ['.venv/bin/activate'], '. ./.venv/bin/activate', 'linux');

console.log('venv tests passed');
