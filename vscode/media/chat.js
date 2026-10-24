// monarch chat webview: renders agents, messages, history, model menu and status; forwards user actions to the extension.
(function () {
    const vscode = acquireVsCodeApi();
    const { render_markdown, escape_html } = window.monarch_markdown;
    const element = id => document.getElementById(id);
    const level_names = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum', maximum: 'Maximum' };
    const state = {
        agents: [], agent: null, agent_name: null, labels: { credits: 'Credits', coAgents: 'Co-agents', stop: 'Stop' },
        user: null, signed_in: false, status: null, steps: null, chats: [], models: { default: {}, models: [] },
    };

    const level_name = level => level_names[level] || (level ? level[0].toUpperCase() + level.slice(1) : '');
    const current_agent = () => state.agents.find(agent => agent.id === state.agent) || null;

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

    function format_date(ms) {
        const date = new Date(ms);
        const today = new Date().toDateString() === date.toDateString();
        return today ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
    }

    // --- agents: avatar circles, dropdown if they do not fit ---
    function render_agents() {
        const box = element('agents');
        box.replaceChildren(...state.agents.map(agent => {
            const button = document.createElement('button');
            button.className = `agent-circle${agent.id === state.agent ? ' selected' : ''}`;
            button.title = agent.name;
            button.appendChild(avatar(agent.avatar));
            button.addEventListener('click', () => agent.id !== state.agent && vscode.postMessage({ type: 'select_agent', id: agent.id }));
            return button;
        }));
        element('agent').innerHTML = state.agents.map(agent => `<option value="${escape_html(agent.id)}"${agent.id === state.agent ? ' selected' : ''}>${escape_html(agent.name)}</option>`).join('');
        fit_agents();
    }

    function fit_agents() {
        const box = element('agents');
        box.classList.remove('hidden');
        element('agent').classList.add('hidden');
        if (box.scrollWidth <= box.clientWidth || state.agents.length < 2) return;
        box.classList.add('hidden');
        element('agent').classList.remove('hidden');
    }
    new ResizeObserver(fit_agents).observe(element('header'));

    // --- menus ---
    function close_menus(except) {
        for (const id of ['history_menu', 'model_menu']) if (id !== except) element(id).classList.add('hidden');
    }

    function toggle_menu(id, render) {
        const menu = element(id);
        const open = menu.classList.contains('hidden');
        close_menus(id);
        if (!open) return menu.classList.add('hidden');
        render();
        menu.classList.remove('hidden');
    }
    document.addEventListener('click', event => { if (!event.target.closest('.menu-wrap')) close_menus(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close_menus(); });

    function menu_item(label, meta, checked, on_click, extra) {
        const item = document.createElement('div');
        item.className = `menu-item${checked ? ' selected' : ''}`;
        item.innerHTML = `<span class="check">${checked ? '✓' : ''}</span><span class="item-label">${escape_html(label)}</span><span class="item-meta">${escape_html(meta || '')}</span>`;
        if (extra) item.appendChild(extra);
        item.addEventListener('click', event => { event.stopPropagation(); on_click(event); });
        return item;
    }

    function render_history() {
        const menu = element('history_menu');
        const items = state.chats.map(chat => {
            const remove = document.createElement('span');
            remove.className = 'item-remove';
            remove.textContent = '✕';
            remove.title = 'Remove from history (stays in awork)';
            remove.addEventListener('click', event => {
                event.stopPropagation();
                vscode.postMessage({ type: 'remove_chat', thread_id: chat.thread_id });
            });
            return menu_item(chat.title, [chat.repo, format_date(chat.updated)].filter(Boolean).join(' · '), chat.current, () => {
                close_menus();
                if (!chat.current) vscode.postMessage({ type: 'open_chat', thread_id: chat.thread_id });
            }, remove);
        });
        menu.replaceChildren(header_node('Chat history'), ...(items.length ? items : [note_node('No chats yet.')]));
    }

    // --- model menu ---
    function effective_model() {
        const override = state.status?.model;
        return override || state.models.default || {};
    }

    function model_of(choice) {
        return state.models.models.find(model => model.provider === choice.provider && model.name === choice.name) || null;
    }

    function model_label() {
        const choice = effective_model();
        const model = model_of(choice);
        const name = model?.display || choice.name || 'Model';
        return `${name}${choice.reasoning ? ` · ${level_name(choice.reasoning)}` : ''}`;
    }

    function set_model(model) {
        vscode.postMessage({ type: 'set_model', model });
    }

    function render_model_menu() {
        const menu = element('model_menu');
        const choice = effective_model();
        const override = state.status?.model || null;
        const fallback = state.models.default || {};
        const fallback_model = model_of(fallback);
        const nodes = [header_node('AI models')];
        nodes.push(menu_item('Agent default', `${fallback_model?.display || fallback.name || ''}${fallback.reasoning ? ` · ${level_name(fallback.reasoning)}` : ''}`, !override, () => { close_menus(); set_model(null); }));
        const levels = model_of(choice)?.levels || [];
        if (levels.length) {
            const row = document.createElement('div');
            row.className = 'levels';
            row.insertAdjacentHTML('beforeend', '<span class="levels-label">Reasoning</span>');
            for (const level of levels) {
                const button = document.createElement('button');
                button.className = `level${level === choice.reasoning ? ' selected' : ''}`;
                button.textContent = level_name(level);
                button.addEventListener('click', event => {
                    event.stopPropagation();
                    set_model({ provider: choice.provider, name: choice.name, reasoning: level });
                });
                row.appendChild(button);
            }
            nodes.push(row);
        }
        nodes.push(separator_node());
        for (const model of state.models.models) {
            const checked = Boolean(override) && override.provider === model.provider && override.name === model.name;
            const item = menu_item(model.display, model.provider_name, checked, () => {
                close_menus();
                set_model({ provider: model.provider, name: model.name, reasoning: model.levels.includes(choice.reasoning) ? choice.reasoning : null });
            });
            if (model.factor !== null) item.title = `Credit factor ${model.factor}`;
            nodes.push(item);
        }
        if (!state.models.models.length) nodes.push(note_node('No models available.'));
        menu.replaceChildren(...nodes);
    }

    const header_node = text => Object.assign(document.createElement('div'), { className: 'menu-header', textContent: text });
    const note_node = text => Object.assign(document.createElement('div'), { className: 'menu-note', textContent: text });
    const separator_node = () => Object.assign(document.createElement('div'), { className: 'menu-separator' });

    // --- messages ---
    function messages_box() {
        return element('messages');
    }

    function agent_avatar() {
        return current_agent()?.avatar || { initials: (state.agent_name || '?')[0] };
    }

    function show_empty_state() {
        const box = document.createElement('div');
        box.className = 'empty-state';
        box.appendChild(avatar(agent_avatar(), true));
        box.insertAdjacentHTML('beforeend', `<div class="title">${escape_html(state.agent_name || 'monarch')}</div>`);
        const subtitle = !state.signed_in ? 'Sign in to awork to start chatting.' : state.agents.length ? 'Start a conversation below.' : 'No agents available for your user.';
        box.insertAdjacentHTML('beforeend', `<div class="subtitle">${subtitle}</div>`);
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

    function question_card(item) {
        const card = document.createElement('div');
        card.className = 'question';
        const title = document.createElement('div');
        title.className = 'question-text';
        title.textContent = item.text;
        card.appendChild(title);
        for (const option of item.options) {
            const button = document.createElement('button');
            button.className = 'option';
            button.textContent = option;
            button.addEventListener('click', () => {
                if (!send_text(option)) return;
                button.classList.add('chosen');
                card.querySelectorAll('.option').forEach(node => { node.disabled = true; });
            });
            card.appendChild(button);
        }
        if (item.custom) card.insertAdjacentHTML('beforeend', '<div class="question-hint">or type your own answer below</div>');
        return card;
    }

    function add_message(item) {
        if (item.role === 'info') return add_step(item.text);
        if (item.role === 'question') return append(question_card(item));
        if (item.role === 'error') {
            const box = document.createElement('div');
            box.className = 'message error';
            box.textContent = item.text;
            if (item.transient) setTimeout(() => box.remove(), 5000);
            return append(box);
        }
        if (item.role === 'user') {
            const row = document.createElement('div');
            row.className = 'row user';
            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.textContent = item.text;
            row.append(bubble, avatar(state.user || { initials: 'Du' }));
            return append(row);
        }
        const turn = document.createElement('div');
        turn.className = 'turn';
        const head = document.createElement('div');
        head.className = 'turn-head';
        head.appendChild(avatar(agent_avatar()));
        head.insertAdjacentHTML('beforeend', `<span class="name">${escape_html(state.agent_name || 'Agent')}</span>${item.duration_ms ? `<span class="meta">· ${format_duration(item.duration_ms)}</span>` : ''}`);
        if (item.text) {
            const copy = Object.assign(document.createElement('button'), { className: 'code-btn turn-copy', textContent: 'Copy', title: 'Copy answer (Markdown)' });
            copy.addEventListener('click', () => { vscode.postMessage({ type: 'copy', text: item.text }); flash(copy); });
            head.appendChild(copy);
        }
        const body = document.createElement('div');
        body.className = 'turn-body';
        if (item.text) body.insertAdjacentHTML('beforeend', `<div class="md">${render_markdown(item.text)}</div>`);
        for (const file of item.files || []) {
            const link = document.createElement('a');
            link.className = 'file';
            link.textContent = `📄 ${file.path}`;
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

    // --- code block actions: one handler for all blocks, also for blocks from the history ---
    function flash(button) {
        const label = button.dataset.label || (button.dataset.label = button.textContent);
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = label; }, 1200);
    }
    messages_box().addEventListener('click', event => {
        const button = event.target.closest('[data-code-action]');
        if (!button) return;
        const block = button.closest('.code-block');
        const action = button.dataset.codeAction;
        vscode.postMessage({ type: 'code_action', action, code: block.querySelector('code').textContent, language: block.dataset.lang || '' });
        if (action === 'copy') flash(button);
    });

    // VS Code does not reliably pass Ctrl+C to the chat window; copy the selection through the extension instead
    document.addEventListener('keydown', event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'c') return;
        const field = event.target.closest?.('textarea, input');
        const text = field ? field.value.slice(field.selectionStart, field.selectionEnd) : window.getSelection().toString();
        if (!text) return;
        event.preventDefault();
        vscode.postMessage({ type: 'copy', text });
    });

    // --- status ---
    function show_status(status) {
        state.status = status;
        const credits_full = status.max_credits && status.credits !== null && status.credits >= status.max_credits * 0.9;
        element('credits').className = `badge${credits_full ? ' warn' : ''}`;
        element('credits').innerHTML = `<span class="label">${escape_html(state.labels.credits)}</span>${status.credits ?? '?'} / ${status.max_credits || '∞'}`;
        element('co_agents').innerHTML = `<span class="label">${escape_html(state.labels.coAgents)}</span>${status.co_agents} / ${status.max_co_agents || '∞'}${status.working ? ` · ${status.working} working` : ''}`;
        element('send').disabled = status.busy;
        element('model').textContent = `${model_label()} ▾`;
        if (!element('model_menu').classList.contains('hidden')) render_model_menu();
        update_working();
    }

    function update_working() {
        const status = state.status;
        const active = status && status.busy && status.phase;
        element('working').classList.toggle('hidden', !active);
        if (!active) return;
        const elapsed = format_duration(Date.now() - status.phase_since);
        element('working_text').textContent = status.phase === 'relay' ? `waiting for ${state.labels.coAgents.toLowerCase()} … ${elapsed}` : `${state.agent_name} is working … ${elapsed}`;
    }
    setInterval(update_working, 1000);

    function set_enabled(enabled) {
        for (const id of ['history', 'new_chat', 'model', 'stop', 'send', 'attach_current', 'attach_files', 'attach_folder']) element(id).disabled = !enabled;
        element('input').disabled = !enabled;
    }

    window.addEventListener('message', ({ data }) => {
        if (data.agent && data.agent !== state.agent) return;
        if (data.type === 'init') {
            Object.assign(state, { agents: data.agents, agent: data.current, agent_name: data.current_name, labels: data.labels, user: data.user, signed_in: data.signed_in, steps: null, chats: [], models: { default: {}, models: [] }, status: null });
            element('stop').textContent = data.labels.stop;
            element('model').textContent = 'Model ▾';
            render_agents();
            set_enabled(Boolean(data.current));
            if (data.input_height) set_input_height(data.input_height);
            close_menus();
            show_empty_state();
        } else if (data.type === 'history') {
            state.steps = null;
            show_empty_state();
            data.items.forEach(add_message);
        } else if (data.type === 'message') {
            add_message(data.item);
        } else if (data.type === 'status') {
            show_status(data.status);
        } else if (data.type === 'chats') {
            state.chats = data.items;
            if (!element('history_menu').classList.contains('hidden')) render_history();
        } else if (data.type === 'models') {
            state.models = { default: data.default || {}, models: data.models || [] };
            element('model').textContent = `${model_label()} ▾`;
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
            add_message({ role: 'error', text: data.text, transient: data.transient });
        }
    });

    function send_text(text) {
        if (!text.trim() || state.status?.busy) return false;
        vscode.postMessage({ type: 'send', text });
        return true;
    }
    const send = () => {
        if (send_text(element('input').value)) element('input').value = '';
    };

    // --- input height: drag the line between messages and input; min. height comes from CSS ---
    let input_height = null;
    function set_input_height(height) {
        input_height = height;
        element('input').style.height = `${Math.min(height, Math.round(window.innerHeight * 0.7))}px`;
    }
    window.addEventListener('resize', () => { if (input_height) set_input_height(input_height); });
    element('splitter').addEventListener('pointerdown', event => {
        const splitter = element('splitter');
        const [start_y, start_height] = [event.clientY, element('input').offsetHeight];
        const move = moved => set_input_height(Math.max(0, start_height + start_y - moved.clientY));
        event.preventDefault();
        splitter.setPointerCapture(event.pointerId);
        splitter.classList.add('dragging');
        splitter.addEventListener('pointermove', move);
        // fires after pointerup and pointercancel
        splitter.addEventListener('lostpointercapture', () => {
            splitter.removeEventListener('pointermove', move);
            splitter.classList.remove('dragging');
            set_input_height(element('input').offsetHeight);
            vscode.postMessage({ type: 'input_height', height: input_height });
        }, { once: true });
    });
    element('send').addEventListener('click', send);
    element('input').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    });
    element('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    element('new_chat').addEventListener('click', () => vscode.postMessage({ type: 'new_chat' }));
    element('history').addEventListener('click', event => { event.stopPropagation(); toggle_menu('history_menu', render_history); });
    element('model').addEventListener('click', event => { event.stopPropagation(); toggle_menu('model_menu', render_model_menu); });
    element('agent').addEventListener('change', event => vscode.postMessage({ type: 'select_agent', id: event.target.value }));
    for (const kind of ['current', 'files', 'folder']) element(`attach_${kind}`).addEventListener('click', () => vscode.postMessage({ type: 'attach', kind }));
    vscode.postMessage({ type: 'ready' });
})();
