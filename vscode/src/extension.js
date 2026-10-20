'use strict';
/** monarch VS Code extension: chat window for awork agents with co-agent relay. */
const vscode = require('vscode');
const { AworkClient, OAuth } = require('./awork');
const { ChatView } = require('./chat_view');
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
    const view = new ChatView(context, client, oauth);
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
        vscode.commands.registerCommand('monarch.signOut', run(async () => {
            await oauth.logout();
            view.forget_user();
            await view.refresh();
        })),
        vscode.commands.registerCommand('monarch.newChat', run(() => view.new_chat())),
        vscode.commands.registerCommand('monarch.stop', run(() => view.stop())),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('monarch.agents') || event.affectsConfiguration('monarch.agentFilter')) view.refresh({ reload_agents: true });
        }),
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
