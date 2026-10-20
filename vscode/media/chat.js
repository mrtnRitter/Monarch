// monarch chat webview: renders messages and status, forwards user actions to the extension.
(function () {
    const vscode = acquireVsCodeApi();
    const element = id => document.getElementById(id);
    const state = { agent: null, labels: { credits: 'Credits', coAgents: 'Co-agents', stop: 'Stop' }, busy: false };

    const escape_html = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const inline = text => escape_html(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');

    function render_markdown(source) {
        const out = [];
        let code = null;
        let list = null;
        const close_list = () => { if (list) { out.push(`</${list}>`); list = null; } };
        for (const line of source.split('\n')) {
            const fence = line.match(/^(`{3,}|~{3,})/);
            if (code) {
                if (fence && line.trim()[0] === code.fence[0] && /^(`+|~+)$/.test(line.trim()) && line.trim().length >= code.fence.length) {
                    out.push(`<pre><code>${escape_html(code.lines.join('\n'))}</code></pre>`);
                    code = null;
                } else code.lines.push(line);
                continue;
            }
            if (fence) { close_list(); code = { fence: fence[1], lines: [] }; continue; }
            const heading = line.match(/^(#{1,4})\s+(.*)/);
            if (heading) { close_list(); out.push(`<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`); continue; }
            const item = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)/);
            if (item) {
                const type = item[1] ? 'ol' : 'ul';
                if (list !== type) { close_list(); out.push(`<${type}>`); list = type; }
                out.push(`<li>${inline(item[2])}</li>`);
                continue;
            }
            close_list();
            if (line.trim()) out.push(`<p>${inline(line)}</p>`);
        }
        if (code) out.push(`<pre><code>${escape_html(code.lines.join('\n'))}</code></pre>`);
        close_list();
        return out.join('');
    }

    function add_message(item) {
        const box = document.createElement('div');
        box.className = `message ${item.role}`;
        box.innerHTML = item.role === 'info' ? escape_html(item.text) : render_markdown(item.text || '');
        for (const file of item.files || []) {
            const link = document.createElement('a');
            link.className = 'file';
            link.textContent = `${file.path} (${file.check})`;
            link.addEventListener('click', () => vscode.postMessage({ type: 'open_file', path: file.path }));
            box.appendChild(link);
        }
        for (const warning of item.warnings || []) {
            const line = document.createElement('div');
            line.className = 'warning';
            line.textContent = `warning: ${warning}`;
            box.appendChild(line);
        }
        element('messages').appendChild(box);
        box.scrollIntoView({ block: 'end' });
    }

    function show_status(status) {
        state.busy = status.busy;
        element('credits').textContent = `${state.labels.credits}: ${status.credits ?? '?'} / ${status.max_credits || '∞'}`;
        element('co_agents').textContent = `${state.labels.coAgents}: ${status.co_agents} / ${status.max_co_agents || '∞'}${status.working ? ` (${status.working} working)` : ''}`;
        element('stop').textContent = state.labels.stop;
        element('busy').classList.toggle('hidden', !status.busy);
        element('send').disabled = status.busy;
    }

    window.addEventListener('message', ({ data }) => {
        if (data.agent && data.agent !== state.agent) return;
        if (data.type === 'init') {
            Object.assign(state, { agent: data.current, labels: data.labels });
            element('agent').innerHTML = data.agents.map(name => `<option${name === data.current ? ' selected' : ''}>${escape_html(name)}</option>`).join('');
            element('signin').classList.toggle('hidden', data.signed_in);
            element('stop').textContent = data.labels.stop;
        } else if (data.type === 'history') {
            element('messages').innerHTML = '';
            data.items.forEach(add_message);
        } else if (data.type === 'message') {
            add_message(data.item);
        } else if (data.type === 'status') {
            show_status(data.status);
        } else if (data.type === 'attachments') {
            element('attachments').innerHTML = '';
            for (const item of data.items) {
                const chip = document.createElement('span');
                chip.className = 'chip';
                chip.textContent = `${item.label} ✕`;
                chip.title = 'Remove';
                chip.addEventListener('click', () => vscode.postMessage({ type: 'remove_attachment', id: item.id }));
                element('attachments').appendChild(chip);
            }
        } else if (data.type === 'error') {
            add_message({ role: 'error', text: data.text });
        }
    });

    const send = () => {
        const text = element('input').value;
        if (!text.trim() || state.busy) return;
        element('input').value = '';
        vscode.postMessage({ type: 'send', text });
    };
    element('send').addEventListener('click', send);
    element('input').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    });
    element('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    element('new_chat').addEventListener('click', () => vscode.postMessage({ type: 'new_chat' }));
    element('signin_button').addEventListener('click', () => vscode.postMessage({ type: 'sign_in' }));
    element('agent').addEventListener('change', event => vscode.postMessage({ type: 'select_agent', name: event.target.value }));
    for (const kind of ['current', 'files', 'folder']) element(`attach_${kind}`).addEventListener('click', () => vscode.postMessage({ type: 'attach', kind }));
    vscode.postMessage({ type: 'ready' });
})();
