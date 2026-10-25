'use strict';
/** monarch VS Code extension: chat window for awork agents with co-agent relay. */
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { AworkClient, AworkError, OAuth } = require('./awork');
const { ChatView } = require('./chat_view');
const { run_probe } = require('./probe');
const { set_log } = require('./log');

function _config() {
    return vscode.workspace.getConfiguration('monarch');
}

function activate(context) {
    const channel = vscode.window.createOutputChannel?.('monarch');
    if (channel) {
        context.subscriptions.push(channel);
        set_log(line => channel.appendLine(line));
    }
    const oauth = new OAuth({
        settings: () => ({ base_url: _config().get('apiBaseUrl'), client_id: _config().get('clientId'), redirect_port: _config().get('redirectPort') }),
        secrets: context.secrets,
    });
    const client = new AworkClient({ base_url: () => _config().get('apiBaseUrl'), get_token: () => oauth.access_token() });
    const key_client = new AworkClient({
        base_url: () => _config().get('apiBaseUrl'),
        get_token: async () => {
            const key = await context.secrets.get('monarch.apiKey');
            if (!key) throw new AworkError('No API key set. Ctrl+click Month to enter it.', 0);
            return key;
        },
    });
    let probe_channel = null;
    const view = new ChatView(context, client, oauth, key_client, context.secrets);
    const run = action => async () => {
        try {
            await action();
        } catch (error) {
            vscode.window.showErrorMessage(`monarch: ${error.message}`);
        }
    };
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('monarch.chat', view, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand('monarch.signIn', run(async () => {
            await oauth.login(url => vscode.env.openExternal(vscode.Uri.parse(url, true)));
            vscode.window.showInformationMessage('monarch: signed in.');
            view.forget_user();
            await view.refresh();
        })),
        vscode.commands.registerCommand('monarch.setApiKey', run(() => view.set_api_key())),
        vscode.commands.registerCommand('monarch.signOut', run(async () => {
            await oauth.logout();
            view.forget_user();
            await view.refresh();
        })),
        vscode.commands.registerCommand('monarch.newChat', run(() => view.new_chat())),
        vscode.commands.registerCommand('monarch.stop', run(() => view.stop())),
        vscode.commands.registerCommand('monarch.probeDownload', run(async () => {
            const thread_id = (await vscode.window.showInputBox({ prompt: 'monarch probe: thread ID', value: 'd3dda243-668e-4098-8bdf-4344927bceeb' }) || '').trim();
            if (!thread_id) return;
            probe_channel ||= vscode.window.createOutputChannel('monarch probe');
            probe_channel.show(true);
            const { ok, total } = await run_probe(client, thread_id, path.join(os.tmpdir(), 'monarch-probe', thread_id), line => probe_channel.appendLine(line));
            vscode.window.showInformationMessage(`monarch probe: ${ok}/${total} downloads ok`);
        })),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('monarch.agents') || event.affectsConfiguration('monarch.agentFilter')) view.refresh({ reload_agents: true });
        }),
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
