'use strict';

(function () {
    const vscode = acquireVsCodeApi();
    const layout = window.monarch_layout;
    const template = document.getElementById('area_template');
    const areas_node = document.getElementById('areas');
    const notes_pane = document.getElementById('notes_pane');
    const notes_splitter = document.getElementById('notes_splitter');
    const notes_groups_node = document.getElementById('notes_groups');
    const single_notes = document.getElementById('notes');
    const notes_toggle = document.getElementById('notes_toggle');
    const history_button = document.getElementById('history');
    const history_menu = document.getElementById('history_menu');
    const new_chat_button = document.getElementById('new_chat');
    const new_menu = document.getElementById('new_menu');
    const areas = [];
    const note_cache = new Map();
    const note_nodes = new Map();
    const note_input_bound = new WeakSet();
    const active_drags = new Set();
    let area_sizes = [];
    let group_sizes = [];
    let rendered_note_ids = [];
    let active_id = null;
    let note_groups = [];
    let notes_visible = false;
    let notes_width = null;
    let notes_position = 'left';
    let new_chat_position = 'right';
    let max_areas = 4;
    let input_height = null;
    let ready_sent = false;

    const post = message => vscode.postMessage(message);
    const area_of = chat_id => areas.find(area => area.chat_id === chat_id) || null;
    const escape_key = value => String(value);

    function post_area(area, message) {
        if (message.type === 'input_height') input_height = Number.isFinite(message.height) ? message.height : null;
        post({ chat_id: area.chat_id, ...message });
    }

    function set_active(chat_id, { notify = true, focus = false } = {}) {
        const area = area_of(chat_id);
        if (!area) return;
        const changed = active_id !== chat_id;
        active_id = chat_id;
        for (const item of areas) item.root.classList.toggle('active', areas.length > 1 && item.chat_id === active_id);
        if (changed) {
            render_history();
            render_new_menu();
            if (notify) post({ type: 'focus_area', chat_id });
        }
        if (focus) area.instance?.focus();
    }

    function apply_area_sizes() {
        areas.forEach((area, index) => {
            area.root.style.flexGrow = String(area_sizes[index] || 0);
            area.root.style.flexBasis = '0px';
        });
    }

    function make_splitter(class_name, axis, index, get_sizes, set_sizes, get_px, min_px) {
        const sash = document.createElement('div');
        sash.className = class_name;
        sash.setAttribute('aria-hidden', 'true');
        sash.addEventListener('pointerdown', event => {
            event.preventDefault();
            const sizes = get_sizes().slice();
            const pixels = get_px();
            const total = pixels.reduce((sum, value) => sum + value, 0);
            if (!(total > 0)) return;
            const start = axis === 'x' ? event.clientX : event.clientY;
            let finished = false;
            const moved = next => {
                if (finished) return;
                const current = axis === 'x' ? next.clientX : next.clientY;
                set_sizes(layout.drag_split(sizes, index, current - start, total, min_px));
            };
            const finish = () => {
                if (finished) return;
                finished = true;
                sash.removeEventListener('pointermove', moved);
                sash.removeEventListener('pointerup', finish);
                sash.removeEventListener('pointercancel', finish);
                sash.removeEventListener('lostpointercapture', finish);
                sash.classList.remove('dragging');
                active_drags.delete(cleanup);
                if (sash._cancelDrag === cleanup) delete sash._cancelDrag;
                try { if (sash.hasPointerCapture(event.pointerId)) sash.releasePointerCapture(event.pointerId); } catch {}
            };
            const cleanup = () => finish();
            sash._cancelDrag = cleanup;
            active_drags.add(cleanup);
            try { sash.setPointerCapture(event.pointerId); } catch {}
            sash.classList.add('dragging');
            sash.addEventListener('pointermove', moved);
            sash.addEventListener('pointerup', finish);
            sash.addEventListener('pointercancel', finish);
            sash.addEventListener('lostpointercapture', finish);
        });
        return sash;
    }

    function update_close_button(area) {
        const close = area.root.querySelector('[data-el="close"]');
        const can_close = areas.length > 1 && area.can_change;
        close.classList.toggle('hidden', areas.length < 2);
        close.disabled = !can_close;
        close.title = can_close
            ? 'Close this chat (it stays in History)'
            : 'Close the chat when the agent has finished and no files are staged.';
    }

    function render_areas() {
        areas_node.querySelectorAll('.area-sash').forEach(sash => sash._cancelDrag?.());
        const fragment = document.createDocumentFragment();
        areas.forEach((area, index) => {
            if (index > 0) {
                fragment.appendChild(make_splitter('area-sash', 'x', index - 1,
                    () => area_sizes,
                    sizes => { area_sizes = sizes; apply_area_sizes(); },
                    () => areas.map(item => item.root.getBoundingClientRect().width), 300));
            }
            fragment.appendChild(area.root);
        });
        areas_node.replaceChildren(fragment);
        apply_area_sizes();
        areas.forEach(area => {
            area.root.classList.toggle('active', areas.length > 1 && area.chat_id === active_id);
            update_close_button(area);
        });
    }

    function add_area(chat_id, index) {
        if (chat_id === undefined || chat_id === null || area_of(chat_id) || areas.length >= max_areas) return;
        const root = template.content.firstElementChild.cloneNode(true);
        const area = { chat_id, root, instance: null, chats: [], can_change: false, agent_id: null };
        root.addEventListener('pointerdown', () => set_active(chat_id), true);
        root.addEventListener('focusin', () => set_active(chat_id));
        root.querySelector('[data-el="close"]').addEventListener('click', () => {
            if (areas.length > 1 && area.can_change) post({ type: 'close_area', chat_id });
        });
        const insert_at = Number.isInteger(index) ? Math.max(0, Math.min(index, areas.length)) : layout.insert_index(areas.length, new_chat_position);
        areas.splice(insert_at, 0, area);
        area_sizes = layout.equal_sizes(areas.length);
        render_areas();
        area.instance = window.monarch_chat.create({
            root,
            chat_id,
            input_height,
            post: message => post_area(area, message),
        });
        if (active_id === null || !area_of(active_id)) set_active(chat_id, { notify: false });
        else render_new_menu();
        render_notes();
    }

    function remove_area(chat_id) {
        const index = areas.findIndex(area => area.chat_id === chat_id);
        if (index < 0) return;
        const ids = areas.map(area => area.chat_id);
        const next_id = layout.next_active(ids, chat_id, active_id);
        const [area] = areas.splice(index, 1);
        note_cache.delete(escape_key(chat_id));
        area.instance?.dispose();
        area.root.remove();
        area_sizes = layout.equal_sizes(areas.length);
        render_areas();
        if (next_id !== null) set_active(next_id, { notify: next_id !== active_id });
        else {
            active_id = null;
            close_host_menus();
        }
        render_notes();
    }

    function close_host_menus() {
        history_menu.classList.add('hidden');
        new_menu.classList.add('hidden');
    }

    function menu_header(text) {
        return Object.assign(document.createElement('div'), { className: 'menu-header', textContent: text });
    }

    function menu_note(text) {
        return Object.assign(document.createElement('div'), { className: 'menu-note', textContent: text });
    }

    function menu_item(label, meta, { selected = false, disabled = false, action = () => {}, extra = null } = {}) {
        const item = document.createElement('div');
        item.className = `menu-item${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}`;
        item.setAttribute('role', 'menuitem');
        if (disabled) item.setAttribute('aria-disabled', 'true');
        const name = Object.assign(document.createElement('span'), { className: 'item-label', textContent: label });
        const detail = Object.assign(document.createElement('span'), { className: 'item-meta', textContent: meta || '' });
        item.append(name, detail);
        if (extra) item.appendChild(extra);
        item.addEventListener('click', event => {
            event.stopPropagation();
            if (!disabled) action(event);
        });
        return item;
    }

    function format_date(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '';
        return new Date().toDateString() === date.toDateString()
            ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
    }

    function render_history() {
        const active = area_of(active_id);
        if (!active) {
            history_menu.replaceChildren(menu_header('Chat history'), menu_note('No chats yet.'));
            return;
        }
        const items = active.chats.map(chat => {
            const remove = Object.assign(document.createElement('span'), {
                className: 'item-remove', textContent: '✕', title: 'Remove from history (stays in awork)',
            });
            remove.addEventListener('click', event => {
                event.stopPropagation();
                close_host_menus();
                post_area(active, { type: 'remove_chat', thread_id: chat.thread_id });
            });
            const item = menu_item(chat.title || 'Untitled chat', [chat.repo, format_date(chat.updated)].filter(Boolean).join(' · '), {
                selected: Boolean(chat.current),
                extra: remove,
                action: () => {
                    close_host_menus();
                    const open_area = areas.find(area => area.chats.some(entry => entry.thread_id === chat.thread_id && entry.current));
                    if (open_area) set_active(open_area.chat_id, { focus: true });
                    else post_area(active, { type: 'open_chat', thread_id: chat.thread_id });
                },
            });
            return item;
        });
        history_menu.replaceChildren(menu_header('Chat history'), ...(items.length ? items : [menu_note('No chats yet.') ]));
    }

    function render_new_menu() {
        const active = area_of(active_id);
        const position = new_chat_position === 'left' ? 'left' : 'right';
        const add_disabled = areas.length >= max_areas;
        const items = [menu_item('New chat here', '', {
            disabled: !active,
            action: () => { close_host_menus(); if (active) post_area(active, { type: 'new_chat' }); },
        })];
        items.push(menu_item(`New chat ${position}`, '', {
            disabled: add_disabled,
            action: () => { close_host_menus(); post({ type: 'add_chat' }); },
        }));
        new_menu.replaceChildren(...items);
    }

    function open_menu(menu, render) {
        const opening = menu.classList.contains('hidden');
        close_host_menus();
        if (!opening) return;
        render();
        menu.classList.remove('hidden');
    }

    history_button.addEventListener('click', event => {
        event.stopPropagation();
        open_menu(history_menu, render_history);
    });
    new_chat_button.addEventListener('click', event => {
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey) {
            const active = area_of(active_id);
            if (active) post_area(active, { type: 'import_chat' });
            close_host_menus();
            return;
        }
        open_menu(new_menu, render_new_menu);
    });
    notes_toggle.addEventListener('click', event => {
        event.stopPropagation();
        set_notes_visible(!notes_visible, true);
    });
    document.addEventListener('click', event => {
        if (!history_menu.contains(event.target) && !new_menu.contains(event.target)) close_host_menus();
    });
    document.addEventListener('keydown', event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'c') return;
        const selection = window.getSelection();
        const selection_in_area = selection && (areas_node.contains(selection.anchorNode) || areas_node.contains(selection.focusNode));
        if (areas_node.contains(event.target) || selection_in_area) return;
        const field = document.activeElement?.matches?.('textarea') ? document.activeElement : null;
        const text = field ? field.value.slice(field.selectionStart, field.selectionEnd) : selection?.toString() || '';
        const active = area_of(active_id);
        if (!text || !active) return;
        event.preventDefault();
        post_area(active, { type: 'copy', text });
    });

    function set_notes_visible(visible, notify = false) {
        notes_visible = Boolean(visible);
        notes_pane.classList.toggle('hidden', !notes_visible);
        notes_toggle.classList.toggle('active', notes_visible);
        notes_toggle.setAttribute('aria-pressed', String(notes_visible));
        if (notify) post({ type: 'notes_visible', visible: notes_visible });
        if (notes_visible) notes_groups_node.querySelector('textarea')?.focus();
    }

    function set_notes_position(position) {
        notes_position = position === 'right' ? 'right' : 'left';
        document.body.classList.toggle('notes-left', notes_position === 'left');
        document.body.classList.toggle('notes-right', notes_position === 'right');
    }

    function set_notes_width(width) {
        if (!Number.isFinite(width)) return;
        notes_width = width;
        notes_pane.style.flexBasis = `${Math.min(width, Math.round(window.innerWidth * 0.7))}px`;
    }

    function resize_notes() {
        if (notes_width !== null) set_notes_width(notes_width);
    }
    window.addEventListener('resize', resize_notes);

    function start_notes_drag(event) {
        event.preventDefault();
        const start_x = event.clientX;
        const start_width = notes_pane.offsetWidth;
        const sign = notes_position === 'left' ? 1 : -1;
        let finished = false;
        const moved = next => {
            if (!finished) set_notes_width(Math.max(0, start_width + sign * (next.clientX - start_x)));
        };
        const finish = () => {
            if (finished) return;
            finished = true;
            notes_splitter.removeEventListener('pointermove', moved);
            notes_splitter.removeEventListener('pointerup', finish);
            notes_splitter.removeEventListener('pointercancel', finish);
            notes_splitter.removeEventListener('lostpointercapture', finish);
            notes_splitter.classList.remove('dragging');
            active_drags.delete(cleanup);
            const width = notes_pane.offsetWidth;
            set_notes_width(width);
            post({ type: 'notes_width', width });
        };
        const cleanup = () => {
            if (finished) return;
            finished = true;
            notes_splitter.removeEventListener('pointermove', moved);
            notes_splitter.removeEventListener('pointerup', finish);
            notes_splitter.removeEventListener('pointercancel', finish);
            notes_splitter.removeEventListener('lostpointercapture', finish);
            notes_splitter.classList.remove('dragging');
            active_drags.delete(cleanup);
            try { if (notes_splitter.hasPointerCapture(event.pointerId)) notes_splitter.releasePointerCapture(event.pointerId); } catch {}
        };
        active_drags.add(cleanup);
        try { notes_splitter.setPointerCapture(event.pointerId); } catch {}
        notes_splitter.classList.add('dragging');
        notes_splitter.addEventListener('pointermove', moved);
        notes_splitter.addEventListener('pointerup', finish);
        notes_splitter.addEventListener('pointercancel', finish);
        notes_splitter.addEventListener('lostpointercapture', finish);
    }
    notes_splitter.addEventListener('pointerdown', start_notes_drag);

    function note_record(id, group) {
        const key = escape_key(id);
        let record = note_nodes.get(key);
        if (record) return record;
        const textarea = note_nodes.size === 0 ? single_notes : document.createElement('textarea');
        textarea.spellcheck = false;
        textarea.classList.add('notes-textarea');
        if (textarea !== single_notes) textarea.placeholder = 'Notes for this chat …';
        const wrapper = document.createElement('div');
        wrapper.className = 'notes-group';
        const head = document.createElement('div');
        head.className = 'notes-group-head';
        const dot = document.createElement('span');
        dot.className = 'repo-dot';
        const repo = document.createElement('span');
        repo.className = 'notes-group-repo';
        const title = document.createElement('span');
        title.className = 'notes-group-title';
        head.append(dot, repo, title);
        wrapper.append(head, textarea);
        record = { id, key, data: group, wrapper, head, dot, repo, title, textarea };
        if (!note_input_bound.has(textarea)) {
            note_input_bound.add(textarea);
            textarea.addEventListener('input', () => {
                const current_record = [...note_nodes.values()].find(item => item.textarea === textarea);
                const current = current_record?.data;
                if (!current || current.rev === null || current.rev === undefined) return;
                note_cache.set(current_record.key, { text: textarea.value, rev: current.rev });
                post({ type: 'set_notes', chat_id: current.id, text: textarea.value, rev: current.rev });
            });
        }
        note_nodes.set(key, record);
        return record;
    }

    function restore_notes_focus(focused, selection) {
        if (!focused || !notes_groups_node.contains(focused)) return;
        if (document.activeElement !== focused) focused.focus();
        if (selection && selection.start !== null) {
            try { focused.setSelectionRange(selection.start, selection.end, selection.direction); } catch {}
        }
    }

    function render_notes() {
        const focused = notes_groups_node.contains(document.activeElement) ? document.activeElement : null;
        const focused_record = focused && [...note_nodes.values()].find(record => record.textarea === focused);
        const focused_key = focused_record?.key ?? null;
        const selection = focused ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
        const source = note_groups.length ? note_groups : (area_of(active_id) ? [{ id: active_id, ...(note_cache.get(escape_key(active_id)) || {}) }] : []);
        const visible_groups = source.filter(group => group?.id !== undefined && group.id !== null).map(group => {
            const cached = note_cache.get(escape_key(group.id)) || {};
            return { ...group, text: cached.text ?? group.text ?? '', rev: cached.rev ?? group.rev ?? null };
        });
        const keep = new Set(visible_groups.map(group => escape_key(group.id)));
        for (const [key, record] of note_nodes) {
            if (keep.has(key)) continue;
            record.wrapper.remove();
            if (record.textarea !== single_notes) record.textarea.remove();
            note_nodes.delete(key);
        }
        if (!visible_groups.length) {
            rendered_note_ids = [];
            group_sizes = [];
            single_notes.value = '';
            notes_groups_node.replaceChildren(single_notes);
            restore_notes_focus(focused, selection);
            return;
        }
        notes_groups_node.querySelectorAll('.group-sash').forEach(sash => sash._cancelDrag?.());
        const records = visible_groups.map(group => {
            const record = note_record(group.id, group);
            record.id = group.id;
            record.data = group;
            record.dot.style.backgroundColor = group.hex || 'transparent';
            record.dot.classList.toggle('hollow', !group.hex);
            record.repo.textContent = group.repo || 'no folder';
            record.title.textContent = group.title || '';
            if ((record.textarea !== focused || focused_key !== record.key) && record.textarea.value !== String(group.text ?? '')) record.textarea.value = String(group.text ?? '');
            return record;
        });
        const next_ids = records.map(record => record.key);
        const order_changed = next_ids.length !== rendered_note_ids.length || next_ids.some((id, index) => id !== rendered_note_ids[index]);
        if (order_changed) group_sizes = layout.equal_sizes(records.length);
        rendered_note_ids = next_ids;
        if (records.length === 1) {
            notes_groups_node.replaceChildren(records[0].textarea);
            records[0].textarea.id = 'notes';
            records[0].textarea.classList.remove('notes-other');
            restore_notes_focus(focused, selection);
            return;
        }
        const children = [];
        records.forEach((record, index) => {
            record.textarea.id = '';
            record.textarea.classList.add('notes-other');
            if (record.textarea.parentNode !== record.wrapper) record.wrapper.appendChild(record.textarea);
            record.wrapper.style.flexGrow = String(group_sizes[index]);
            record.wrapper.style.flexBasis = '0px';
            if (index > 0) children.push(make_splitter('group-sash', 'y', index - 1,
                () => group_sizes,
                sizes => {
                    group_sizes = sizes;
                    records.forEach((item, position) => { item.wrapper.style.flexGrow = String(sizes[position]); });
                },
                () => records.map(item => item.wrapper.getBoundingClientRect().height), 60));
            children.push(record.wrapper);
        });
        notes_groups_node.replaceChildren(...children);
        restore_notes_focus(focused, selection);
    }

    function handle_chat_message(area, message) {
        if (message.type === 'init') area.agent_id = message.current ?? null;
        else if (message.agent && message.agent !== area.agent_id) return;
        if (message.type === 'notes') {
            note_cache.set(escape_key(area.chat_id), { text: message.text ?? '', rev: message.rev ?? null });
            render_notes();
            return;
        }
        if (message.type === 'chats') {
            area.chats = Array.isArray(message.items) ? message.items : [];
            if (area.chat_id === active_id && !history_menu.classList.contains('hidden')) render_history();
            return;
        }
        if ((message.type === 'repo' || message.type === 'init') && message.repo) {
            area.can_change = Boolean(message.repo.can_change);
            update_close_button(area);
        }
        area.instance?.on_message(message);
    }

    function receive(message) {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'host_init') {
            notes_visible = Boolean(message.notes_visible);
            notes_width = Number.isFinite(message.notes_width) ? message.notes_width : null;
            notes_position = message.notes_position === 'right' ? 'right' : 'left';
            new_chat_position = message.new_chat_position === 'left' ? 'left' : 'right';
            max_areas = Number.isInteger(message.max_areas) && message.max_areas > 0 ? message.max_areas : 4;
            input_height = Number.isFinite(message.input_height) ? message.input_height : null;
            set_notes_position(notes_position);
            set_notes_visible(notes_visible);
            if (notes_width !== null) set_notes_width(notes_width);
            render_new_menu();
            return;
        }
        if (message.type === 'add_area') {
            add_area(message.chat_id, message.index);
            return;
        }
        if (message.type === 'remove_area') {
            remove_area(message.chat_id);
            return;
        }
        if (message.type === 'focus_area') {
            set_active(message.chat_id, { notify: false, focus: true });
            return;
        }
        if (message.type === 'notes_groups') {
            note_groups = Array.isArray(message.groups) ? message.groups.slice() : [];
            for (const group of note_groups) {
                if (group.id !== undefined && group.id !== null) {
                    note_cache.set(escape_key(group.id), { text: group.text ?? '', rev: group.rev ?? null });
                }
            }
            render_notes();
            return;
        }
        if (message.type === 'notes_position') {
            set_notes_position(message.position);
            return;
        }
        if (message.type === 'new_chat_position') {
            new_chat_position = message.position === 'left' ? 'left' : 'right';
            render_new_menu();
            return;
        }
        if (message.type === 'error' && message.chat_id === undefined) {
            area_of(active_id)?.instance?.on_message(message);
            return;
        }
        const area = area_of(message.chat_id);
        if (!area) return;
        handle_chat_message(area, message);
    }

    window.addEventListener('message', event => receive(event.data));
    window.addEventListener('pagehide', () => {
        for (const cleanup of [...active_drags]) cleanup();
    });
    if (!ready_sent) {
        ready_sent = true;
        post({ type: 'host_ready' });
    }
})();
