// Markdown → блоки + Pango-разметка. Без зависимостей от St/Clutter, чтобы можно было гонять в node/gjs.
//
// parseBlocks(md) → [
//   {type: 'code', lang, text}
//   {type: 'table', header: [cells], rows: [[cells]], align: ['left'|'center'|'right'|null]}
//   {type: 'heading', level, text}
//   {type: 'list', items: [{marker, depth, text}]}
//   {type: 'quote', text}
//   {type: 'hr'}
//   {type: 'para', text}
// ]
// Текст в блоках — сырой markdown; для показа прогоняется через inlineMarkup().
// Парсер терпим к недописанному тексту (вызывается на каждом стриминговом обновлении).

export function esc(s) {
    return String(s)
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')  // Pango не принимает управляющие символы
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

const PLACEHOLDER = '\u0000';

function unesc(s) {
    return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Инлайн-разметка: `code`, **bold**, *italic*, ~~strike~~, [text](url). Возвращает валидную Pango-разметку.
// Если передан массив links, в него по порядку складываются {url, start, end} — кликабельные фрагменты;
// start/end — смещения в байтах UTF-8 в готовом (видимом) тексте, как их отдаёт ClutterText.coords_to_position().
export function inlineMarkup(text, links = null) {
    let s = esc(text);
    const link = (label, url) => {
        links?.push({url: unesc(url)});
        return `<u>${label}</u>`;
    };

    // Сначала прячем кодовые спаны, чтобы внутри них ничего не форматировалось.
    const codes = [];
    s = s.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, (_m, _ticks, code) => {
        codes.push(code.trim());
        return `${PLACEHOLDER}${codes.length - 1}${PLACEHOLDER}`;
    });

    // Ссылки: подчёркнутый текст, URL мелко и бледно, если он не совпадает с текстом.
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, label, url) =>
        label === url ? link(label, url) : `${link(label, url)} <span size="small" alpha="55%">${url}</span>`);
    // Голые URL — подчёркиваем.
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g, (_m, pre, url) => pre + link(url, url));

    s = s.replace(/\*\*([^*\n](?:[^*\n]*[^*\n])?)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[^\w*])__([^_\n](?:[^_\n]*[^_\n])?)__(?!\w)/g, '$1<b>$2</b>');
    s = s.replace(/(^|[^*\w])\*([^*\n](?:[^*\n]*[^*\n])?)\*(?!\*)/g, '$1<i>$2</i>');
    s = s.replace(/(^|[^\w_])_([^_\n](?:[^_\n]*[^_\n])?)_(?!\w)/g, '$1<i>$2</i>');
    s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

    s = s.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_m, i) => `<tt>${codes[+i]}</tt>`);
    if (links?.length)
        locateUnderlines(s, links);
    return s;
}

const utf8len = str => new TextEncoder().encode(str).length;

// <u> в разметке создаёт только link(): проходим по готовой разметке, выкидываем теги, раскодируем сущности
// и запоминаем байтовые границы каждого подчёркнутого фрагмента в видимом тексте.
function locateUnderlines(markup, links) {
    let bytes = 0, k = 0, i = 0;
    while (i < markup.length) {
        if (markup[i] === '<') {
            const close = markup.indexOf('>', i);
            if (close < 0)
                break;
            const tag = markup.slice(i + 1, close);
            if (tag === 'u' && k < links.length)
                links[k].start = bytes;
            else if (tag === '/u' && k < links.length)
                links[k++].end = bytes;
            i = close + 1;
        } else if (markup[i] === '&') {
            const semi = markup.indexOf(';', i);
            bytes += utf8len(unesc(markup.slice(i, semi + 1)));
            i = semi + 1;
        } else {
            bytes += utf8len(markup[i]);
            i++;
        }
    }
    // Если что-то не сошлось — такую ссылку просто не делаем кликабельной.
    for (let j = links.length - 1; j >= 0; j--) {
        if (links[j].start === undefined || links[j].end === undefined)
            links.splice(j, 1);
    }
}

const FENCE_RE = /^\s{0,3}(```+|~~~+)\s*([^\s`]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableRow(line) {
    return line.includes('|') && line.trim() !== '';
}

function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|'))
        s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|'))
        s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\\' && s[i + 1] === '|') {
            cur += '|';
            i++;
        } else if (c === '|') {
            cells.push(cur.trim());
            cur = '';
        } else {
            cur += c;
        }
    }
    cells.push(cur.trim());
    return cells;
}

function parseAlign(cell) {
    const l = cell.startsWith(':'), r = cell.endsWith(':');
    if (l && r)
        return 'center';
    if (r)
        return 'right';
    if (l)
        return 'left';
    return null;
}

function fitRow(cells, n) {
    const out = cells.slice(0, n);
    while (out.length < n)
        out.push('');
    return out;
}

export function parseBlocks(md) {
    const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    let para = [];

    const flushPara = () => {
        const text = para.join('\n').trim();
        if (text)
            blocks.push({type: 'para', text});
        para = [];
    };

    while (i < lines.length) {
        const line = lines[i];

        // ```code```
        const fence = line.match(FENCE_RE);
        if (fence) {
            flushPara();
            const marker = fence[1][0];
            const body = [];
            i++;
            while (i < lines.length && !(lines[i].trim().startsWith(marker.repeat(3)) && lines[i].trim().replace(new RegExp(`^${marker === '`' ? '`' : '~'}+`), '') === '')) {
                body.push(lines[i]);
                i++;
            }
            i++; // закрывающий fence (или конец — недописанный блок всё равно показываем как код)
            blocks.push({type: 'code', lang: fence[2] || '', text: body.join('\n')});
            continue;
        }

        if (line.trim() === '') {
            flushPara();
            i++;
            continue;
        }

        // Таблица: строка с | и за ней разделитель |---|
        // (как в GFM: число ячеек разделителя должно совпадать с заголовком — иначе `---` после строки с | стал бы таблицей)
        if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) &&
            splitRow(lines[i + 1]).length === splitRow(line).length) {
            flushPara();
            const header = splitRow(line);
            const align = splitRow(lines[i + 1]).map(parseAlign);
            const rows = [];
            i += 2;
            while (i < lines.length && isTableRow(lines[i]) && !FENCE_RE.test(lines[i])) {
                rows.push(fitRow(splitRow(lines[i]), header.length));
                i++;
            }
            blocks.push({type: 'table', header, align, rows});
            continue;
        }

        const hr = line.match(HR_RE);
        if (hr && !(para.length && hr[1] === '-')) {
            flushPara();
            blocks.push({type: 'hr'});
            i++;
            continue;
        }
        // setext-заголовок (`Текст\n===`) — только после одной строки параграфа
        if (para.length === 1 && /^\s{0,3}(=+|-+)\s*$/.test(line)) {
            const text = para[0].trim();
            para = [];
            blocks.push({type: 'heading', level: line.trim()[0] === '=' ? 1 : 2, text});
            i++;
            continue;
        }

        const heading = line.match(HEADING_RE);
        if (heading) {
            flushPara();
            blocks.push({type: 'heading', level: heading[1].length, text: heading[2]});
            i++;
            continue;
        }

        if (QUOTE_RE.test(line)) {
            flushPara();
            const body = [];
            while (i < lines.length && QUOTE_RE.test(lines[i])) {
                body.push(lines[i].match(QUOTE_RE)[1]);
                i++;
            }
            blocks.push({type: 'quote', text: body.join('\n').trim()});
            continue;
        }

        const list = line.match(LIST_RE);
        if (list) {
            flushPara();
            const items = [];
            const indents = [];
            const counters = []; // автонумерация: Claude часто пишет `1.` в каждой строке
            while (i < lines.length) {
                const m = lines[i].match(LIST_RE);
                if (m && !HR_RE.test(lines[i])) {
                    const indent = m[1].replace(/\t/g, '    ').length;
                    while (indents.length && indents[indents.length - 1] > indent) {
                        indents.pop();
                        counters.pop();
                    }
                    if (!indents.length || indents[indents.length - 1] < indent) {
                        indents.push(indent);
                        counters.push(0);
                    }
                    const depth = indents.length - 1;
                    let marker = m[2];
                    let text = m[3];
                    if (/^[-*+]$/.test(marker)) {
                        const task = text.match(/^\[([ xX])\]\s+(.*)$/);
                        if (task) {
                            marker = task[1] === ' ' ? '☐' : '☑';
                            text = task[2];
                        } else {
                            marker = depth % 2 ? '◦' : '•';
                        }
                    } else {
                        const n = parseInt(marker, 10);
                        counters[depth] = counters[depth] ? counters[depth] + 1 : n;
                        marker = `${counters[depth]}.`;
                    }
                    items.push({marker, depth, text});
                    i++;
                } else if (lines[i].trim() === '') {
                    // Пустая строка внутри списка — продолжаем, если дальше снова пункт.
                    if (i + 1 < lines.length && LIST_RE.test(lines[i + 1]) && !HR_RE.test(lines[i + 1])) {
                        i++;
                    } else {
                        break;
                    }
                } else if (/^\s+\S/.test(lines[i]) && items.length && !FENCE_RE.test(lines[i])) {
                    // Продолжение пункта с отступом.
                    items[items.length - 1].text += `\n${lines[i].trim()}`;
                    i++;
                } else {
                    break;
                }
            }
            blocks.push({type: 'list', items});
            continue;
        }

        para.push(line);
        i++;
    }
    flushPara();
    return blocks;
}
