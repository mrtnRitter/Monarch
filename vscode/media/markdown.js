// Small Markdown renderer for agent answers. All text is HTML-escaped first; only http(s) links are created.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.monarch_markdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const escape_map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const fence_pattern = /^(`{3,}|~{3,})/;
    const item_pattern = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
    const table_separator = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
    // [action, label, tooltip] of the code block toolbar; the chat window handles clicks on data-code-action
    const code_actions = [['copy', 'Copy', 'Copy'], ['insert', 'Insert', 'Insert at cursor'], ['new_file', 'New file', 'Insert into new file'], ['terminal', 'Terminal', 'Insert into terminal (not run)']];
    const code_buttons = code_actions.map(([action, label, title]) => `<button class="code-btn" data-code-action="${action}" title="${title}">${label}</button>`).join('');

    function escape_html(text) {
        return String(text).replace(/[&<>"']/g, char => escape_map[char]);
    }

    function inline(text) {
        const codes = [];
        // protect code spans from further formatting
        let html = escape_html(text).replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
        html = html
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
            .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?![*\w])/g, '$1<em>$2</em>')
            .replace(/(^|[^\w])_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, '$1<em>$2</em>');
        return html.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
    }

    function closes_fence(line, fence) {
        const trimmed = line.trim();
        return trimmed.length >= fence.length && trimmed[0] === fence[0] && /^(`+|~+)$/.test(trimmed);
    }

    /** Code block with toolbar (language, actions). */
    function code_block(code, language) {
        const lang = escape_html(language);
        return `<div class="code-block" data-lang="${lang}"><div class="code-head"><span class="code-lang">${lang}</span>${code_buttons}</div><pre><code>${escape_html(code)}</code></pre></div>`;
    }

    function table_cells(line) {
        return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => inline(cell.trim()));
    }

    /** Render Markdown to HTML: headings, paragraphs, (nested) lists, code blocks, tables, quotes, rules, inline formatting. */
    function render_markdown(source) {
        const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
        const out = [];
        const lists = [];
        let paragraph = [];
        const flush_paragraph = () => {
            if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
            paragraph = [];
        };
        const close_list = () => out.push(`</li></${lists.pop().type}>`);
        const close_lists = () => { while (lists.length) close_list(); };
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const fence = line.trim().match(fence_pattern);
            if (fence) {
                flush_paragraph();
                const indent = line.length - line.trimStart().length;
                const code = [];
                while (++index < lines.length && !closes_fence(lines[index], fence[1])) code.push(lines[index].replace(new RegExp(`^ {0,${indent}}`), ''));
                out.push(code_block(code.join('\n'), line.trim().slice(fence[1].length).trim().split(/\s+/)[0]));
                continue;
            }
            if (!line.trim()) {
                flush_paragraph();
                continue;
            }
            const item = line.match(item_pattern);
            if (item) {
                flush_paragraph();
                const [indent, type] = [item[1].replace(/\t/g, '    ').length, item[3] ? 'ol' : 'ul'];
                while (lists.length && indent < lists[lists.length - 1].indent) close_list();
                const top = lists[lists.length - 1];
                if (top && indent === top.indent && type === top.type) {
                    out.push(`</li><li>${inline(item[4])}`);
                    continue;
                }
                if (top && indent === top.indent) close_list();
                lists.push({ type, indent });
                out.push(`<${type}><li>${inline(item[4])}`);
                continue;
            }
            if (lists.length && /^\s/.test(line)) {
                out.push(`<br>${inline(line.trim())}`);
                continue;
            }
            close_lists();
            const heading = line.match(/^(#{1,6})\s+(.*)$/);
            if (heading) {
                flush_paragraph();
                const level = Math.min(heading[1].length + 1, 6);
                out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
            } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
                flush_paragraph();
                out.push('<hr>');
            } else if (/^\s*>/.test(line)) {
                flush_paragraph();
                const quote = [];
                for (; index < lines.length && /^\s*>/.test(lines[index]); index++) quote.push(lines[index].replace(/^\s*>\s?/, ''));
                index--;
                out.push(`<blockquote>${render_markdown(quote.join('\n'))}</blockquote>`);
            } else if (line.trim().startsWith('|') && table_separator.test(lines[index + 1] || '')) {
                flush_paragraph();
                const head = table_cells(line);
                const rows = [];
                for (index += 2; index < lines.length && lines[index].trim().startsWith('|'); index++) rows.push(table_cells(lines[index]));
                index--;
                out.push(`<table><thead><tr>${head.map(cell => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
            } else {
                paragraph.push(line);
            }
        }
        flush_paragraph();
        close_lists();
        return out.join('');
    }

    return { render_markdown, escape_html };
});
