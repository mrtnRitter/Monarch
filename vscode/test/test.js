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

// --- session with fake awork ---
class FakeAwork {
    constructor() {
        Object.assign(this, { threads: {}, uploads: [], cancelled: [], next: 1, usage_error: null, outputs: {}, blocked: new Set(), downloads: [] });
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
            Object.assign(this.outputs, reply.contents || {});
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
    // output files of the replies (reply.contents), by the path in the downloadUrl
    async download(download_url) {
        const path = new URL(download_url, 'https://api.test').searchParams.get('path');
        this.downloads.push(path);
        if (this.blocked.has(path) || !(path in this.outputs)) throw Object.assign(new Error(`403 ${path}`), { status: 403 });
        return Buffer.from(this.outputs[path]);
    }
    async thread(thread_id) {
        if (this.usage_error) throw new Error(this.usage_error);
        return { id: thread_id, usage: { creditsUsed: 10 } };
    }
}

function make_store(initial_state) {
    let saved = initial_state ? JSON.parse(JSON.stringify(initial_state)) : undefined;
    return {
        load: () => saved ? JSON.parse(JSON.stringify(saved)) : undefined,
        save: state => { saved = JSON.parse(JSON.stringify(state)); },
    };
}

function make_session(fake, reply, limits = {}, store = make_store()) {
    fake.reply = reply;
    const written = {};
    const events = [];
    const session = new ChatSession({
        client: fake,
        agent: { name: 'Mastazilla', agentId: 'master', coAgentId: 'mini', coAgentName: 'minizilla' },
        limits: { maxCredits: 0, maxCoAgents: 3, maxRounds: 20, relayTimeout: 0, pollInterval: 0, ...limits },
        store,
        workspace: {
            write: async (path, data) => { written[path] = Buffer.from(data).toString('utf8'); return path; },
            read: async path => { if (!(path in (fake.repo || {}))) throw new Error('missing'); return Buffer.from(fake.repo[path]); },
        },
        ui: { message: item => events.push(item), info: text => events.push({ role: 'info', text }), status: () => {} },
        sleep: async () => {},
    });
    return { session, written, events, store };
}

const mini_answer = (status, with_file = false) => ({ content: `STATUS: ${status}\nNOTES: x`, files: with_file ? [out('hello.py')] : [], contents: with_file ? { 'hello.py': 'print("a")\n' } : {} });

test('session: output files are downloaded and written, failures warned, uploads and caches skipped', async () => {
    const fake = new FakeAwork();
    fake.blocked.add('package.json');
    const lines = [];
    require('../src/log').set_log(line => lines.push(line));
    const { session, written, events } = make_session(fake, () => ({
        content: 'Fertig.',
        files: [out('src/a.py'), out('package.json'), out('__pycache__/x.pyc'), { id: '/workspace/output/../evil.py', name: 'evil.py' }, { id: '/workspace/output/nolink.txt', name: 'nolink.txt' }, { name: 'up.txt', sandboxPath: 'context/uploads/up.txt' }],
        contents: { 'src/a.py': 'A = 1\n', '__pycache__/x.pyc': 'junk' },
    }));
    try {
        await session.send('go');
    } finally {
        require('../src/log').set_log(null);
    }
    assert.deepEqual(written, { 'src/a.py': 'A = 1\n' });
    const answer = events.find(item => item.role === 'agent');
    assert.deepEqual(answer.files, [{ path: 'src/a.py' }]);
    assert.deepEqual(answer.warnings, ['package.json not downloaded (HTTP 403)', '../evil.py not written (unsafe path)', 'nolink.txt not downloaded (no download link)']);
    assert.deepEqual(fake.downloads, ['src/a.py', 'package.json']);
    assert.ok(lines.some(line => line.endsWith('download src/a.py: ok')), lines.join('\n'));
});

test('session: write error is warned', async () => {
    const fake = new FakeAwork();
    const { session, events } = make_session(fake, () => ({ content: 'ok', files: [out('a.txt')], contents: { 'a.txt': 'A' } }));
    session.workspace.write = async () => { throw new Error('read-only'); };
    await session.send('go');
    assert.deepEqual(events.find(item => item.role === 'agent').warnings, ['a.txt not written (read-only)']);
});

test('relay: mini files staged, attached by co-agent id, committed after review, own files written directly', async () => {
    const fake = new FakeAwork();
    fake.repo = { 'docs/brief.txt': 'input\n' };
    fake.blocked.add('blocked.txt');
    let master_turn = 0;
    const { session, written, events } = make_session(fake, (thread_id, message) => {
        if (fake.threads[thread_id].agent_id === 'mini') {
            if (message.content.startsWith('Review')) return { content: 'VERDICT: pass', files: [out('hello.py')], contents: { 'hello.py': 'print("b")\n' } };
            return message.content.includes('A') ? { ...mini_answer('done', true), files: [out('hello.py'), out('blocked.txt')] } : mini_answer('done');
        }
        master_turn += 1;
        if (master_turn === 1) return { content: 'Los gehts.\n### ORCA: spawn\nTask A\nATTACH: docs/brief.txt\n### ORCA: spawn\nTask B' };
        if (master_turn === 2) {
            assert.ok(message.content.startsWith('[monarch relay]'));
            assert.match(message.content, /## minizilla_1 \(answered\)/);
            assert.match(message.content, /## minizilla_2 \(answered\)/);
            assert.match(message.content, /files \(staged, not in the repo yet\): hello\.py/);
            assert.match(message.content, /warning: blocked\.txt not downloaded \(HTTP 403\)/);
            assert.match(message.content, /ok: spawn minizilla_1/);
            assert.equal(message.attachments.length, 0);
            assert.deepEqual(written, {});
            return { content: '### ORCA: spawn\nReview\nATTACH: minizilla_1' };
        }
        assert.match(message.content, /## minizilla_3 \(answered\)/);
        return { content: 'Fertig.\n### ORCA: commit\n### ORCA: stopzilla', files: [out('notes.md')], contents: { 'notes.md': 'N' } };
    });
    await session.send('Bau was');
    assert.equal(master_turn, 3);
    // reviewer version wins, own file of the agent written directly
    assert.deepEqual(written, { 'hello.py': 'print("b")\n', 'notes.md': 'N' });
    assert.deepEqual(session.state.staged, {});
    const mini_threads = Object.values(fake.threads).filter(thread => thread.agent_id === 'mini');
    assert.equal(mini_threads[0].messages[0].content, 'Task A\n\nAttached files (relative to repo root): docs/brief.txt');
    assert.equal(mini_threads[2].messages[0].content, 'Review\n\nAttached files (relative to repo root): hello.py');
    assert.ok(fake.uploads.some(item => item.name === 'brief.txt' && item.data === 'input\n'));
    assert.ok(fake.uploads.some(item => item.name === 'hello.py' && item.data === 'print("a")\n'));
    assert.ok(events.some(item => item.role === 'warning' && item.text === 'minizilla_1: blocked.txt not downloaded (HTTP 403)'));
    assert.ok(events.some(item => item.role === 'info' && /^ok: commit: 1 files written \(hello\.py\)$/.test(item.text)), JSON.stringify(events));
    assert.equal(session.status().co_agents, 0);
});

test('relay: staged files survive a reload (downloaded again), commit errors keep them staged', async () => {
    const fake = new FakeAwork();
    const store = make_store({ thread_id: null, staged: { 'a.py': { from: 'minizilla_1', url: '/agents/threads/x/artifacts/download?path=a.py' } }, co_agents: { minizilla_1: { thread_id: 'old', state: 'answered', message_id: 'm', relayed: 'm' } }, next_index: 2 });
    fake.outputs['a.py'] = 'A';
    let turn = 0;
    const { session, written } = make_session(fake, (thread_id, message) => {
        if (fake.threads[thread_id].agent_id === 'mini') return mini_answer('done');
        turn += 1;
        return { content: turn === 1 ? '### ORCA: commit' : 'ok' };
    }, {}, store);
    session.workspace.write = async () => { throw new Error('locked'); };
    await session.send('commit');
    assert.deepEqual(Object.keys(session.state.staged), ['a.py']);
    session.workspace.write = async (path, data) => { written[path] = Buffer.from(data).toString('utf8'); return path; };
    turn = 0;
    await session.send('again');
    assert.deepEqual(written, { 'a.py': 'A' });
    assert.deepEqual(fake.downloads, ['a.py']);
    assert.deepEqual(session.state.staged, {});
});

test('relay: ATTACH of a co-agent without staged files is refused', async () => {
    const fake = new FakeAwork();
    let turn = 0;
    const { session, events } = make_session(fake, (thread_id, message) => {
        turn += 1;
        if (turn === 1) return { content: '### ORCA: spawn\nReview\nATTACH: minizilla_9' };
        return { content: 'ok' };
    });
    session.state.co_agents.minizilla_9 = { thread_id: 'x', state: 'answered', message_id: 'm', relayed: 'm' };
    await session.send('go');
    assert.ok(events.some(item => item.role === 'info' && item.text === 'refused: spawn: no staged files of minizilla_9'), JSON.stringify(events));
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
    assert.equal(online, '[monarch context] "this repo" = the repo open in VS Code: r · online: https://github.com/o/r · branch: dev · local state differs from online (uncommitted changes, commits not pushed); ask for attachments if needed · files: save them in /workspace/output/ with their repo path, monarch downloads them');
    assert.match(repo.context_line({ folder: 'r', git: false }), / · files: save them in \/workspace\/output\/ with their repo path, monarch downloads them$/);
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
    assert.deepEqual(agents.map(agent => [agent.name, agent.coAgentId, agent.labels.coAgents, agent.labels.stop, agent.has_image]), [['CodeZilla', '', 'Co-Agenten', 'Halt', false], ['Mastazilla', 'mini', 'Minizillas', 'Stop', true]]);
    const credit_agent = merge_agents([{ id: 'credit', name: 'CreditZilla' }], [{ name: 'CreditZilla', labels: { credits: 'X' } }])[0];
    assert.equal(credit_agent.labels.chat, 'X');
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


test('session: adjustable limits use effective values and persist per chat', () => {
    const fake = new FakeAwork();
    const limits = { maxCredits: 250, maxCoAgents: 2, creditStep: 50 };
    const { session, store } = make_session(fake, () => ({ content: 'ok' }), limits);
    assert.equal(session.max_credits(), 250);
    assert.equal(session.max_co_agents(), 2);
    assert.equal(session.adjust_credits(1), true);
    assert.equal(session.adjust_co_agents(1), true);
    assert.equal(session.max_credits(), 300);
    assert.equal(session.max_co_agents(), 3);
    assert.equal(store.load().extra_credits, 50);
    assert.equal(store.load().extra_co_agents, 1);

    const restored = make_session(fake, () => ({ content: 'ok' }), limits, store).session;
    assert.equal(restored.max_credits(), 300);
    assert.equal(restored.max_co_agents(), 3);
    const old_state = make_session(fake, () => ({ content: 'ok' }), limits, make_store({ thread_id: 'old' })).session;
    assert.equal(old_state.state.extra_credits, 0);
    assert.equal(old_state.state.extra_co_agents, 0);
    restored.new_chat();
    assert.equal(restored.max_credits(), 250);
    assert.equal(restored.max_co_agents(), 2);
});

test('session: adjustments honor usage, active co-agents, minimums and no-limit settings', () => {
    const fake = new FakeAwork();
    const { session } = make_session(fake, () => ({ content: 'ok' }), { maxCredits: 250, maxCoAgents: 4, creditStep: 100 });
    session.busy = true;
    assert.equal(session.adjust_credits(-1), true);
    assert.equal(session.max_credits(), 150);
    assert.equal(session.state.extra_credits, -100);
    session.credits = 60;
    assert.equal(session.adjust_credits(-1), false);
    session.credits = 0;
    assert.equal(session.adjust_credits(-1), true);
    assert.equal(session.max_credits(), 50);
    assert.equal(session.adjust_credits(-1), false);
    assert.equal(session.adjust_credits(1), true);

    session.state.co_agents = {
        active_a: { state: 'working' }, active_b: { state: 'finished' }, cancelled: { state: 'cancelled' },
    };
    assert.equal(session.adjust_co_agents(-1), true);
    assert.equal(session.max_co_agents(), 3);
    assert.equal(session.adjust_co_agents(-1), true);
    assert.equal(session.max_co_agents(), 2);
    assert.equal(session.adjust_co_agents(-1), false);
    session.state.co_agents = {};
    assert.equal(session.adjust_co_agents(-1), true);
    assert.equal(session.max_co_agents(), 1);
    assert.equal(session.adjust_co_agents(-1), false);

    const no_limits = make_session(fake, () => ({ content: 'ok' }), { maxCredits: 0, maxCoAgents: 0 }).session;
    assert.equal(no_limits.adjust_credits(1), false);
    assert.equal(no_limits.adjust_co_agents(1), false);
    assert.equal(no_limits.state.extra_credits, 0);
    assert.equal(no_limits.state.extra_co_agents, 0);
});

test('session: status exposes adjustment controls and effective limits', () => {
    const fake = new FakeAwork();
    const { session } = make_session(fake, () => ({ content: 'ok' }), { maxCredits: 300, maxCoAgents: 3 });
    session.credits = 100;
    session.state.co_agents = { active: { state: 'working' }, cancelled: { state: 'cancelled' } };
    assert.deepEqual(
        (({ max_credits, credit_step, can_less_credits, can_more_credits, max_co_agents, can_less_co_agents, can_more_co_agents }) => ({
            max_credits, credit_step, can_less_credits, can_more_credits, max_co_agents, can_less_co_agents, can_more_co_agents,
        }))(session.status()),
        { max_credits: 300, credit_step: 100, can_less_credits: true, can_more_credits: true, max_co_agents: 3, can_less_co_agents: true, can_more_co_agents: true },
    );
    session.limits.creditStep = 0;
    assert.equal(session.status().credit_step, 100);
    const no_limits = make_session(fake, () => ({ content: 'ok' }), { maxCredits: 0, maxCoAgents: 0 }).session.status();
    assert.equal(no_limits.can_less_credits, false);
    assert.equal(no_limits.can_more_credits, false);
    assert.equal(no_limits.can_less_co_agents, false);
    assert.equal(no_limits.can_more_co_agents, false);
});

test('session: increased co-agent limit permits another spawn', async () => {
    const fake = new FakeAwork();
    const { session } = make_session(fake, () => ({ content: 'ok' }), { maxCoAgents: 1 });
    session.state.co_agents.existing = { state: 'working', thread_id: 'existing' };
    const command = { action: 'spawn', target: null, body: 'Do a task.' };
    assert.equal((await session._execute(command)).ok, false);
    assert.equal(session.adjust_co_agents(1), true);
    assert.equal((await session._execute(command)).ok, true);
    assert.equal(session.status().co_agents, 2);
});

test('session: budget and relay status use the effective credit limit', async () => {
    const fake = new FakeAwork();
    const { session } = make_session(fake, () => ({ content: 'ok' }), { maxCredits: 100, creditStep: 100 });
    session.state.thread_id = 'budget-thread';
    fake.thread = async id => ({ id, usage: { creditsUsed: 150 } });
    assert.equal(session.adjust_credits(1), true);
    await session._check_budget(true);
    assert.equal(session.credits, 150);
    assert.equal(session._limit_error(false), null);
    assert.match(session._status_text([], false), /credits: 150\/200/);
});

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
