// monarch chat webview: renders agents, messages, history, model menu and status; forwards user actions to the extension.
window.monarch_chat = {
    create({ root, chat_id, post, input_height: initial_input_height }) {
        const { render_markdown, escape_html } = window.monarch_markdown;
        const { time_text, divider_for } = window.monarch_time;
        const element = name => root.querySelector('[data-el="' + name + '"]');
        const global_listeners = [];
        const resize_observers = [];
        const timers = new Set();
        const active_drags = new Set();
        const bound_repo_filters = new WeakSet();
        let disposed = false;
        const listen_globally = (target, type, listener, options) => {
            target.addEventListener(type, listener, options);
            global_listeners.push(() => target.removeEventListener(type, listener, options));
        };
        const schedule_timeout = (callback, delay) => {
            let timer;
            timer = window.setTimeout(() => {
                timers.delete(timer);
                callback();
            }, delay);
            timers.add(timer);
            return timer;
        };
        const level_names = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum', maximum: 'Maximum' };
        const state = {
            agents: [], agent: null, agent_name: null, labels: { chat: 'Chat', coCredits: 'Co-Credits', coAgents: 'Co-Agenten', stop: 'Stop' },
            user: null, signed_in: false, status: null, models: { default: {}, models: [] }, active_thread_id: null,
            last_day: null, repos: null,
            follow: true, loading_history: false, new_answer_target: null,
        };

        function apply_repo(repo) {
            element('repo_name').textContent = repo.name || 'no folder';
            element('repo_dot').style.backgroundColor = repo.hex || 'transparent';
            element('repo').disabled = !repo.can_change;
            element('repo').title = repo.can_change ? 'Repo of this chat (click to change)' : 'Repo of this chat (change it when the agent has finished and no files are staged)';
        }

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

        // at most one decimal: 50 -> 50c, 0.46 -> 0.5c
        function format_credits(credits) {
            return `${Math.round(credits * 10) / 10}c`;
        }

        // --- menus ---
        function close_menus(except) {
            for (const id of ['model_menu', 'attach_menu', 'repo_menu']) {
                const menu = element(id);
                if (id !== except && menu) menu.classList.add('hidden');
            }
        }

        function toggle_menu(id, render) {
            const menu = element(id);
            const open = menu.classList.contains('hidden');
            close_menus(id);
            if (!open) return menu.classList.add('hidden');
            render();
            menu.classList.remove('hidden');
        }
        listen_globally(document, 'click', event => {
            if (!root.contains(event.target) || !event.target.closest?.('.menu-wrap')) close_menus();
        });
        listen_globally(document, 'keydown', event => {
            if (event.key === 'Escape' && root.contains(event.target)) close_menus();
        });

        function menu_item(label, meta, checked, on_click) {
            const item = document.createElement('div');
            item.className = `menu-item${checked ? ' selected' : ''}`;
            item.innerHTML = `<span class="check">${checked ? '✓' : ''}</span><span class="item-label">${escape_html(label)}</span><span class="item-meta">${escape_html(meta || '')}</span>`;
            item.addEventListener('click', event => { event.stopPropagation(); on_click(event); });
            return item;
        }

        function model_item(model, checked, on_click) {
            const item = document.createElement('div');
            const has_factor = model.factor !== null && model.factor !== undefined;
            const factor = has_factor ? `${model.factor}×` : '';
            item.className = `menu-item model-row${checked ? ' selected' : ''}`;
            item.innerHTML = `<span class="check">${escape_html(checked ? '✓' : '')}</span><span class="item-label">${escape_html(model.display || '')}</span><span class="item-factor">${escape_html(factor)}</span><span class="item-meta">${escape_html(model.provider_name || '')}</span>`;
            item.addEventListener('click', event => { event.stopPropagation(); on_click(event); });
            return item;
        }

        function render_attach_menu() {
            const menu = element('attach_menu');
            const items = [['Current file', 'current'], ['Files', 'files'], ['Folder', 'folder']].map(([label, kind]) => menu_item(label, '', false, () => {
                close_menus();
                post({ type: 'attach', kind });
            }));
            menu.replaceChildren(...items);
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
            return `${state.agent_name || 'Agent'} · ${name}${choice.reasoning ? ` · ${level_name(choice.reasoning)}` : ''}`;
        }

        function set_model(model) {
            post({ type: 'set_model', model });
        }

        function render_model_menu() {
            const menu = element('model_menu');
            const choice = effective_model();
            const override = state.status?.model || null;
            const fallback = state.models.default || {};
            const fallback_model = model_of(fallback);
            const agent_row = document.createElement('div');
            agent_row.className = 'agent-row';
            for (const agent of state.agents) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `agent-circle${agent.id === state.agent ? ' selected' : ''}`;
                button.title = agent.name;
                button.appendChild(avatar(agent.avatar));
                button.addEventListener('click', event => {
                    event.stopPropagation();
                    if (agent.id === state.agent) return;
                    close_menus();
                    post({ type: 'select_agent', id: agent.id });
                });
                agent_row.appendChild(button);
            }
            const nodes = [header_node('Agent'), agent_row, separator_node(), menu_item('Agent default', `${fallback_model?.display || fallback.name || ''}${fallback.reasoning ? ` · ${level_name(fallback.reasoning)}` : ''}`, !override, () => { close_menus(); set_model(null); })];
            const levels = model_of(choice)?.levels || [];
            if (levels.length) {
                const row = document.createElement('div');
                row.className = 'levels';
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
                nodes.push(separator_node(), header_node('Reasoning'), row);
            }
            nodes.push(separator_node(), header_node('AI models'));
            if (state.models.models.length) {
                const table = document.createElement('div');
                table.className = 'model-table';
                for (const model of state.models.models) {
                    const checked = Boolean(override) && override.provider === model.provider && override.name === model.name;
                    table.appendChild(model_item(model, checked, () => {
                        close_menus();
                        set_model({ provider: model.provider, name: model.name, reasoning: model.levels.includes(choice.reasoning) ? choice.reasoning : null });
                    }));
                }
                nodes.push(table);
            } else nodes.push(note_node('No models available.'));
            menu.replaceChildren(...nodes);
        }

        const header_node = text => Object.assign(document.createElement('div'), { className: 'menu-header', textContent: text });
        const note_node = text => Object.assign(document.createElement('div'), { className: 'menu-note', textContent: text });
        const separator_node = () => Object.assign(document.createElement('div'), { className: 'menu-separator' });

        function render_repo_list() {
            const list = element('repo_menu').querySelector('.repo-list');
            const query = element('repo_filter').value.toLowerCase();
            if (state.repos === null) {
                list.replaceChildren(note_node('Loading …'));
                return;
            }
            if (!state.repos.length) {
                list.replaceChildren(note_node('No repos found. Set monarch.reposRoot.'));
                return;
            }
            const repos = state.repos.filter(repo => (repo.name || '').toLowerCase().includes(query));
            if (!repos.length) {
                list.replaceChildren(note_node('No matching repo.'));
                return;
            }
            const items = repos.map(repo => {
                const item = menu_item(repo.name, repo.open ? 'open' : '', Boolean(repo.current), () => {
                    close_menus();
                    if (!repo.current) post({ type: 'select_repo', path: repo.path });
                });
                const dot = document.createElement('span');
                dot.className = `repo-dot${repo.hex ? '' : ' hollow'}`;
                dot.style.backgroundColor = repo.hex || 'transparent';
                item.insertBefore(dot, item.firstChild);
                return item;
            });
            list.replaceChildren(...items);
        }

        function render_repo_menu() {
            const menu = element('repo_menu');
            let filter = element('repo_filter');
            let list = menu.querySelector('.repo-list');
            if (!filter || !list) {
                filter = document.createElement('input');
                filter.dataset.el = 'repo_filter';
                filter.className = 'menu-filter';
                filter.placeholder = 'Filter repos …';
                filter.spellcheck = false;
                list = Object.assign(document.createElement('div'), { className: 'repo-list' });
                menu.replaceChildren(header_node('Repo of this chat'), filter, list);
            }
            if (!bound_repo_filters.has(filter)) {
                filter.addEventListener('input', render_repo_list);
                filter.addEventListener('keydown', event => {
                    const items = [...list.querySelectorAll('.menu-item')];
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        if (!items.length) return;
                        const active = items.findIndex(item => item.classList.contains('active'));
                        const next = active < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
                        items.forEach((item, index) => item.classList.toggle('active', index === next));
                    } else if (event.key === 'Enter') {
                        (items.find(item => item.classList.contains('active')) || items[0])?.click();
                    }
                });
                bound_repo_filters.add(filter);
            }
            render_repo_list();
        }

        // --- messages ---
        function messages_box() {
            return element('messages');
        }

        function agent_avatar() {
            return current_agent()?.avatar || { initials: (state.agent_name || '?')[0] };
        }

        const new_answer = (() => {
            const chat = element('chat');
            if (!chat) return null;
            let button = element('new_answer');
            if (!button) {
                button = document.createElement('button');
                button.dataset.el = 'new_answer';
                button.className = 'new-answer hidden';
                button.title = 'New answer – click to jump to it';
                button.type = 'button';
                chat.appendChild(button);
            }
            button.addEventListener('click', jump_to_new_answer);
            return button;
        })();

        function metrics() {
            const box = messages_box();
            if (!box) return null;
            const values = { scroll_top: box.scrollTop, scroll_height: box.scrollHeight, client_height: box.clientHeight };
            return Object.values(values).every(Number.isFinite) && values.client_height > 0 ? values : null;
        }

        function content_top(node) {
            try {
                const box = messages_box();
                if (!box || !node || !box.contains(node)) return null;
                const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
                return Number.isFinite(top) ? top : null;
            } catch {
                return null;
            }
        }

        function set_scroll_top(box, top) {
            if (!box || !Number.isFinite(top)) return;
            try {
                box.scrollTop = top;
                box.dispatchEvent(new Event('scroll'));
            } catch {
                // Scrolling must not interfere with message rendering.
            }
        }

        function scroll_to_end() {
            const box = messages_box();
            const current = metrics();
            if (box && current) set_scroll_top(box, current.scroll_height);
        }

        function update_new_answer_position() {
            try {
                const box = messages_box();
                const chat = element('chat');
                if (!box || !chat || !new_answer || !metrics()) return null;
                const box_rect = box.getBoundingClientRect();
                const chat_rect = chat.getBoundingClientRect();
                const padding_left = Number.parseFloat(window.getComputedStyle(box).paddingLeft);
                if (![box_rect.left, box_rect.bottom, chat_rect.left, chat_rect.bottom, box.clientLeft, padding_left, new_answer.offsetHeight].every(Number.isFinite)) return null;
                const left = box_rect.left - chat_rect.left + box.clientLeft + padding_left;
                const bottom = chat_rect.bottom - box_rect.bottom + 8;
                new_answer.style.left = String(left) + 'px';
                new_answer.style.bottom = String(bottom) + 'px';
                return { indicator_top: box_rect.bottom - 8 - new_answer.offsetHeight };
            } catch {
                return null;
            }
        }

        function hide_new_answer() {
            if (new_answer) new_answer.classList.add('hidden');
            state.new_answer_target = null;
        }

        function show_new_answer(node) {
            const box = messages_box();
            if (state.new_answer_target || !box || !node || !box.contains(node) || !new_answer || !metrics()) return;
            state.new_answer_target = node.querySelector('.turn-head .avatar') || node;
            new_answer.replaceChildren(avatar(agent_avatar()));
            new_answer.classList.remove('hidden');
            if (!update_new_answer_position()) hide_new_answer();
        }

        function jump_to_new_answer() {
            const target = state.new_answer_target;
            const box = messages_box();
            const current = metrics();
            const node = target?.closest('.turn') || target;
            const top = content_top(node);
            if (!box || !current || !Number.isFinite(top) || !window.monarch_scroll?.answer_target) return;
            set_scroll_top(box, window.monarch_scroll.answer_target({ ...current, top }));
            hide_new_answer();
        }

        function handle_message_scroll() {
            const current = metrics();
            const scroll = window.monarch_scroll;
            if (!current || !scroll?.at_bottom) return;
            state.follow = scroll.at_bottom(current);
            if (!new_answer || new_answer.classList.contains('hidden')) return;
            const target = state.new_answer_target;
            const box = messages_box();
            if (state.follow || !target || !box?.contains(target)) return hide_new_answer();
            const position = update_new_answer_position();
            if (!position || !Number.isFinite(position.indicator_top)) return;
            try {
                if (scroll.reached(target.getBoundingClientRect().top, position.indicator_top)) hide_new_answer();
            } catch {
                hide_new_answer();
            }
        }

        const scroll_box = messages_box();
        if (scroll_box) {
            scroll_box.addEventListener('scroll', handle_message_scroll);
            if (typeof ResizeObserver === 'function') {
                const scroll_observer = new ResizeObserver(() => {
                    const current = metrics();
                    if (state.follow && current) set_scroll_top(scroll_box, current.scroll_height);
                    if (new_answer && !new_answer.classList.contains('hidden')) update_new_answer_position();
                });
                scroll_observer.observe(scroll_box);
                resize_observers.push(scroll_observer);
            }
        }

        function keep_scroll(node, kind) {
            if (state.loading_history) return;
            try {
                const box = messages_box();
                const current = metrics();
                const scroll = window.monarch_scroll;
                if (!box) return;
                if (kind === 'user') {
                    if (current) scroll_to_end();
                    hide_new_answer();
                } else if (!current) return;
                else if (kind === 'answer' && state.follow && scroll?.answer_target) {
                    const top = content_top(node);
                    if (Number.isFinite(top)) set_scroll_top(box, scroll.answer_target({ ...current, top }));
                } else if (kind === 'answer' && !state.follow) {
                    show_new_answer(node);
                } else if (kind === 'other' && state.follow) {
                    scroll_to_end();
                }
            } catch {
                // Scrolling must not interfere with message rendering.
            }
        }

        function show_empty_state() {
            hide_new_answer();
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
                button.addEventListener('click', () => post({ type: 'sign_in' }));
                box.appendChild(button);
            }
            messages_box().replaceChildren(box);
        }

        function append(node, kind = 'other') {
            messages_box().querySelector('.empty-state')?.remove();
            messages_box().appendChild(node);
            keep_scroll(node, kind);
        }

        function append_timed(node, item, kind) {
            const { divider, last_day } = divider_for(state.last_day, item.created);
            state.last_day = last_day;
            const messages = messages_box();
            messages.querySelector('.empty-state')?.remove();
            if (divider) {
                const line = document.createElement('div');
                line.className = 'date-divider';
                line.appendChild(Object.assign(document.createElement('span'), { textContent: divider }));
                messages.appendChild(line);
            }
            messages.appendChild(node);
            keep_scroll(node, kind);
        }

        // relay and agent steps between two answers: one line with the latest step and "+ x Steps"; a click shows the earlier ones
        function step_group() {
            let node = messages_box().lastElementChild;
            // warning and error boxes do not split the steps into several lines
            while (node?.matches('.message.warning, .message.error')) node = node.previousElementSibling;
            if (node?.classList.contains('steps')) return node;
            const group = Object.assign(document.createElement('div'), { className: 'steps' });
            const line = Object.assign(document.createElement('div'), { className: 'step step-current', tabIndex: -1 });
            line.setAttribute('role', 'button');
            line.append(Object.assign(document.createElement('span'), { className: 'step-text' }), Object.assign(document.createElement('span'), { className: 'step-more', hidden: true }));
            const toggle = () => {
                const earlier = group.querySelector('.step-list').children.length;
                if (!earlier) return;
                group.classList.toggle('open');
                const open = group.classList.contains('open');
                line.querySelector('.step-more').hidden = open || !earlier;
                line.setAttribute('aria-expanded', String(open));
            };
            line.addEventListener('click', toggle);
            line.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
            group.append(Object.assign(document.createElement('div'), { className: 'step-list' }), line);
            append(group);
            return group;
        }

        function add_step(text) {
            const group = step_group();
            const line = group.querySelector('.step-current');
            const current = line.querySelector('.step-text');
            if (current.textContent) group.querySelector('.step-list').appendChild(Object.assign(document.createElement('div'), { className: 'step', textContent: current.textContent, title: current.textContent }));
            Object.assign(current, { textContent: text, title: text });
            const earlier = group.querySelector('.step-list').children.length;
            Object.assign(line.querySelector('.step-more'), { textContent: `+ ${earlier} ${earlier === 1 ? 'Step' : 'Steps'}`, hidden: !earlier || group.classList.contains('open') });
            line.classList.toggle('expandable', earlier > 0);
            line.tabIndex = earlier ? 0 : -1;
            if (earlier) line.setAttribute('aria-expanded', String(group.classList.contains('open')));
            line.title = earlier ? `${text}\n(click to ${group.classList.contains('open') ? 'hide' : 'show'} the earlier steps)` : text;
            keep_scroll(line, 'other');
        }

        // one single-choice question: a click sends the option; otherwise answers are collected and sent together
        function question_card(item) {
            const card = document.createElement('div');
            card.className = 'question';
            const questions = item.questions || [];
            const instant = questions.length === 1 && !questions[0].multi && questions[0].options.length > 0;
            const lock = () => card.querySelectorAll('button, input').forEach(node => { node.disabled = true; });
            open_cards.push({ lock, interrupt_id: item.interrupt_id });
            const submit = Object.assign(document.createElement('button'), { className: 'question-send', type: 'button', textContent: 'Send answer', disabled: true });
            const update = () => { submit.disabled = !parts.every(part => part.answers().length); };
            const on_send = option => send_text(option);
            const parts = questions.map(question => question_part(card, question, instant, instant ? on_send : update));
            if (instant) {
                if (questions[0].custom) card.insertAdjacentHTML('beforeend', '<div class="question-hint">or type your own answer below</div>');
                return card;
            }
            submit.addEventListener('click', () => {
                if (on_send(parts.map(part => `${questions.length > 1 ? `${part.text}: ` : ''}${part.answers().join(', ')}`).join('\n'))) submit.textContent = 'Sent';
            });
            card.appendChild(submit);
            return card;
        }

        /** Question title, option buttons and (when collecting) an own-answer field; instant: on_choose(option) sends and returns true on success. */
        function question_part(card, question, instant, on_choose) {
            card.appendChild(Object.assign(document.createElement('div'), { className: 'question-text', textContent: question.text }));
            const buttons = question.options.map(option => {
                const button = Object.assign(document.createElement('button'), { className: 'option', type: 'button', textContent: option });
                button.addEventListener('click', () => {
                    if (instant) return on_choose(option) && button.classList.add('chosen');
                    if (!question.multi) buttons.forEach(node => node !== button && node.classList.remove('chosen'));
                    button.classList.toggle('chosen');
                    on_choose();
                });
                card.appendChild(button);
                return button;
            });
            const input = !instant && question.custom ? Object.assign(document.createElement('input'), { className: 'question-input', type: 'text', placeholder: question.options.length ? 'Own answer …' : 'Your answer …' }) : null;
            if (input) {
                input.addEventListener('input', () => on_choose());
                card.appendChild(input);
            }
            const answers = () => [...buttons.filter(node => node.classList.contains('chosen')).map(node => node.textContent), ...(input?.value.trim() ? [input.value.trim()] : [])];
            return { text: question.text, answers };
        }

        function add_message(item) {
            if (item.role === 'step' || item.role === 'info') return add_step(item.text);
            if (item.role === 'question') return append(question_card(item), 'answer');
            // warnings (e.g. files not downloaded) stay until closed
            if (item.role === 'error' || item.role === 'warning') {
                const box = document.createElement('div');
                box.className = `message ${item.role}`;
                box.textContent = item.text;
                if (item.transient) schedule_timeout(() => box.remove(), 5000);
                const close = Object.assign(document.createElement('button'), { className: 'error-close', textContent: '✕', title: 'Close' });
                close.addEventListener('click', () => box.remove());
                box.appendChild(close);
                return append(box);
            }
            if (item.role === 'user') {
                const row = document.createElement('div');
                row.className = 'row user';
                const bubble = document.createElement('div');
                bubble.className = 'bubble';
                bubble.textContent = item.text;
                if (typeof item.created === 'number' && Number.isFinite(item.created)) bubble.appendChild(Object.assign(document.createElement('div'), { className: 'msg-time', textContent: time_text(item.created) }));
                row.append(bubble, avatar(state.user || { initials: 'Du' }));
                return append_timed(row, item, 'user');
            }
            const turn = document.createElement('div');
            turn.className = 'turn';
            if (item.credit_key) turn.dataset.creditKey = item.credit_key;
            const head = document.createElement('div');
            head.className = 'turn-head';
            head.appendChild(avatar(agent_avatar()));
            head.appendChild(Object.assign(document.createElement('span'), { className: 'name', textContent: state.agent_name || 'Agent' }));
            if (typeof item.created === 'number' && Number.isFinite(item.created)) head.appendChild(Object.assign(document.createElement('span'), { className: 'meta time', textContent: time_text(item.created) }));
            if (item.duration_ms) head.appendChild(Object.assign(document.createElement('span'), { className: 'meta', textContent: `· ${format_duration(item.duration_ms)}` }));
            head.appendChild(Object.assign(document.createElement('span'), { className: 'meta credits', hidden: true }));
            show_turn_credits(head, item.credits);
            if (item.text) {
                const copy = Object.assign(document.createElement('button'), { className: 'code-btn turn-copy', textContent: 'Copy', title: 'Copy answer (Markdown)' });
                copy.addEventListener('click', () => { post({ type: 'copy', text: item.text }); flash(copy); });
                head.appendChild(copy);
            }
            const body = document.createElement('div');
            body.className = 'turn-body';
            if (item.text) body.insertAdjacentHTML('beforeend', `<div class="md">${render_markdown(item.text)}</div>`);
            for (const file of item.files || []) {
                const link = document.createElement('a');
                link.className = 'file';
                link.textContent = `📄 ${file.path}`;
                link.addEventListener('click', () => post({ type: 'open_file', path: file.path }));
                body.appendChild(link);
            }
            for (const warning of item.warnings || []) {
                const line = document.createElement('div');
                line.className = 'warning';
                line.textContent = `⚠ ${warning}`;
                body.appendChild(line);
            }
            turn.append(head, body);
            append_timed(turn, item, 'answer');
        }

        function show_turn_credits(head, credits) {
            if (typeof credits !== 'number' || !Number.isFinite(credits)) return;
            const node = head.querySelector('.credits');
            Object.assign(node, { textContent: `· ${format_credits(credits)}`, hidden: false });
        }

        // credits of an answer arrive after the answer; other chats and unknown answers are ignored
        function update_turn_credits({ thread_id, key, credits }) {
            if (!key || (thread_id && state.active_thread_id && thread_id !== state.active_thread_id)) return;
            const turn = [...messages_box().querySelectorAll('.turn')].find(node => node.dataset.creditKey === key);
            if (turn) show_turn_credits(turn.querySelector('.turn-head'), credits);
        }

        // --- code block actions: one handler for all blocks, also for blocks from the history ---
        function flash(button) {
            const label = button.dataset.label || (button.dataset.label = button.textContent);
            button.textContent = 'Copied';
            schedule_timeout(() => { button.textContent = label; }, 1200);
        }
        messages_box().addEventListener('click', event => {
            const button = event.target.closest('[data-code-action]');
            if (!button) return;
            const block = button.closest('.code-block');
            const action = button.dataset.codeAction;
            post({ type: 'code_action', action, code: block.querySelector('code').textContent, language: block.dataset.lang || '' });
            if (action === 'copy') flash(button);
        });

        // VS Code does not reliably pass Ctrl+C to the chat window; copy the selection through the extension instead
        listen_globally(document, 'keydown', event => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'c') return;
            const field = event.target.closest?.('textarea, input');
            if (field && !root.contains(field)) return;
            const selection = window.getSelection();
            if (!field && (!selection || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode))) return;
            const text = field ? field.value.slice(field.selectionStart, field.selectionEnd) : selection.toString();
            if (!text) return;
            event.preventDefault();
            post({ type: 'copy', text });
        });

        // --- status ---
        function show_status(status) {
            state.status = status;
            const show_value = (id, label, value) => {
                const node = element(id);
                node.className = 'badge';
                node.textContent = `${label} ${value ?? '?'}`;
            };
            show_value('credits', state.labels.chat, status.credits);
            show_value('co_credits', state.labels.coCredits, status.co_credits);
            const working = Number(status.working);
            const co_agents = status.co_agents ?? '?';
            show_value('co_agents', state.labels.coAgents, `${co_agents}${working > 0 ? ` · ${status.working} working` : ''}`);
            const send_button = element('send');
            send_button.disabled = status.busy;
            send_button.classList.toggle('hidden', status.busy);
            element('stop').classList.toggle('hidden', !status.busy);
            element('model').textContent = model_label();
            if (!element('model_menu').classList.contains('hidden')) render_model_menu();
            update_working();
        }

        function update_working() {
            const messages = messages_box();
            const status = state.status;
            const active = Boolean(status?.busy);
            let wrappers = [...messages.querySelectorAll('.step-spinner')];
            if (!active) {
                wrappers.forEach(node => node.remove());
                [...messages.querySelectorAll('.steps')].forEach(group => {
                    if (!group.querySelector('.step-text')?.textContent && !group.querySelector('.step-list')?.children.length) group.remove();
                });
                if (messages.lastElementChild) keep_scroll(messages.lastElementChild, 'other');
                return;
            }

            const group = step_group();
            const line = group.querySelector('.step-current');
            const more = line.querySelector('.step-more');
            let spinner = group.querySelector('.step-spinner') || wrappers.shift();
            wrappers.filter(node => node !== spinner).forEach(node => node.remove());
            if (!spinner) {
                spinner = document.createElement('span');
                spinner.className = 'step-spinner';
                spinner.append(Object.assign(document.createElement('span'), { className: 'spinner' }), Object.assign(document.createElement('span'), { className: 'step-elapsed' }));
            }
            const elapsed = spinner.querySelector('.step-elapsed');
            elapsed.textContent = status.phase_since == null ? '' : format_duration(Date.now() - status.phase_since);
            if (spinner.parentNode !== line || Array.from(line.children).indexOf(spinner) !== Array.from(line.children).indexOf(more) - 1) line.insertBefore(spinner, more);
            [...messages.querySelectorAll('.steps')].forEach(other => {
                if (other !== group && !other.querySelector('.step-text')?.textContent && !other.querySelector('.step-list')?.children.length) other.remove();
            });
            keep_scroll(line, 'other');
        }
        const working_interval = window.setInterval(update_working, 1000);

        function set_enabled(enabled) {
            for (const id of ['model', 'stop', 'send', 'attach']) element(id).disabled = !enabled;
            element('input').disabled = !enabled;
        }

        function on_message(data) {
            if (disposed) return;
            if (data.agent && data.agent !== state.agent) return;
            if (data.type === 'init') {
                const labels = data.labels || {};
                Object.assign(state, { agents: data.agents, agent: data.current, agent_name: data.current_name, labels: { ...state.labels, ...labels, chat: labels.chat || labels.credits || state.labels.chat }, user: data.user, signed_in: data.signed_in, models: { default: {}, models: [] }, status: null, active_thread_id: null, last_day: null, loading_history: false });
                if (data.repo) apply_repo(data.repo);
                element('stop').textContent = state.labels.stop;
                element('stop').classList.add('hidden');
                element('send').classList.remove('hidden');
                element('model').textContent = model_label();
                set_enabled(Boolean(data.current));
                if (data.input_height) set_input_height(data.input_height);
                close_menus();
                show_empty_state();
                scroll_to_end();
            } else if (data.type === 'repo') {
                apply_repo(data.repo);
            } else if (data.type === 'repos') {
                state.repos = data.items || [];
                if (!element('repo_menu').classList.contains('hidden')) render_repo_list();
            } else if (data.type === 'history') {
                hide_new_answer();
                state.loading_history = true;
                state.last_day = null;
                state.active_thread_id = typeof data.thread_id === 'string' ? data.thread_id : null;
                open_cards.length = 0;
                try {
                    show_empty_state();
                    (Array.isArray(data.items) ? data.items : []).forEach(add_message);
                } finally {
                    state.loading_history = false;
                    hide_new_answer();
                    scroll_to_end();
                }
                update_working();
            } else if (data.type === 'message') {
                add_message(data.item);
                update_working();
            } else if (data.type === 'answer_credits') {
                update_turn_credits(data);
            } else if (data.type === 'status') {
                // a new chat gets its thread with the first message; no history message follows
                if (state.active_thread_id === null && data.status.thread_id) state.active_thread_id = data.status.thread_id;
                show_status(data.status);
            } else if (data.type === 'models') {
                state.models = { default: data.default || {}, models: data.models || [] };
                element('model').textContent = model_label();
            } else if (data.type === 'attachments') {
                element('attachments').replaceChildren(...data.items.map(item => {
                    const chip = document.createElement('span');
                    chip.className = 'chip';
                    chip.textContent = `${item.label} ✕`;
                    chip.title = 'Remove';
                    chip.addEventListener('click', () => post({ type: 'remove_attachment', id: item.id }));
                    return chip;
                }));
            } else if (data.type === 'error') {
                add_message({ role: 'error', text: data.text, transient: data.transient });
                update_working();
            }
        }

        // a sent message answers the latest open question card; all open cards are closed afterwards
        const open_cards = [];
        function send_text(text) {
            if (!text.trim() || state.status?.busy) return false;
            const interrupt_id = [...open_cards].reverse().find(card => card.interrupt_id)?.interrupt_id;
            post({ type: 'send', text, ...(interrupt_id ? { interrupt_id } : {}) });
            open_cards.splice(0).forEach(card => card.lock());
            return true;
        }
        const send = () => {
            if (send_text(element('input').value)) element('input').value = '';
        };

        // --- input height: drag the line between messages and input; min. height comes from CSS ---
        let input_height = initial_input_height ?? null;
        function set_input_height(height) {
            input_height = height;
            element('input').style.height = `${Math.min(height, Math.round(window.innerHeight * 0.7))}px`;
        }
        if (input_height !== null) set_input_height(input_height);
        listen_globally(window, 'resize', () => { if (input_height) set_input_height(input_height); });
        element('splitter').addEventListener('pointerdown', event => {
            const splitter = element('splitter');
            const [start_y, start_height] = [event.clientY, element('input').offsetHeight];
            const move = moved => set_input_height(Math.max(0, start_height + start_y - moved.clientY));
            let finished = false;
            const dispose_drag = () => {
                if (finished) return;
                finished = true;
                splitter.removeEventListener('pointermove', move);
                splitter.removeEventListener('lostpointercapture', finish);
                splitter.classList.remove('dragging');
                active_drags.delete(dispose_drag);
                try { if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId); } catch {}
            };
            const finish = () => {
                if (finished) return;
                finished = true;
                splitter.removeEventListener('pointermove', move);
                splitter.removeEventListener('lostpointercapture', finish);
                splitter.classList.remove('dragging');
                active_drags.delete(dispose_drag);
                set_input_height(element('input').offsetHeight);
                post({ type: 'input_height', height: input_height });
            };
            event.preventDefault();
            splitter.setPointerCapture(event.pointerId);
            splitter.classList.add('dragging');
            splitter.addEventListener('pointermove', move);
            splitter.addEventListener('lostpointercapture', finish);
            active_drags.add(dispose_drag);
        });
        element('send').addEventListener('click', send);
        element('input').addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
        });
        element('stop').addEventListener('click', () => post({ type: 'stop' }));
        element('repo').addEventListener('click', event => {
            event.stopPropagation();
            const opening = element('repo_menu').classList.contains('hidden');
            if (opening) state.repos = null;
            toggle_menu('repo_menu', render_repo_menu);
            if (opening) {
                element('repo_filter').focus();
                post({ type: 'list_repos' });
            }
        });
        element('terminal').addEventListener('click', () => post({ type: 'terminal' }));
        element('model').addEventListener('click', event => { event.stopPropagation(); toggle_menu('model_menu', render_model_menu); });
        element('attach').addEventListener('click', event => { event.stopPropagation(); toggle_menu('attach_menu', render_attach_menu); });
        function dispose() {
            if (disposed) return;
            disposed = true;
            global_listeners.splice(0).forEach(remove => remove());
            window.clearInterval(working_interval);
            for (const timer of timers) window.clearTimeout(timer);
            timers.clear();
            resize_observers.splice(0).forEach(observer => observer.disconnect());
            for (const cleanup of [...active_drags]) cleanup();
        }
        post({ type: 'ready' });
        return {
            on_message,
            focus() { element('input').focus({ preventScroll: true }); },
            dispose,
        };
    },
};
