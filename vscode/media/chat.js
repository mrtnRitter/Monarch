// monarch chat webview: renders messages and status, forwards user actions to the extension.
(function () {
    const vscode = acquireVsCodeApi();
    const { render_markdown, escape_html } = window.monarch_markdown;
    const element = id => document.getElementById(id);
    const state = { agent: null, labels: { credits: 'Credits', coAgents: 'Co-agents', stop: 'Stop' }, avatars: null, signed_in: false, status: null, steps: null };

    function avatar(entity, large = false) {
        const node = document.createElement(entity?.image ? 'img' : 'span');
        node.className = `avatar${large ? ' large' : ''}`;
        if (entity?.image) node.src = entity.image;
        else node.textContent = entity?.initials || '?';
        return node;
    }

    function format_duration(ms) {
        const seconds = Math.round(ms / 1000);
        return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} min`;
    }

    function messages_box() {
        return element('messages');
    }

    function show_empty_state() {
        const agent = state.avatars?.agent || { initials: (state.agent || '?')[0] };
        const box = document.createElement('div');
        box.className = 'empty-state';
        box.appendChild(avatar(agent, true));
        box.insertAdjacentHTML('beforeend', `<div class="title">${escape_html(state.agent || 'monarch')}</div>`);
        box.insertAdjacentHTML('beforeend', `<div class="subtitle">${state.signed_in ? 'Start a conversation below.' : 'Sign in to awork to start chatting.'}</div>`);
        if (!state.signed_in) {
            const button = document.createElement('button');
            button.className = 'primary-btn';
            button.textContent = 'Sign in';
            button.addEventListener('click', () => vscode.postMessage({ type: 'sign_in' }));
            box.appendChild(button);
        }
        messages_box().replaceChildren(box);
    }

    function append(node) {
        messages_box().querySelector('.empty-state')?.remove();
        messages_box().appendChild(node);
        node.scrollIntoView({ block: 'end' });
    }

    function add_step(text) {
        if (!state.steps || messages_box().lastElementChild !== state.steps) {
            state.steps = document.createElement('details');
            state.steps.className = 'steps';
            state.steps.appendChild(document.createElement('summary'));
            append(state.steps);
        }
        const step = document.createElement('div');
        step.className = 'step';
        step.textContent = text;
        state.steps.appendChild(step);
        const items = [...state.steps.querySelectorAll('.step')];
        const relay = items.some(item => item.textContent.startsWith('relay'));
        state.steps.querySelector('summary').textContent = `${relay ? 'relay · ' : ''}${items.length} ${items.length === 1 ? 'event' : 'events'}`;
        state.steps.scrollIntoView({ block: 'end' });
    }

    function add_message(item) {
        if (item.role === 'info') return add_step(item.text);
        if (item.role === 'error') {
            const box = document.createElement('div');
            box.className = 'message error';
            box.textContent = item.text;
            return append(box);
        }
        if (item.role === 'user') {
            const row = document.createElement('div');
            row.className = 'row user';
            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.textContent = item.text;
            row.append(bubble, avatar(state.avatars?.user || { initials: 'Du' }));
            return append(row);
        }
        const turn = document.createElement('div');
        turn.className = 'turn';
        const head = document.createElement('div');
        head.className = 'turn-head';
        head.appendChild(avatar(state.avatars?.agent || { initials: (state.agent || '?')[0] }));
        head.insertAdjacentHTML('beforeend', `<span class="name">${escape_html(state.agent || 'Agent')}</span>${item.duration_ms ? `<span class="meta">· ${format_duration(item.duration_ms)}</span>` : ''}`);
        const body = document.createElement('div');
        body.className = 'turn-body';
        body.insertAdjacentHTML('beforeend', `<div class="md">${render_markdown(item.text || '')}</div>`);
        for (const file of item.files || []) {
            const link = document.createElement('a');
            link.className = 'file';
            link.textContent = `📄 ${file.path} (${file.check})`;
            link.addEventListener('click', () => vscode.postMessage({ type: 'open_file', path: file.path }));
            body.appendChild(link);
        }
        for (const warning of item.warnings || []) {
            const line = document.createElement('div');
            line.className = 'warning';
            line.textContent = `⚠ ${warning}`;
            body.appendChild(line);
        }
        turn.append(head, body);
        append(turn);
    }

    function show_status(status) {
        state.status = status;
        const credits_full = status.max_credits && status.credits !== null && status.credits >= status.max_credits * 0.9;
        element('credits').className = `badge${credits_full ? ' warn' : ''}`;
        element('credits').innerHTML = `<span class="label">${escape_html(state.labels.credits)}</span>${status.credits ?? '?'} / ${status.max_credits || '∞'}`;
        element('co_agents').innerHTML = `<span class="label">${escape_html(state.labels.coAgents)}</span>${status.co_agents} / ${status.max_co_agents || '∞'}${status.working ? ` · ${status.working} working` : ''}`;
        element('send').disabled = status.busy;
        update_working();
    }

    function update_working() {
        const status = state.status;
        const active = status && status.busy && status.phase;
        element('working').classList.toggle('hidden', !active);
        if (!active) return;
        const elapsed = format_duration(Date.now() - status.phase_since);
        element('working_text').textContent = status.phase === 'relay' ? `waiting for ${state.labels.coAgents.toLowerCase()} … ${elapsed}` : `${state.agent} is working … ${elapsed}`;
    }
    setInterval(update_working, 1000);

    window.addEventListener('message', ({ data }) => {
        if (data.agent && data.agent !== state.agent) return;
        if (data.type === 'init') {
            Object.assign(state, { agent: data.current, labels: data.labels, avatars: data.avatars, signed_in: data.signed_in, steps: null });
            element('agent').innerHTML = data.agents.map(name => `<option${name === data.current ? ' selected' : ''}>${escape_html(name)}</option>`).join('');
            element('stop').textContent = data.labels.stop;
            show_empty_state();
        } else if (data.type === 'history') {
            state.steps = null;
            show_empty_state();
            data.items.forEach(add_message);
        } else if (data.type === 'message') {
            add_message(data.item);
        } else if (data.type === 'status') {
            show_status(data.status);
        } else if (data.type === 'attachments') {
            element('attachments').replaceChildren(...data.items.map(item => {
                const chip = document.createElement('span');
                chip.className = 'chip';
                chip.textContent = `${item.label} ✕`;
                chip.title = 'Remove';
                chip.addEventListener('click', () => vscode.postMessage({ type: 'remove_attachment', id: item.id }));
                return chip;
            }));
        } else if (data.type === 'error') {
            add_message({ role: 'error', text: data.text });
        }
    });

    const send = () => {
        const text = element('input').value;
        if (!text.trim() || state.status?.busy) return;
        element('input').value = '';
        vscode.postMessage({ type: 'send', text });
    };
    element('send').addEventListener('click', send);
    element('input').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    });
    element('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    element('new_chat').addEventListener('click', () => vscode.postMessage({ type: 'new_chat' }));
    element('agent').addEventListener('change', event => vscode.postMessage({ type: 'select_agent', name: event.target.value }));
    for (const kind of ['current', 'files', 'folder']) element(`attach_${kind}`).addEventListener('click', () => vscode.postMessage({ type: 'attach', kind }));
    vscode.postMessage({ type: 'ready' });
})();
