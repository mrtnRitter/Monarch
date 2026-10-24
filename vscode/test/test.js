'use strict';
// Local tests without VS Code and without network (fake awork API). Run: node test/test.js
const assert = require('assert/strict');
const http = require('http');
const zlib = require('zlib');
const files = require('../src/files');
const { parse_commands } = require('../src/orca');
const { create_zip } = require('../src/zip');
const { AworkClient, OAuth } = require('../src/awork');
const { ChatSession } = require('../src/session');
const { collect_transfers } = require('../src/transfer');
const repo = require('../src/repo');
const { render_markdown } = require('../media/markdown');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = path => ({ name: path.split('/').pop(), sandboxPath: `/workspace/output/${path}`, downloadUrl: `/agents/threads/x/artifacts/download?path=${path}` });

// --- files ---
test('safe paths and junk', () => {
    assert.equal(files.safe_rel_path('./src\\a.py'), 'src/a.py');
    for (const bad of ['/etc/x', 'C:/x', '../x', 'a/../../x', '.git/config', '']) assert.equal(files.safe_rel_path(bad), null, bad);
    assert.ok(files.is_junk('x/__pycache__/a.cpython-312.pyc'));
    assert.equal(files.output_rel_path({ id: '/workspace/output/src/a.py', name: 'a.py' }), 'src/a.py');
    assert.equal(files.basename('src\\sub/a.py'), 'a.py');
    assert.equal(files.clean_text('a <!-- hidden --> b'), 'a  b');
    assert.equal(files.output_path({ name: 'a.py', sandboxPath: 'context/uploads/a.py' }), null);
});

// --- orca ---
test('ORCA commands: text, bodies, headers inside fences ignored', () => {
    const text = 'Plan steht.\n\n### ORCA: spawn\nBaue x.\n```md\n### ORCA: stopzilla\n```\n### ORCA: send minizilla_2\nKorrektur\n### ORCA: wait';
    const { text: visible, commands } = parse_commands(text);
    assert.equal(visible, 'Plan steht.');
    assert.deepEqual(commands.map(command => [command.action, command.target]), [['spawn', null], ['send', 'minizilla_2'], ['wait', null]]);
    assert.equal(commands[0].body, 'Baue x.\n```md\n### ORCA: stopzilla\n```');
});

// --- zip ---
test('zip: readable entry with UTF-8 name', () => {
    const data = Buffer.from('hallo äöü '.repeat(50));
    const zip = create_zip([{ name: 'src/ü.txt', data }]);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    const name_length = zip.readUInt16LE(26);
    assert.equal(zip.subarray(30, 30 + name_length).toString('utf8'), 'src/ü.txt');
    const body = zip.subarray(30 + name_length, 30 + name_length + zip.readUInt32LE(18));
    assert.deepEqual(zlib.inflateRawSync(body), data);
    require('fs').writeFileSync(require('path').join(__dirname, 'out_test.zip'), create_zip([{ name: 'f/a.txt', data: Buffer.from('a') }, { name: 'f/sub/b.bin', data: Buffer.from([0, 1, 2]) }]));
});

// --- OAuth ---
const memory_secrets = () => { const store = new Map(); return { get: async key => store.get(key), store: async (key, value) => { store.set(key, value); }, delete: async key => { store.delete(key); }, store_map: store }; };

test('OAuth: login via local callback, refresh rotates token', async () => {
    const calls = [];
    const fake_fetch = async (url, options) => {
        const body = new URLSearchParams(options.body);
        calls.push(Object.fromEntries(body));
        const n = calls.length;
        return { ok: true, status: 200, json: async () => ({ access_token: `access_${n}`, refresh_token: `refresh_${n}`, expires_in: n === 1 ? 1 : 86400 }) };
    };
    const secrets = memory_secrets();
    const oauth = new OAuth({ settings: () => ({ base_url: 'https://api.awork.com/api/v1', client_id: 'client', redirect_port: 18765 }), secrets, fetch_impl: fake_fetch });
    await oauth.login(async url => {
        const params = new URL(url).searchParams;
        assert.equal(params.get('redirect_uri'), 'http://localhost:18765/callback');
        assert.equal(params.get('code_challenge_method'), 'S256');
        await new Promise((resolve, reject) => http.get(`http://localhost:18765/callback?code=abc&state=${params.get('state')}`, response => { response.resume(); response.on('end', resolve); }).on('error', reject));
    });
    assert.equal(calls[0].grant_type, 'authorization_code');
    assert.equal(calls[0].code, 'abc');
    assert.ok(calls[0].code_verifier.length >= 43);
    // first token expires immediately -> refresh, concurrent calls share one refresh
    const [first, second] = await Promise.all([oauth.access_token(), oauth.access_token()]);
    assert.equal(first, 'access_2');
    assert.equal(second, 'access_2');
    assert.equal(calls.length, 2);
    assert.deepEqual([calls[1].grant_type, calls[1].refresh_token], ['refresh_token', 'refresh_1']);
    assert.equal(JSON.parse(secrets.store_map.get('monarch.oauth')).refresh_token, 'refresh_2');
});

test('client: base path, model options in the message body', async () => {
    const seen = [];
    const fake_fetch = async (url, options) => {
        seen.push({ url, body: options.body ? JSON.parse(options.body) : null, auth: options.headers.Authorization });
        return { ok: true, status: 200, text: async () => '{"acceptedMessageId":"m1"}' };
    };
    const client = new AworkClient({ base_url: () => 'https://api.awork.com/api/v1', get_token: async () => 'user', fetch_impl: fake_fetch });
    seen.length = 1;
    await client.send_message('t', 'hi', [], { modelProvider: 'anthropic', modelName: 'claude', reasoningLevel: 'high' });
    assert.deepEqual(seen[1].body, { content: 'hi', modelProvider: 'anthropic', modelName: 'claude', reasoningLevel: 'high' });
    assert.equal(seen[1].auth, 'Bearer user');
    await client.agent_defaults('a1');
    assert.equal(seen[2].url, 'https://api.awork.com/api/v1/agents/defaults?type=custom-agent&agentId=a1');
});

// --- transfer (format of skills/monarch-transfer/pack.py) ---
const transfer_lines = (path, data, size = 20) => {
    const packed = zlib.gzipSync(data).toString('base64url');
    const chunks = packed.match(new RegExp(`.{1,${size}}`, 'g'));
    const head = `MONARCH-FILE v1 path=${Buffer.from(path).toString('base64url')} sha256=${require('crypto').createHash('sha256').update(data).digest('hex')}`;
    return chunks.map((chunk, index) => `${head} part=${index + 1}of${chunks.length} data=${chunk}`);
};

test('transfer: parts from several tool results, escaped results, last complete version, failures', () => {
    const binary = Buffer.from([0, 255, 43, 47, 10, 13]);
    const lines = transfer_lines('src/ü x.bin', binary);
    // stored like awork: JSON with escaped "+" and newlines
    const stored = text => JSON.stringify({ data: text }).replace(/\+/g, '\\u002B');
    const old = transfer_lines('a.py', Buffer.from('old'));
    const messages = [
        { role: 'agent', content: transfer_lines('in/answer.txt', Buffer.from('ignored'))[0], toolCalls: [{ response: stored(lines.slice(0, 2).join('\n')) }, { response: old.join('\n') }] },
        { role: 'tool', toolCalls: [{ response: stored(lines.slice(2).join('\n')) }, { response: transfer_lines('a.py', Buffer.from('new')).join('\n') }, { response: { data: transfer_lines('b.md', Buffer.from('B')).join('\n') } }] },
        { role: 'agent', toolCalls: [{ response: transfer_lines('c.txt', Buffer.from('long enough text for parts')).slice(1).join('\n') }, { response: transfer_lines('d.txt', Buffer.from('D')).join('\n').replace(/sha256=\w{64}/g, `sha256=${'0'.repeat(64)}`) }] },
    ];
    const { files: got, failed } = collect_transfers(messages, 1024);
    assert.deepEqual(got.map(file => [file.path, file.data.toString('latin1')]), [['src/ü x.bin', binary.toString('latin1')], ['a.py', 'new'], ['b.md', 'B']]);
    assert.deepEqual(failed.map(item => [item.path, item.reason.replace(/\d+\/\d+/, 'n/m')]), [['c.txt', 'transfer incomplete (n/m parts)'], ['d.txt', 'checksum mismatch']]);
    assert.match(collect_transfers(messages, 2).failed[0].reason, /larger than 2 bytes/);
    assert.deepEqual(collect_transfers([{ toolCalls: [{ toolName: 'load_skill', response: 'x' }] }, { content: 'no tools' }], 1).tools, ['load_skill']);
});

// --- session with fake awork ---
class FakeAwork {
    constructor() {
        Object.assign(this, { threads: {}, uploads: [], cancelled: [], next: 1, usage_error: null });
    }
    _thread(agent_id) {
        const id = `t${this.next++}`;
        this.threads[id] = { agent_id, messages: [], pending: null };
        return id;
    }
    _user(thread_id, content, attachments) {
        const thread = this.threads[thread_id];
        const id = `m${this.next++}`;
        thread.messages.push({ id, role: 'user', content, attachments, messageOrder: thread.messages.length });
        thread.pending = { id, polls: 0 };
        return id;
    }
    async create_thread(agent_id, content, title, attachments, options) {
        const id = this._thread(agent_id);
        Object.assign(this.threads[id], { title, options: [options] });
        return { id, acceptedMessageId: this._user(id, content, attachments) };
    }
    async send_message(thread_id, content, attachments, options) {
        this.threads[thread_id].options.push(options);
        return { acceptedMessageId: this._user(thread_id, content, attachments) };
    }
    async message_status(thread_id, message_id) {
        const thread = this.threads[thread_id];
        if (thread.pending?.id === message_id) {
            if (++thread.pending.polls < (thread.delay || 1)) return { status: 'running' };
            const reply = this.reply(thread_id, thread.messages.at(-1));
            thread.messages.push({ id: `a${this.next++}`, role: 'agent', content: reply.content, temporaryFiles: reply.files || [], toolCalls: reply.toolCalls || null, messageOrder: thread.messages.length });
            thread.pending = null;
        }
        return { status: 'completed', hasAgentResponse: true };
    }
    async messages(thread_id) {
        return this.threads[thread_id].messages;
    }
    async cancel(thread_id) {
        this.cancelled.push(thread_id);
    }
    async upload_temporary_file(name, data) {
        this.uploads.push({ name, data: Buffer.from(data).toString('utf8') });
        return `tmp${this.uploads.length}`;
    }
    async thread(thread_id) {
        if (this.usage_error) throw new Error(this.usage_error);
        return { id: thread_id, usage: { creditsUsed: 10 } };
    }
}

function make_session(fake, reply, limits = {}) {
    fake.reply = reply;
    const written = {};
    const events = [];
    const session = new ChatSession({
        client: fake,
        agent: { name: 'Mastazilla', agentId: 'master', coAgentId: 'mini', coAgentName: 'minizilla' },
        limits: { maxCredits: 0, maxCoAgents: 3, maxRounds: 20, relayTimeout: 0, pollInterval: 0, ...limits },
        store: { load: () => undefined, save: () => {} },
        workspace: {
            write: async (path, data) => { written[path] = Buffer.from(data).toString('utf8'); return path; },
            read: async path => { if (!(path in (fake.repo || {}))) throw new Error('missing'); return Buffer.from(fake.repo[path]); },
        },
        ui: { message: item => events.push(item), info: text => events.push({ role: 'info', text }), status: () => {} },
        sleep: async () => {},
    });
    return { session, written, events };
}

const mini_answer = (status, with_file = false) => ({ content: `STATUS: ${status}\nNOTES: x`, files: with_file ? [out('hello.py')] : [], toolCalls: with_file ? [{ toolName: 'code_mode_execute', response: transfer_lines('hello.py', Buffer.from('print("a")\n')).join('\n') }] : null });

test('session: files saved in output but not transferred are reported, nothing is downloaded', async () => {
    const fake = new FakeAwork();
    const lines = [];
    require('../src/log').set_log(line => lines.push(line));
    const { session, written, events } = make_session(fake, () => ({ content: 'Fertig.', files: [out('c.txt'), { name: 'up.txt', sandboxPath: 'context/uploads/up.txt' }] }));
    try {
        await session.send('go');
    } finally {
        require('../src/log').set_log(null);
    }
    assert.deepEqual(written, {});
    assert.deepEqual(events.find(item => item.role === 'agent').warnings, ['c.txt not transferred']);
    assert.ok(lines.some(line => line.endsWith('transfer: no MONARCH-FILE lines in 0 tool results')), lines.join('\n'));
    assert.ok(lines.some(line => line.endsWith('transfer c.txt: saved in output/ but not transferred')), lines.join('\n'));
});

test('session: transferred files are written, unsafe paths refused', async () => {
    const fake = new FakeAwork();
    const response = [...transfer_lines('src/a.py', Buffer.from('A = 1\n')), ...transfer_lines('../x.py', Buffer.from('bad'))].join('\n');
    const { session, written, events } = make_session(fake, () => ({ content: 'Fertig.', files: [out('src/a.py')], toolCalls: [{ id: 'c1', toolName: 'code_mode_execute', response }] }));
    await session.send('go');
    assert.deepEqual(written, { 'src/a.py': 'A = 1\n' });
    assert.deepEqual(events.find(item => item.role === 'agent').warnings, ['../x.py not written (unsafe path)']);
});

test('relay: spawn two, attach repo files, forward transferred files, write transferred final file', async () => {
    const fake = new FakeAwork();
    fake.repo = { 'docs/brief.txt': 'input\n' };
    let master_turn = 0;
    const { session, written, events } = make_session(fake, (thread_id, message) => {
        if (fake.threads[thread_id].agent_id === 'mini') return mini_answer('done', message.content.includes('A'));
        master_turn += 1;
        if (master_turn === 1) return { content: 'Los gehts.\n### ORCA: spawn\nTask A\nATTACH: docs/brief.txt\n### ORCA: spawn\nTask B' };
        assert.ok(message.content.startsWith('[monarch relay]'));
        assert.match(message.content, /## minizilla_1 \(answered\)/);
        assert.match(message.content, /## minizilla_2 \(answered\)/);
        assert.match(message.content, /attached: hello\.py/);
        assert.match(message.content, /ok: spawn minizilla_1/);
        assert.equal(message.attachments.length, 1);
        return { content: 'Fertig.\n### ORCA: stopzilla', files: [out('src/final.py'), out('notes.md'), out('__pycache__/x.pyc')], toolCalls: [{ toolName: 'code_mode_execute', response: transfer_lines('src/final.py', Buffer.from('X = 1\n')).join('\n') }] };
    });
    await session.send('Bau was');
    assert.equal(master_turn, 2);
    assert.deepEqual(written, { 'src/final.py': 'X = 1\n' });
    const last_answer = events.filter(item => item.role === 'agent').at(-1);
    assert.deepEqual(last_answer.files, [{ path: 'src/final.py' }]);
    assert.deepEqual(last_answer.warnings, ['notes.md not transferred']);
    const mini_threads = Object.values(fake.threads).filter(thread => thread.agent_id === 'mini');
    assert.equal(mini_threads[0].messages[0].attachments.length, 1);
    assert.equal(mini_threads[0].messages[0].content, 'Task A\n\nAttached files (relative to repo root): docs/brief.txt');
    assert.ok(fake.uploads.some(item => item.name === 'brief.txt' && item.data === 'input\n'));
    assert.ok(fake.uploads.some(item => item.name === 'hello.py' && item.data === 'print("a")\n'));
    assert.equal(session.status().co_agents, 0);
    assert.equal(session.state.rounds, 0);
});

test('relay: question wakes the agent early, others keep working', async () => {
    const fake = new FakeAwork();
    let master_turn = 0;
    const { session } = make_session(fake, (thread_id, message) => {
        const thread = fake.threads[thread_id];
        if (thread.agent_id === 'mini') return message.content.includes('slow') ? mini_answer('done') : mini_answer('question');
        master_turn += 1;
        if (master_turn === 1) return { content: '### ORCA: spawn\nfast\n### ORCA: spawn\nslow' };
        assert.match(message.content, /minizilla_1 \(answered\)/);
        assert.match(message.content, /still working: minizilla_2/);
        return { content: 'Warte noch.' };
    });
    const original = fake.create_thread.bind(fake);
    fake.create_thread = async (...args) => {
        const result = await original(...args);
        if (args[1] === 'slow') fake.threads[result.id].delay = 1000;
        return result;
    };
    await session.send('go');
    assert.equal(master_turn, 2);
});

test('limits: maxCoAgents refused and reported immediately', async () => {
    const fake = new FakeAwork();
    let master_turn = 0;
    const { session } = make_session(fake, (thread_id, message) => {
        if (fake.threads[thread_id].agent_id === 'mini') return mini_answer('done');
        master_turn += 1;
        if (master_turn === 1) return { content: '### ORCA: spawn\na\n### ORCA: spawn\nb' };
        assert.match(message.content, /refused: spawn: maxCoAgents reached \(1\/1\)/);
        return { content: 'ok' };
    }, { maxCoAgents: 1 });
    await session.send('go');
    assert.equal(master_turn, 2);
});

test('budget: unreadable credits block the start, cap stops everything', async () => {
    const fake = new FakeAwork();
    fake.usage_error = 'forbidden';
    const { session } = make_session(fake, () => ({ content: 'x' }), { maxCredits: 100 });
    // a new chat has no thread yet, so the first message cannot be checked
    await session.send('go');
    await assert.rejects(session.send('again'), /Credits not readable/);
    fake.usage_error = null;
    let master_turn = 0;
    const capped = make_session(fake, (thread_id) => {
        if (fake.threads[thread_id].agent_id === 'mini') return mini_answer('done');
        master_turn += 1;
        return { content: '### ORCA: spawn\na' };
    }, { maxCredits: 25 });
    capped.session.credit_refresh_ms = 0;
    for (const thread of Object.values(fake.threads)) thread.delay = 3;
    const original = fake.create_thread.bind(fake);
    fake.create_thread = async (...args) => { const result = await original(...args); fake.threads[result.id].delay = 3; return result; };
    await capped.session.send('go');
    assert.ok(capped.events.some(item => item.role === 'info' && item.text.startsWith('stop (maxCredits reached')));
    assert.ok(fake.cancelled.length >= 1);
});

test('unsafe or missing ATTACH files refuse the command', async () => {
    const fake = new FakeAwork();
    let master_turn = 0;
    const { session } = make_session(fake, (thread_id, message) => {
        master_turn += 1;
        if (master_turn === 1) return { content: '### ORCA: spawn\nTask\nATTACH: ../secret.txt' };
        if (master_turn === 2) {
            assert.match(message.content, /refused: spawn: unsafe attachment path \.\.\/secret\.txt/);
            return { content: '### ORCA: spawn\nTask\nATTACH: `src/missing.py`' };
        }
        assert.match(message.content, /refused: spawn: attachment src\/missing\.py not readable \(missing\)/);
        return { content: 'ok' };
    });
    await session.send('go');
    assert.equal(master_turn, 3);
    assert.equal(Object.values(fake.threads).filter(thread => thread.agent_id === 'mini').length, 0);
});

test('markdown: tables, nested lists with code, quotes, rules, inline', () => {
    const html = render_markdown('## T\n\n**b** *i* `c **x**`\n\n- a\n  - b\n    ```py\n    x = 1\n    ```\n- c\n\n| A | B |\n|---|:-:|\n| 1 | 2 |\n\n> q\n\n---');
    assert.ok(html.startsWith('<h3>T</h3><p><strong>b</strong> <em>i</em> <code>c **x**</code></p>'));
    assert.ok(html.includes('<ul><li>a<ul><li>b<div class="code-block" data-lang="py"><div class="code-head"><span class="code-lang">py</span>'));
    assert.ok(html.includes('data-code-action="insert"') && html.includes('<pre><code>x = 1</code></pre></div></li></ul></li><li>c</li></ul>'));
    assert.ok(html.includes('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'));
    assert.ok(html.endsWith('<blockquote><p>q</p></blockquote><hr>'));
});

test('markdown: HTML is escaped, only http(s) links', () => {
    const html = render_markdown('<img src=x onerror=alert(1)> [a](https://x.de/?a=1&b=2) [b](javascript:alert(1)) <https://y.de>\n```\n<script>\n```');
    assert.ok(!html.includes('<img') && !html.includes('<script'));
    assert.ok(html.includes('<a href="https://x.de/?a=1&amp;b=2">a</a>'));
    assert.ok(!html.includes('href="javascript'));
    assert.ok(html.includes('<a href="https://y.de">https://y.de</a>'));
});

test('session: answer duration, phase in status, history durations', async () => {
    const fake = new FakeAwork();
    const statuses = [];
    const { session, events } = make_session(fake, () => ({ content: 'Hallo' }));
    session.ui.status = status => statuses.push(status);
    await session.send('Hi');
    assert.equal(typeof events.find(item => item.role === 'agent').duration_ms, 'number');
    assert.ok(statuses.some(status => status.phase === 'agent' && status.phase_since));
    assert.equal(statuses.at(-1).phase, null);
    const thread = fake.threads[session.state.thread_id];
    thread.messages[0].createdOn = '2026-10-20T10:00:00Z';
    thread.messages[1].createdOn = '2026-10-20T10:00:19Z';
    const history = await session.history();
    assert.deepEqual(history.map(item => [item.role, item.duration_ms ?? null]), [['user', null], ['agent', 19000]]);
});

test('session: model override per chat, title, load_state', async () => {
    const fake = new FakeAwork();
    const { session } = make_session(fake, () => ({ content: 'ok' }));
    session.set_model({ provider: 'anthropic', name: 'claude', reasoning: 'high' });
    await session.send('Erste Frage\nmehr Text');
    session.set_model(null);
    await session.send('Zweite');
    const thread = fake.threads[session.state.thread_id];
    assert.deepEqual(thread.options, [{ modelProvider: 'anthropic', modelName: 'claude', reasoningLevel: 'high' }, {}]);
    assert.equal(session.state.title, 'Erste Frage');
    session.set_model({ provider: 'openai', name: 'gpt', reasoning: null });
    assert.deepEqual(session._model_options(), { modelProvider: 'openai', modelName: 'gpt' });
    const saved = JSON.parse(JSON.stringify(session.state));
    session.new_chat();
    assert.equal(session.state.thread_id, null);
    assert.equal(session.state.model, null);
    session.load_state(saved);
    assert.equal(session.state.thread_id, saved.thread_id);
    assert.equal(session.status().model.name, 'gpt');
    assert.equal(session.credits, null);
    await session.refresh_credits();
    assert.equal(session.credits, 10);
});

// --- repo context ---
test('repo: remote links without credentials, local remotes ignored', () => {
    for (const url of ['https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@github.com:22/o/r', 'https://user:token@github.com/o/r/']) assert.equal(repo.remote_web_url(url), 'https://github.com/o/r', url);
    for (const url of ['/srv/git/r.git', 'file:///srv/r', 'C:\\repos\\r', '', null]) assert.equal(repo.remote_web_url(url), null, String(url));
});

test('repo: context line for online, not online, no git, no folder; strip for display', () => {
    const state = { HEAD: { name: 'dev', upstream: { remote: 'up' }, ahead: 2 }, remotes: [{ name: 'origin', fetchUrl: 'git@github.com:o/x.git' }, { name: 'up', fetchUrl: 'https://github.com/o/r.git' }], workingTreeChanges: [1], indexChanges: [1], untrackedChanges: [1] };
    assert.deepEqual(repo.git_info({ state }), { git: true, remote: 'https://github.com/o/r.git', branch: 'dev', changes: 3, ahead: 2 });
    assert.deepEqual(repo.git_info(null), { git: false });
    assert.deepEqual(repo.git_info(undefined), { git: null });
    const online = repo.context_line({ folder: 'r', ...repo.git_info({ state }) });
    assert.equal(online, '[monarch context] "this repo" = the repo open in VS Code: r · online: https://github.com/o/r · branch: dev · local state differs from online (uncommitted changes, commits not pushed); ask for attachments if needed');
    assert.equal(repo.context_line({ folder: 'r', ...repo.git_info({ state: { ...state, workingTreeChanges: [1, 2, 3, 4] } }) }), online);
    assert.match(repo.context_line({ folder: 'r', git: true, remote: 'https://github.com/o/r', branch: 'new', ahead: null }), /branch not pushed/);
    assert.match(repo.context_line({ folder: 'r', git: true, remote: null }), /not online \(no remote\); tell the user to push it first/);
    assert.match(repo.context_line({ folder: 'r', git: false }), /not a git repository, not online/);
    assert.match(repo.context_line({ folder: null }), /No folder is open/);
    assert.equal(repo.strip_context(`Hallo\n\n${online}`), 'Hallo');
    assert.equal(repo.strip_context('no [monarch context] inside a line stays'), 'no [monarch context] inside a line stays');
});

test('session: context is sent but not shown; question cards live and in history', async () => {
    const fake = new FakeAwork();
    const ask = { id: 'call1', toolName: 'ask_user_question', arguments: { question: 'Which way?', options: ['A', 'B'], allowCustomText: true } };
    const { session, events } = make_session(fake, () => ({ content: 'Plan ready.\n\nWhich way?', toolCalls: [ask] }));
    await session.send('Hallo', [], '[monarch context] x');
    const thread = Object.values(fake.threads)[0];
    assert.equal(thread.messages[0].content, 'Hallo\n\n[monarch context] x');
    assert.deepEqual(events.filter(item => item.role !== 'info').map(item => [item.role, item.text, item.options]), [['user', 'Hallo', undefined], ['agent', 'Plan ready.', undefined], ['question', 'Which way?', ['A', 'B']]]);
    assert.equal(events.at(-1).custom, true);
    thread.messages.push({ id: 'tool1', role: 'tool', content: '{}', toolCalls: [ask] }, { id: 'a9', role: 'agent', content: '', toolCalls: [{ id: 'call2', arguments: JSON.stringify({ question: 'Sure?', options: ['yes'] }) }, { id: 'call3', arguments: { question: 'no options' } }] });
    const history = await session.history();
    assert.deepEqual(history.map(item => [item.role, item.text]), [['user', 'Hallo'], ['agent', 'Plan ready.'], ['question', 'Which way?'], ['question', 'Sure?']]);
});

test('session: context line only on the first message and when it changes', async () => {
    const fake = new FakeAwork();
    const { session } = make_session(fake, () => ({ content: 'ok' }));
    await session.send('Hallo', [], '[monarch context] x');
    await session.send('Weiter', [], '[monarch context] x');
    await session.send('Anders', [], '[monarch context] y');
    const thread = fake.threads[session.state.thread_id];
    assert.deepEqual(thread.messages.filter(message => message.role === 'user').map(message => message.content), ['Hallo\n\n[monarch context] x', 'Weiter', 'Anders\n\n[monarch context] y']);
    assert.equal(session.state.context, '[monarch context] y');
    session.new_chat();
    await session.send('Neu', [], '[monarch context] y');
    assert.equal(fake.threads[session.state.thread_id].messages[0].content, 'Neu\n\n[monarch context] y');
});

test('session: has_updates detects messages written elsewhere', async () => {
    const fake = new FakeAwork();
    const { session } = make_session(fake, () => ({ content: 'ok' }));
    assert.equal(await session.has_updates(), false);
    await session.send('Hallo');
    assert.equal(await session.has_updates(), false);
    const thread = fake.threads[session.state.thread_id];
    thread.messages.push({ id: 'web1', role: 'user', content: 'from the web' });
    assert.equal(await session.has_updates(), true);
    await session.history();
    assert.equal(await session.has_updates(), false);
    thread.messages.at(-1).content += ' (edited while streaming)';
    session.busy = true;
    assert.equal(await session.has_updates(), false);
    session.busy = false;
    assert.equal(await session.has_updates(), true);
});

test('session: unknown final status and completed without response do not block the chat', async () => {
    const fake = new FakeAwork();
    const { session, events } = make_session(fake, () => ({ content: 'Antwort' }));
    const original = fake.message_status.bind(fake);
    fake.message_status = async (thread_id, message_id) => {
        const status = await original(thread_id, message_id);
        return status.status === 'completed' ? { status: 'awaiting_input', hasAgentResponse: true } : status;
    };
    await session.send('a');
    assert.equal(events.filter(item => item.role === 'agent').at(-1).text, 'Antwort');
    let polls = 0;
    fake.message_status = async (thread_id, message_id) => {
        polls += 1;
        await original(thread_id, message_id);
        return { status: 'completed', hasAgentResponse: false };
    };
    await session.send('b');
    assert.equal(polls, 10);
    assert.equal(session.busy, false);
});

test('session: stops waiting when the chat is continued elsewhere', async () => {
    const fake = new FakeAwork();
    const { session, events } = make_session(fake, () => ({ content: 'first' }), { syncInterval: 0.001 });
    await session.send('a');
    let polls = 0;
    fake.message_status = async () => {
        polls += 1;
        if (polls === 3) fake.threads[session.state.thread_id].messages.push({ id: 'web1', role: 'user', content: 'aus awork' });
        return { status: 'running' };
    };
    await session.send('b');
    assert.ok(events.some(item => item.role === 'info' && item.text.startsWith('chat continued in awork')));
    assert.equal(session.busy, false);
    assert.equal(await session.has_updates(), true);
});

test('agents and models: merge with overrides, hide co-agents, parse model catalog', () => {
    const { merge_agents, parse_models } = load_chat_view();
    const agents = merge_agents([
        { id: 'm', name: 'Mastazilla', hasImage: true }, { id: 'mini', name: 'minizilla' }, { id: 'c', name: 'CodeZilla' }, { id: 'old', name: 'Alt', isArchived: true },
    ], [{ agentId: 'm', coAgentId: 'mini', coAgentName: 'minizilla', labels: { coAgents: 'Minizillas' } }, { name: 'CodeZilla', labels: { stop: 'Halt' } }]);
    assert.deepEqual(agents.map(agent => [agent.name, agent.coAgentId, agent.labels.coAgents, agent.labels.stop, agent.has_image]), [['CodeZilla', '', 'Co-agents', 'Halt', false], ['Mastazilla', 'mini', 'Minizillas', 'Stop', true]]);
    const visible = [{ id: 'mine', name: 'Meiner', createdBy: 'me' }, { id: 'other', name: 'Fremd', createdBy: 'x' }, { id: 'm', name: 'Mastazilla', createdBy: 'x' }, { id: 'n', name: 'Named', createdBy: 'x' }];
    const overrides = [{ agentId: 'm', labels: {} }, { name: 'Named' }];
    assert.deepEqual(merge_agents(visible, overrides, { filter: 'own', me_id: 'me' }).map(agent => agent.name), ['Mastazilla', 'Meiner', 'Named']);
    assert.deepEqual(merge_agents(visible, overrides, { filter: 'all', me_id: 'me' }).map(agent => agent.name), ['Fremd', 'Mastazilla', 'Meiner', 'Named']);
    assert.deepEqual(merge_agents(visible, [], { filter: 'own', me_id: null }).map(agent => agent.name), []);
    const models = parse_models({ modelProvider: 'anthropic', modelName: 'opus', reasoningLevel: 'high', availableModels: { providers: [
        { provider: 'anthropic', displayName: 'Anthropic', modelDetails: [{ id: 'opus', displayName: 'Claude Opus', kind: 'text', status: 'active', isAvailable: true, supportedReasoningLevels: ['low', 'high', null], creditFactor: 3 }, { id: 'img', kind: 'image' }, { id: 'off', isAvailable: false }] },
    ] } });
    assert.deepEqual(models.default, { provider: 'anthropic', name: 'opus', reasoning: 'high' });
    assert.deepEqual(models.models, [{ provider: 'anthropic', provider_name: 'Anthropic', name: 'opus', display: 'Claude Opus', levels: ['low', 'high'], factor: 3 }]);
});

function load_chat_view() {
    const Module = require('module');
    const original = Module._load;
    Module._load = function (request, ...rest) { return request === 'vscode' ? {} : original.call(this, request, ...rest); };
    try {
        return require('../src/chat_view');
    } finally {
        Module._load = original;
    }
}

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`ok   ${name}`);
        } catch (error) {
            failed += 1;
            console.log(`FAIL ${name}\n${error.stack}`);
        }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
