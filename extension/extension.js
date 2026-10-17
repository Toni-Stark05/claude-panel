// Claude Panel — быстрый чат с Claude Code из верхней панели GNOME.
//
// Расширение только рисует UI. Claude Code запускается через ~/.local/lib/claude-panel/bridge.py,
// который проверяет прокси (fail closed) и делает exec `claude -p --input-format stream-json ...`
// в отдельной папке ~/.local/share/claude-panel/workspace — поэтому сессии панели не смешиваются
// с остальными. Список своих сессий: ~/.local/state/claude-panel/sessions.json.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {esc, inlineMarkup, parseBlocks} from './markdown.js';

const HOME = GLib.get_home_dir();
// CLAUDE_PANEL_STATE_DIR — только для тестов во вложенной оболочке, чтобы не трогать настоящие сессии.
const STATE_DIR = GLib.getenv('CLAUDE_PANEL_STATE_DIR') || GLib.build_filenamev([HOME, '.local/state/claude-panel']);
const TRANSCRIPT_DIR = GLib.build_filenamev([STATE_DIR, 'transcripts']);
const INDEX_FILE = GLib.build_filenamev([STATE_DIR, 'sessions.json']);
const BRIDGE = GLib.build_filenamev([HOME, '.local/lib/claude-panel/bridge.py']);
const HANDY_HELPER = GLib.build_filenamev([HOME, '.local/lib/claude-panel/handy.py']);
const HANDY_DB = GLib.getenv('CLAUDE_PANEL_HANDY_DB') ||
    GLib.build_filenamev([HOME, '.local/share/com.pais.handy/history.db']);
const MODELS = ['sonnet', 'haiku', 'opus'];
const AI_LIMITS_UUID = 'ai-limits@igor.lysenko';
const IDLE_KILL_SEC = 15 * 60;
const MAX_ITEMS = 500;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------- файлы ----------

function readJson(path, fallback) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? JSON.parse(decoder.decode(bytes)) : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(path, value) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        GLib.file_set_contents(path, JSON.stringify(value));
    } catch (e) {
        logError(e, 'claude-panel: write');
    }
}

function transcriptPath(id) {
    return GLib.build_filenamev([TRANSCRIPT_DIR, `${id}.json`]);
}

// ---------- markdown → Pango ----------
// Парсер в markdown.js (без St/Clutter, гоняется в node). Здесь — только защита от невалидной разметки.

function safeMarkup(markup, plain) {
    try {
        Pango.parse_markup(markup, -1, '');
        return markup;
    } catch {
        return esc(plain);
    }
}

// Аппаратные коды клавиш (не зависят от раскладки): C, V, пробел.
const KEYCODE_C = 54;
const KEYCODE_V = 55;
const KEYCODE_SPACE = 65;

function toolSummary(name, input = {}) {
    const v = input.command ?? input.file_path ?? input.path ?? input.url ?? input.query ?? input.pattern ??
        input.description ?? JSON.stringify(input);
    const s = String(v);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

function relTime(ts) {
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return 'только что';
    if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
    if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
    return `${Math.floor(d / 86400)} дн назад`;
}

// ---------- процесс Claude Code ----------

class ClaudeProcess {
    constructor(session, onEvent, onExit) {
        this._session = session;
        this._onEvent = onEvent;
        this._onExit = onExit;
        this._queue = [];
        this._writing = false;
        this._stderr = '';
        this._cancellable = new Gio.Cancellable();
        this.alive = false;
    }

    start() {
        const argv = ['python3', '-I', BRIDGE,
            this._session.started ? '--resume' : '--session-id', this._session.id,
            '--model', this._session.model,
            '--permission-mode', this._session.permMode ?? 'default'];
        this._proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this.alive = true;
        this._stdin = this._proc.get_stdin_pipe();
        this._stdout = new Gio.DataInputStream({base_stream: this._proc.get_stdout_pipe(), close_base_stream: true});
        this._stderrStream = new Gio.DataInputStream({base_stream: this._proc.get_stderr_pipe(), close_base_stream: true});
        this._readLoop();
        this._readStderr();
        this._proc.wait_async(null, () => {
            this.alive = false;
            this._onExit(this._proc.get_exit_status(), this._stderr.trim());
        });
    }

    _readLoop() {
        this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch {
                return;
            }
            if (line === null)
                return;
            if (line.trim()) {
                try {
                    this._onEvent(JSON.parse(line));
                } catch (e) {
                    logError(e, 'claude-panel: event');
                }
            }
            this._readLoop();
        });
    }

    _readStderr() {
        this._stderrStream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch {
                return;
            }
            if (line === null)
                return;
            this._stderr = `${this._stderr}\n${line}`.slice(-2000);
            this._readStderr();
        });
    }

    send(obj) {
        if (!this.alive)
            return;
        this._queue.push(encoder.encode(`${JSON.stringify(obj)}\n`));
        if (!this._writing)
            this._flush();
    }

    _flush() {
        const chunk = this._queue.shift();
        if (!chunk || !this.alive) {
            this._writing = false;
            return;
        }
        this._writing = true;
        this._stdin.write_all_async(chunk, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            try {
                stream.write_all_finish(res);
            } catch (e) {
                logError(e, 'claude-panel: write stdin');
            }
            this._flush();
        });
    }

    kill() {
        this._cancellable.cancel();
        if (this.alive)
            this._proc.force_exit();
        this.alive = false;
    }
}

// ---------- сессия ----------

class Session {
    constructor(data) {
        this.id = data.id ?? GLib.uuid_string_random();
        this.title = data.title ?? '';
        this.model = data.model ?? 'sonnet';
        this.created = data.created ?? Date.now();
        this.updated = data.updated ?? Date.now();
        this.started = data.started ?? false;
        this.items = null; // лениво из файла
        this.proc = null;
        this.busy = false;
        this.interrupted = false;
        this.streamItem = null;
        this.idleTimer = 0;
    }

    toJSON() {
        const {id, title, model, created, updated, started} = this;
        return {id, title, model, created, updated, started};
    }

    load() {
        if (this.items === null) {
            this.items = readJson(transcriptPath(this.id), []);
            // Незавершённые запросы разрешений после перезапуска недействительны.
            for (const it of this.items) {
                if (it.role === 'perm' && it.status === 'pending')
                    it.status = 'cancelled';
            }
        }
        return this.items;
    }

    saveTranscript() {
        if (this.items !== null)
            writeJson(transcriptPath(this.id), this.items.slice(-MAX_ITEMS));
    }
}

// ---------- UI ----------

class ClaudePanel {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.getSettings();
        this._sessions = readJson(INDEX_FILE, []).map(d => new Session(d));
        this._current = null;
        this._view = 'chat';
        this._renderPending = 0;
        this._itemActors = new Map();

        this.button = new PanelMenu.Button(0.5, 'Claude Panel', false);
        this.button.add_child(new St.Label({
            text: '✳', y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-panel-icon',
        }));
        this._busyDot = new St.Widget({style_class: 'claude-panel-busy-dot', visible: false,
            y_align: Clutter.ActorAlign.START});
        this.button.add_child(this._busyDot);

        this._dictating = false;
        this._suppressPasteUntil = 0;
        this._handyPending = 0;
        this._build();
        this._watchHandy();
        this.button.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._fitHeight();
                this._syncHandyLastId();
                if (!this._current)
                    this._openSession(this._sessions[0] ?? null);
                this._scrollToEnd();
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    global.stage.set_key_focus(this._entry.clutter_text);
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    _build() {
        const root = new St.BoxLayout({vertical: true, style_class: 'claude-panel-root'});
        this.button.menu.box.add_child(root);

        // Шапка: сессии | заголовок | модель | новая
        const header = new St.BoxLayout({style_class: 'claude-panel-header'});
        this._listBtn = this._iconButton('view-list-symbolic', 'Сессии', () => this._toggleView());
        this._titleLabel = new St.Label({text: 'Новая сессия', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-panel-title'});
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._modelBtn = new St.Button({label: 'Sonnet', style_class: 'claude-panel-model', can_focus: true});
        this._modelBtn.connect('clicked', () => this._cycleModel());
        const termBtn = this._iconButton('utilities-terminal-symbolic', 'Открыть терминал с cds', () => this._openTerminal());
        termBtn.add_style_class_name('claude-panel-terminal');
        const newBtn = this._iconButton('list-add-symbolic', 'Новая сессия', () => this._newSession());
        header.add_child(this._listBtn);
        header.add_child(this._titleLabel);
        header.add_child(this._modelBtn);
        // Auto — Claude Code сам одобряет безопасные действия и спрашивает только про рискованные.
        this._modeBtn = new St.Button({style_class: 'claude-panel-mode', can_focus: true});
        this._modeBtn.connect('clicked', () => this._togglePermMode());
        header.add_child(this._modeBtn);
        header.add_child(termBtn);
        header.add_child(newBtn);
        root.add_child(header);

        // Чат
        this._chatBox = new St.BoxLayout({vertical: true, style_class: 'claude-panel-messages'});
        this._chatScroll = new St.ScrollView({style_class: 'claude-panel-scroll',
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, x_expand: true, y_expand: true});
        this._chatScroll.set_child(this._chatBox);
        root.add_child(this._chatScroll);

        // Список сессий
        this._listBox = new St.BoxLayout({vertical: true, style_class: 'claude-panel-session-list'});
        this._listScroll = new St.ScrollView({style_class: 'claude-panel-scroll',
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, x_expand: true, y_expand: true, visible: false});
        this._listScroll.set_child(this._listBox);
        root.add_child(this._listScroll);

        // Ввод
        const inputRow = new St.BoxLayout({style_class: 'claude-panel-input-row'});
        this._entry = new St.Entry({hint_text: 'Спросите Claude…  (Enter — отправить, Shift+Enter — новая строка)',
            x_expand: true, can_focus: true, style_class: 'claude-panel-entry'});
        const ct = this._entry.clutter_text;
        ct.single_line_mode = false;
        ct.activatable = false;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.connect('key-press-event', (_a, event) => {
            const sym = event.get_key_symbol();
            const state = event.get_state();
            const shift = state & Clutter.ModifierType.SHIFT_MASK;
            const ctrl = state & Clutter.ModifierType.CONTROL_MASK;
            const code = event.get_key_code();
            if (ctrl && code === KEYCODE_SPACE) {
                // Handy сам ловит Ctrl+Space; мы только запоминаем, что идёт диктовка.
                this._toggleDictation(false);
                return Clutter.EVENT_STOP;
            }
            if (ctrl && code === KEYCODE_V && Date.now() < this._suppressPasteUntil)
                return Clutter.EVENT_STOP; // Handy вставляет Ctrl+V — текст мы уже вставили сами
            if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) && !shift) {
                this._submit();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._sendBtn = this._iconButton('mail-send-symbolic', 'Отправить', () => {
            if (this._current?.busy)
                this._interrupt();
            else
                this._submit();
        });
        this._micBtn = this._iconButton('audio-input-microphone-symbolic', 'Голосовой ввод (Handy)',
            () => this._toggleDictation(true));
        this._micBtn.add_style_class_name('claude-panel-mic');
        inputRow.add_child(this._entry);
        inputRow.add_child(this._micBtn);
        inputRow.add_child(this._sendBtn);
        root.add_child(inputRow);
    }

    // ---------- голосовой ввод через Handy ----------
    // Пока открыто меню оболочки, wl-copy Handy не может записать в буфер и висит, а после закрытия
    // панели Handy вставил бы текст в другое окно. Поэтому, пока панель открыта, следим за историей
    // Handy (history.db): новую запись вставляем в поле ввода сами, а зависший wl-copy снимаем.

    _toggleDictation(spawnHandy) {
        if (spawnHandy) {
            try {
                Gio.Subprocess.new(['handy', '--toggle-transcription'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                Main.notify('Claude Panel', `Не удалось запустить Handy: ${e.message}`);
                return;
            }
        }
        this._dictating = !this._dictating;
        this._updateMic();
        global.stage.set_key_focus(this._entry.clutter_text);
    }

    _updateMic() {
        if (this._dictating)
            this._micBtn.add_style_class_name('recording');
        else
            this._micBtn.remove_style_class_name('recording');
    }

    _handyHelper(args, cb) {
        try {
            const proc = Gio.Subprocess.new(['python3', '-I', HANDY_HELPER, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    cb?.(out.trim());
                } catch (e) {
                    logError(e, 'claude-panel: handy helper');
                }
            });
        } catch (e) {
            logError(e, 'claude-panel: handy helper');
        }
    }

    _watchHandy() {
        this._handyLastId = null;
        const file = Gio.File.new_for_path(HANDY_DB);
        try {
            this._handyMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            logError(e, 'claude-panel: handy monitor');
            return;
        }
        this._handyMonitor.connect('changed', () => {
            if (!this.button.menu.isOpen || this._handyLastId === null || this._handyPending)
                return;
            this._handyPending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._handyPending = 0;
                this._handyHelper(['since', HANDY_DB, String(this._handyLastId)], out => {
                    let row;
                    try {
                        row = JSON.parse(out || '{}');
                    } catch {
                        return;
                    }
                    if (!row.id || row.id <= this._handyLastId)
                        return;
                    this._handyLastId = row.id;
                    this._insertDictation(row.text);
                });
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // Запоминаем последнюю запись истории при открытии панели — вставляем только новые.
    _syncHandyLastId() {
        this._handyHelper(['last-id', HANDY_DB], out => {
            const id = parseInt(out, 10);
            this._handyLastId = Number.isFinite(id) ? id : null;
        });
    }

    _insertDictation(text) {
        text = (text ?? '').trim();
        this._dictating = false;
        this._updateMic();
        if (!text)
            return;
        this._suppressPasteUntil = Date.now() + 5000;
        // Handy настроен копировать результат в буфер — делаем это за него, раз его wl-copy застрял.
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._handyHelper(['release']);
        const ct = this._entry.clutter_text;
        const before = this._entry.text;
        const sep = before && !/\s$/.test(before) ? ' ' : '';
        ct.insert_text(sep + text, ct.get_cursor_position());
        global.stage.set_key_focus(ct);
    }

    _openTerminal() {
        // Новое окно ptyxis: команда (по умолчанию alias cds) в интерактивном bash, чтобы работали
        // alias'ы и прокси из ~/.bashrc; после выхода остаётся обычный shell.
        const command = this._settings.get_string('terminal-command').trim() || 'cds';
        // Не домашняя папка: для ~ Claude Code не запоминает «доверие» и спрашивает каждый раз.
        let dir = this._settings.get_string('terminal-directory').trim().replace(/^~(?=\/|$)/, HOME) || HOME;
        if (!GLib.file_test(dir, GLib.FileTest.IS_DIR))
            dir = HOME;
        this.button.menu.close();
        this._watchTerminalWindow();
        try {
            Gio.Subprocess.new(['ptyxis', '--new-window', '-d', dir, '--', 'bash', '-ic', `${command}; exec bash`],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            this._unwatchTerminalWindow();
            Main.notify('Claude Panel', `Не удалось открыть терминал: ${e.message}`);
        }
    }

    // Первое новое окно ptyxis в течение 15 с после нажатия делаем крупнее (65%×75% рабочей области, по центру).
    _watchTerminalWindow() {
        this._unwatchTerminalWindow();
        this._termDeadline = Date.now() + 15000;
        this._termWatchId = global.display.connect('window-created', (_d, win) => {
            if (Date.now() > this._termDeadline) {
                this._unwatchTerminalWindow();
                return;
            }
            const actor = win.get_compositor_private();
            if (!actor)
                return;
            const id = actor.connect('first-frame', () => {
                actor.disconnect(id);
                try {
                    if (!/ptyxis/i.test(win.get_wm_class() ?? '') || !this._termWatchId)
                        return;
                    this._unwatchTerminalWindow();
                    const area = win.get_work_area_current_monitor();
                    const w = Math.round(area.width * 0.65);
                    const h = Math.round(area.height * 0.75);
                    if (win.get_maximized())
                        win.unmaximize(Meta.MaximizeFlags.BOTH);
                    win.move_resize_frame(true, area.x + Math.round((area.width - w) / 2),
                        area.y + Math.round((area.height - h) / 2), w, h);
                } catch (e) {
                    logError(e, 'claude-panel: resize terminal');
                }
            });
        });
    }

    _unwatchTerminalWindow() {
        if (this._termWatchId) {
            global.display.disconnect(this._termWatchId);
            this._termWatchId = 0;
        }
    }

    _fitHeight() {
        // Не выше 60% экрана, чтобы поле ввода всегда было видно.
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const h = Math.max(200, Math.min(480, Math.floor(monitor.height / scale * 0.6)));
        for (const sv of [this._chatScroll, this._listScroll])
            sv.style = `height: ${h}px;`;
    }

    _iconButton(icon, accessibleName, cb) {
        const btn = new St.Button({style_class: 'claude-panel-icon-button', can_focus: true,
            accessible_name: accessibleName, child: new St.Icon({icon_name: icon, icon_size: 16})});
        btn.connect('clicked', cb);
        return btn;
    }

    // ---------- сессии ----------

    _saveIndex() {
        writeJson(INDEX_FILE, this._sessions);
    }

    _newSession() {
        const s = new Session({model: this._settings.get_string('default-model')});
        s.items = [];
        this._openSession(s);
        this._showView('chat');
        global.stage.set_key_focus(this._entry.clutter_text);
    }

    _openSession(session) {
        if (!session) {
            session = new Session({model: this._settings.get_string('default-model')});
            session.items = [];
        }
        this._current = session;
        session.load();
        this._renderChat();
        this._updateHeader();
    }

    _isSaved(session) {
        return this._sessions.includes(session);
    }

    _deleteSession(session) {
        session.proc?.kill();
        this._sessions = this._sessions.filter(s => s !== session);
        this._saveIndex();
        try {
            Gio.File.new_for_path(transcriptPath(session.id)).delete(null);
        } catch {}
        if (this._current === session)
            this._openSession(this._sessions[0] ?? null);
        this._renderList();
        this._updateBusy();
    }

    _cycleModel() {
        const s = this._current;
        if (s.busy) {
            Main.notify('Claude', 'Модель можно сменить, когда Claude закончит ответ');
            return;
        }
        s.model = MODELS[(MODELS.indexOf(s.model) + 1) % MODELS.length];
        // Процесс перезапустится со --resume и новой моделью при следующем сообщении.
        s.proc?.kill();
        s.proc = null;
        // Меняется модель только этой сессии; модель по умолчанию — в настройках (default-model).
        if (this._isSaved(s))
            this._saveIndex();
        this._updateHeader();
    }

    _togglePermMode() {
        const next = this._settings.get_string('permission-mode') === 'auto' ? 'default' : 'auto';
        this._settings.set_string('permission-mode', next);
        // Режим задаётся при запуске процесса: простаивающие перезапустятся (--resume) со следующим
        // сообщением, занятые — после окончания текущего ответа.
        for (const s of new Set([...this._sessions, this._current])) {
            if (!s?.proc)
                continue;
            if (s.busy) {
                s.restartAfterTurn = true;
            } else {
                s.proc.kill();
                s.proc = null;
            }
        }
        this._updateHeader();
    }

    _toggleView() {
        this._showView(this._view === 'chat' ? 'list' : 'chat');
    }

    _showView(view) {
        this._view = view;
        this._chatScroll.visible = view === 'chat';
        this._listScroll.visible = view === 'list';
        if (view === 'list')
            this._renderList();
        else
            this._scrollToEnd();
    }

    _renderList() {
        this._listBox.destroy_all_children();
        if (!this._sessions.length) {
            this._listBox.add_child(new St.Label({text: 'Сессий пока нет', style_class: 'claude-panel-empty'}));
            return;
        }
        const sorted = [...this._sessions].sort((a, b) => b.updated - a.updated);
        for (const s of sorted) {
            const row = new St.BoxLayout({style_class: 'claude-panel-session-row'});
            const btn = new St.Button({x_expand: true, can_focus: true,
                style_class: `claude-panel-session-button${s === this._current ? ' current' : ''}`});
            const box = new St.BoxLayout({vertical: true, x_expand: true});
            const title = new St.Label({text: `${s.busy ? '● ' : ''}${s.title || 'Без названия'}`,
                style_class: 'claude-panel-session-title'});
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(title);
            box.add_child(new St.Label({text: `${s.model} · ${relTime(s.updated)}`,
                style_class: 'claude-panel-session-meta'}));
            btn.set_child(box);
            btn.connect('clicked', () => {
                this._openSession(s);
                this._showView('chat');
            });
            row.add_child(btn);
            row.add_child(this._iconButton('user-trash-symbolic', 'Удалить сессию', () => this._deleteSession(s)));
            this._listBox.add_child(row);
        }
    }

    _updateHeader() {
        const s = this._current;
        this._titleLabel.text = s?.title || 'Новая сессия';
        this._modelBtn.label = s ? s.model[0].toUpperCase() + s.model.slice(1) : '';
        const auto = this._settings.get_string('permission-mode') === 'auto';
        this._modeBtn.label = auto ? 'Auto' : 'Ask';
        if (auto)
            this._modeBtn.add_style_class_name('auto');
        else
            this._modeBtn.remove_style_class_name('auto');
        this._sendBtn.child.icon_name = s?.busy ? 'media-playback-stop-symbolic' : 'mail-send-symbolic';
    }

    _updateBusy() {
        this._busyDot.visible = this._sessions.some(s => s.busy);
        this._updateHeader();
        if (this._view === 'list')
            this._renderList();
    }

    // ---------- отправка ----------

    _submit() {
        const text = this._entry.text.trim();
        const s = this._current;
        if (!text || !s)
            return;
        this._entry.text = '';
        if (!this._isSaved(s)) {
            s.title = text.replace(/\s+/g, ' ').slice(0, 60);
            this._sessions.push(s);
        }
        s.updated = Date.now();
        this._saveIndex();
        this._addItem(s, {role: 'user', text});
        s.saveTranscript();
        this._ensureProcess(s);
        s.busy = true;
        s.interrupted = false;
        this._clearIdle(s);
        s.proc.send({type: 'user', session_id: '', message: {role: 'user', content: text}, parent_tool_use_id: null});
        this._updateBusy();
    }

    _interrupt() {
        const s = this._current;
        if (!s?.proc?.alive)
            return;
        s.interrupted = true;
        s.proc.send({type: 'control_request', request_id: `req_int_${Date.now()}`, request: {subtype: 'interrupt'}});
    }

    _ensureProcess(s) {
        if (s.proc?.alive)
            return;
        s.permMode = this._settings.get_string('permission-mode');
        s.restartAfterTurn = false;
        s.proc = new ClaudeProcess(s, ev => this._onEvent(s, ev), (status, stderr) => this._onExit(s, status, stderr));
        try {
            s.proc.start();
        } catch (e) {
            this._addItem(s, {role: 'error', text: `Не удалось запустить Claude: ${e.message}`});
        }
    }

    _clearIdle(s) {
        if (s.idleTimer) {
            GLib.source_remove(s.idleTimer);
            s.idleTimer = 0;
        }
    }

    _armIdle(s) {
        this._clearIdle(s);
        s.idleTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, IDLE_KILL_SEC, () => {
            s.idleTimer = 0;
            if (!s.busy) {
                s.proc?.kill();
                s.proc = null;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- события Claude ----------

    _onEvent(s, ev) {
        switch (ev.type) {
        case 'bridge_error':
            s.busy = false;
            this._addItem(s, {role: 'error', text: ev.message});
            this._notifyIfHidden(s, 'Ошибка', ev.message);
            break;
        case 'system':
            if (ev.subtype === 'init' && !s.started) {
                s.started = true;
                this._saveIndex();
            }
            break;
        case 'stream_event': {
            if (ev.parent_tool_use_id)
                break; // текст сабагентов не показываем
            const e = ev.event;
            if (e.type === 'content_block_start' && e.content_block?.type === 'text')
                s.streamItem = this._addItem(s, {role: 'assistant', text: ''});
            else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
                if (!s.streamItem)
                    s.streamItem = this._addItem(s, {role: 'assistant', text: ''});
                s.streamItem.text += e.delta.text;
                this._scheduleRender(s);
            } else if (e.type === 'content_block_stop') {
                s.streamItem = null;
            }
            break;
        }
        case 'assistant':
            if (ev.parent_tool_use_id)
                break;
            for (const block of ev.message?.content ?? []) {
                if (block.type === 'tool_use')
                    this._addItem(s, {role: 'tool', text: `${block.name}: ${toolSummary(block.name, block.input)}`});
            }
            break;
        case 'control_request':
            if (ev.request?.subtype === 'can_use_tool')
                this._onPermission(s, ev);
            break;
        case 'control_cancel_request':
            for (const it of s.items ?? []) {
                if (it.role === 'perm' && it.requestId === ev.request_id && it.status === 'pending') {
                    it.status = 'cancelled';
                    this._refreshItem(s, it);
                }
            }
            break;
        case 'result':
            s.busy = false;
            s.streamItem = null;
            s.updated = Date.now();
            if (ev.is_error) {
                if (s.interrupted)
                    this._addItem(s, {role: 'info', text: 'Остановлено'});
                else
                    this._addItem(s, {role: 'error', text: ev.result || `Ошибка: ${ev.subtype}`});
            }
            s.interrupted = false;
            if (s.restartAfterTurn) {
                s.restartAfterTurn = false;
                s.proc?.kill();
                s.proc = null;
            }
            s.saveTranscript();
            this._saveIndex();
            this._armIdle(s);
            this._notifyIfHidden(s, 'Claude ответил', s.title);
            this._updateBusy();
            break;
        }
    }

    _onExit(s, status, stderr) {
        const wasBusy = s.busy;
        s.busy = false;
        s.proc = null;
        this._clearIdle(s);
        for (const it of s.items ?? []) {
            if (it.role === 'perm' && it.status === 'pending') {
                it.status = 'cancelled';
                this._refreshItem(s, it);
            }
        }
        if (wasBusy && status !== 3) { // 3 — ошибка моста, уже показана
            const tail = stderr ? `\n${stderr.split('\n').slice(-5).join('\n')}` : '';
            this._addItem(s, {role: 'error', text: `Claude Code завершился (код ${status})${tail}`});
        }
        s.saveTranscript();
        this._updateBusy();
    }

    _onPermission(s, ev) {
        const r = ev.request;
        const item = this._addItem(s, {
            role: 'perm', status: 'pending', requestId: ev.request_id,
            tool: r.tool_name, text: toolSummary(r.tool_name, r.input), description: r.description ?? r.input?.description ?? '',
            canAlways: Array.isArray(r.permission_suggestions) && r.permission_suggestions.length > 0,
        });
        // Тело запроса держим только в памяти — для ответа.
        item._input = r.input;
        item._suggestions = r.permission_suggestions;
        s.saveTranscript();
        this._notifyIfHidden(s, 'Claude просит разрешение', `${r.tool_name}: ${item.text}`);
    }

    _decide(s, item, decision) {
        if (item.status !== 'pending' || !s.proc?.alive)
            return;
        let response;
        if (decision === 'deny') {
            response = {behavior: 'deny', message: 'Пользователь запретил это действие в панели'};
        } else {
            response = {behavior: 'allow', updatedInput: item._input ?? {}};
            // «Всегда» — только в памяти этого процесса, без записи в файлы настроек.
            if (decision === 'always' && item._suggestions)
                response.updatedPermissions = item._suggestions.map(u => ({...u, destination: 'session'}));
        }
        s.proc.send({type: 'control_response',
            response: {subtype: 'success', request_id: item.requestId, response}});
        item.status = decision === 'deny' ? 'denied' : decision === 'always' ? 'always' : 'allowed';
        this._refreshItem(s, item);
        s.saveTranscript();
    }

    _notifyIfHidden(s, title, body) {
        if (!this.button.menu.isOpen || this._current !== s)
            Main.notify(title, body ?? '');
    }

    // ---------- отрисовка ----------

    _addItem(s, item) {
        s.load().push(item);
        if (s === this._current) {
            this._placeholder?.destroy();
            this._placeholder = null;
            this._chatBox.add_child(this._buildItem(s, item));
            this._scrollToEnd();
        }
        return item;
    }

    _renderChat() {
        this._chatBox.destroy_all_children();
        this._placeholder = null;
        this._itemActors = new Map();
        const items = this._current?.load() ?? [];
        if (!items.length) {
            this._placeholder = this._wrapLabel(
                'Новая сессия. Claude Code может читать файлы и выполнять команды — каждое такое действие нужно будет разрешить здесь.',
                'claude-panel-empty');
            this._chatBox.add_child(this._placeholder);
        }
        for (const it of items)
            this._chatBox.add_child(this._buildItem(this._current, it));
        this._scrollToEnd();
    }

    _wrapLabel(text, styleClass, markup = false) {
        const label = new St.Label({style_class: styleClass, x_expand: true});
        const ct = label.clutter_text;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.ellipsize = Pango.EllipsizeMode.NONE;
        if (markup)
            ct.set_markup(text);
        else
            label.text = text;
        this._makeSelectable(label);
        return label;
    }

    // Выделение мышью; Ctrl+C копирует выделенное, выделение сразу попадает в primary (средняя кнопка мыши).
    _makeSelectable(label) {
        const ct = label.clutter_text;
        label.reactive = true;
        ct.reactive = true;
        ct.selectable = true;
        ct.editable = false;
        ct.connect('button-press-event', () => {
            global.stage.set_key_focus(ct);
            return Clutter.EVENT_PROPAGATE;
        });
        ct.connect('button-release-event', () => {
            const sel = ct.get_selection();
            if (sel)
                St.Clipboard.get_default().set_text(St.ClipboardType.PRIMARY, sel);
            return Clutter.EVENT_PROPAGATE;
        });
        ct.connect('key-press-event', (_a, event) => {
            const ctrl = event.get_state() & Clutter.ModifierType.CONTROL_MASK;
            if (ctrl && event.get_key_code() === KEYCODE_C) {
                const sel = ct.get_selection();
                if (sel)
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, sel);
                return Clutter.EVENT_STOP;
            }
            if (ctrl)
                return Clutter.EVENT_PROPAGATE;
            // Любая другая клавиша — обратно в поле ввода, чтобы не терять набранное.
            global.stage.set_key_focus(this._entry.clutter_text);
            this._entry.clutter_text.event(event, false);
            return Clutter.EVENT_STOP;
        });
    }

    _copyButton(getText) {
        const btn = this._iconButton('edit-copy-symbolic', 'Копировать', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, getText());
            btn.child.icon_name = 'object-select-symbolic';
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                if (btn.get_stage())
                    btn.child.icon_name = 'edit-copy-symbolic';
                return GLib.SOURCE_REMOVE;
            });
        });
        btn.add_style_class_name('claude-panel-copy');
        return btn;
    }

    // Инлайн-markdown → St.Label с Pango-разметкой.
    _mdLabel(text, styleClass) {
        const links = [];
        const label = this._wrapLabel(safeMarkup(inlineMarkup(text, links), text), styleClass, true);
        if (links.length)
            this._makeLinksClickable(label, links);
        return label;
    }

    // Pango не умеет кликабельные ссылки: ищем подписи ссылок в готовом тексте и по координате клика
    // определяем символ под курсором. Клик без выделения — открыть URL; наведение — курсор-рука.
    _makeLinksClickable(label, links) {
        const ct = label.clutter_text;
        const ranges = links; // {url, start, end} — байтовые смещения, посчитаны парсером по разметке
        if (!ranges.length)
            return;
        const linkAt = (ex, ey) => {
            const [ok, x, y] = ct.transform_stage_point(ex, ey);
            if (!ok)
                return null;
            const pos = ct.coords_to_position(x, y);
            return ranges.find(r => pos >= r.start && pos < r.end) ?? null;
        };
        ct._linkAt = linkAt;
        ct._linkRanges = ranges;
        let hand = false;
        const setHand = on => {
            if (on === hand)
                return;
            hand = on;
            global.display.set_cursor(on ? Meta.Cursor.POINTING_HAND : Meta.Cursor.DEFAULT);
        };
        ct.connect('motion-event', (_a, event) => {
            const [ex, ey] = event.get_coords();
            setHand(!!linkAt(ex, ey));
            return Clutter.EVENT_PROPAGATE;
        });
        ct.connect('leave-event', () => {
            setHand(false);
            return Clutter.EVENT_PROPAGATE;
        });
        ct.connect('destroy', () => setHand(false));
        ct.connect('button-release-event', (_a, event) => {
            if (event.get_button() !== 1 || ct.get_selection())
                return Clutter.EVENT_PROPAGATE;
            const [ex, ey] = event.get_coords();
            const r = linkAt(ex, ey);
            if (!r)
                return Clutter.EVENT_PROPAGATE;
            setHand(false);
            try {
                const devDir = GLib.getenv('CLAUDE_PANEL_DEV_DIR');
                if (devDir) // в тестах браузер не открываем — только фиксируем, что клик попал
                    writeJson(GLib.build_filenamev([devDir, 'link.json']), {url: r.url});
                else
                    Gio.AppInfo.launch_default_for_uri(r.url, global.create_app_launch_context(event.get_time(), -1));
                this.button.menu.close(); // браузер открылся — панель больше не нужна
            } catch (e) {
                logError(e, 'claude-panel open link');
            }
            return Clutter.EVENT_STOP;
        });
    }

    // При стриминге вызывается каждые 60 мс: пересобираем только с первого изменившегося блока
    // (обычно это последний), иначе большая таблица перерисовывалась бы целиком на каждый кусочек текста.
    _fillAssistant(content, text) {
        const blocks = parseBlocks(text);
        const keys = blocks.map(b => JSON.stringify(b));
        const prev = content._mdKeys ?? [];
        let keep = 0;
        while (keep < prev.length && keep < keys.length && prev[keep] === keys[keep])
            keep++;
        const children = content.get_children();
        for (let k = keep; k < children.length; k++)
            children[k].destroy();
        content._mdKeys = keys;
        for (const b of blocks.slice(keep)) {
            switch (b.type) {
            case 'code': {
                const block = new St.BoxLayout({style_class: 'claude-panel-code'});
                block.add_child(this._wrapLabel(esc(b.text), 'claude-panel-code-text', true));
                const copy = this._copyButton(() => b.text);
                copy.y_align = Clutter.ActorAlign.START;
                block.add_child(copy);
                content.add_child(block);
                break;
            }
            case 'table':
                content.add_child(this._buildTable(b));
                break;
            case 'heading':
                content.add_child(this._mdLabel(b.text, `claude-panel-text claude-panel-h claude-panel-h${Math.min(b.level, 3)}`));
                break;
            case 'list': {
                const list = new St.BoxLayout({vertical: true, style_class: 'claude-panel-list'});
                for (const it of b.items) {
                    const row = new St.BoxLayout({style_class: 'claude-panel-li'});
                    row.set_style(`padding-left: ${it.depth * 16}px;`);
                    const marker = new St.Label({text: it.marker, style_class: 'claude-panel-li-marker',
                        y_align: Clutter.ActorAlign.START});
                    row.add_child(marker);
                    row.add_child(this._mdLabel(it.text, 'claude-panel-text'));
                    list.add_child(row);
                }
                content.add_child(list);
                break;
            }
            case 'quote': {
                const quote = new St.BoxLayout({vertical: true, style_class: 'claude-panel-quote'});
                quote.add_child(this._mdLabel(b.text, 'claude-panel-text'));
                content.add_child(quote);
                break;
            }
            case 'hr':
                content.add_child(new St.Widget({style_class: 'claude-panel-hr', x_expand: true}));
                break;
            default:
                content.add_child(this._mdLabel(b.text, 'claude-panel-text'));
            }
        }
    }

    // Таблица — строки из St.BoxLayout; Pango таблиц не умеет, а Clutter.GridLayout не считает высоту ячеек
    // по ширине (длинный текст обрезается). Ширины колонок делим пропорционально длине текста и
    // пересчитываем при изменении ширины панели — тогда St.Label сам переносит строки внутри ячейки.
    _buildTable(t) {
        const table = new St.BoxLayout({vertical: true, style_class: 'claude-panel-table', x_expand: true});
        const ncol = t.header.length;
        const weights = t.header.map((h, c) => {
            const longest = Math.max(h.length, ...t.rows.map(r => r[c].length));
            return Math.min(Math.max(longest, 3), 32) + 2; // +2 — паддинги; потолок, чтобы одна колонка не съедала всё
        });
        const sum = weights.reduce((a, b) => a + b, 0);
        const alignOf = c => ({left: Clutter.ActorAlign.START, center: Clutter.ActorAlign.CENTER,
            right: Clutter.ActorAlign.END})[t.align[c]] ?? Clutter.ActorAlign.START;
        const cols = Array.from({length: ncol}, () => []);
        const addRow = (cells, cls) => {
            const row = new St.BoxLayout({style_class: 'claude-panel-tr', x_expand: true});
            cells.forEach((text, c) => {
                const cell = new St.BoxLayout({style_class: cls, y_expand: true});
                const label = this._mdLabel(text, 'claude-panel-text');
                label.x_align = alignOf(c);
                cell.add_child(label);
                cols[c].push(cell);
                row.add_child(cell);
            });
            table.add_child(row);
        };
        addRow(t.header, 'claude-panel-th');
        t.rows.forEach((r, ri) => addRow(r, `claude-panel-td${ri % 2 ? ' odd' : ''}${ri === t.rows.length - 1 ? ' last' : ''}`));

        let lastWidth = -1;
        table.connect('notify::width', () => {
            const node = table.get_theme_node();
            const total = table.width - node.get_border_width(St.Side.LEFT) - node.get_border_width(St.Side.RIGHT);
            if (total <= 0 || total === lastWidth)
                return;
            lastWidth = total;
            let used = 0;
            weights.forEach((w, c) => {
                const px = c === ncol - 1 ? total - used : Math.floor(total * w / sum);
                used += px;
                for (const cell of cols[c])
                    cell.width = px;
            });
        });
        return table;
    }

    _buildItem(s, item) {
        let actor;
        switch (item.role) {
        case 'user':
            actor = new St.BoxLayout({style_class: 'claude-panel-msg user', x_align: Clutter.ActorAlign.END});
            actor.add_child(this._wrapLabel(item.text, 'claude-panel-text'));
            break;
        case 'assistant': {
            actor = new St.BoxLayout({vertical: true, style_class: 'claude-panel-msg assistant'});
            const content = new St.BoxLayout({vertical: true, style_class: 'claude-panel-assistant-content'});
            this._fillAssistant(content, item.text);
            actor.add_child(content);
            const copy = this._copyButton(() => item.text); // весь ответ целиком
            copy.x_align = Clutter.ActorAlign.END;
            actor.add_child(copy);
            actor._content = content;
            break;
        }
        case 'tool':
            actor = this._wrapLabel(`⚙ ${item.text}`, 'claude-panel-msg tool');
            break;
        case 'error':
            actor = this._wrapLabel(`⚠ ${item.text}`, 'claude-panel-msg error');
            break;
        case 'info':
            actor = this._wrapLabel(item.text, 'claude-panel-msg info');
            break;
        case 'perm':
            actor = this._buildPermission(s, item);
            break;
        default:
            actor = this._wrapLabel(item.text ?? '', 'claude-panel-msg info');
        }
        this._itemActors.set(item, actor);
        return actor;
    }

    _buildPermission(s, item) {
        const box = new St.BoxLayout({vertical: true, style_class: 'claude-panel-msg perm'});
        box.add_child(this._wrapLabel(`Claude хочет использовать ${item.tool}`, 'claude-panel-perm-title'));
        if (item.description)
            box.add_child(this._wrapLabel(item.description, 'claude-panel-perm-desc'));
        box.add_child(this._wrapLabel(item.text, 'claude-panel-perm-cmd'));
        if (item.status === 'pending') {
            const row = new St.BoxLayout({style_class: 'claude-panel-perm-buttons'});
            const mk = (label, cls, decision) => {
                const b = new St.Button({label, style_class: `claude-panel-perm-button ${cls}`, can_focus: true});
                b.connect('clicked', () => this._decide(s, item, decision));
                row.add_child(b);
            };
            mk('Разрешить', 'allow', 'allow');
            if (item.canAlways)
                mk('Всегда в этой сессии', 'always', 'always');
            mk('Запретить', 'deny', 'deny');
            box.add_child(row);
        } else {
            const text = {allowed: '✓ Разрешено', always: '✓ Разрешено (до конца сессии)',
                denied: '✕ Запрещено', cancelled: '— Запрос отменён'}[item.status] ?? item.status;
            box.add_child(this._wrapLabel(text, `claude-panel-perm-status ${item.status}`));
        }
        return box;
    }

    _refreshItem(s, item) {
        if (s !== this._current)
            return;
        const old = this._itemActors.get(item);
        if (!old)
            return;
        const fresh = this._buildItem(s, item);
        this._chatBox.replace_child(old, fresh);
        old.destroy();
    }

    _scheduleRender(s) {
        if (s !== this._current || this._renderPending)
            return;
        this._renderPending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._renderPending = 0;
            const item = s.streamItem ?? [...(s.items ?? [])].reverse().find(i => i.role === 'assistant');
            const actor = item && this._itemActors.get(item);
            if (actor?._content)
                this._fillAssistant(actor._content, item.text);
            this._scrollToEnd();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scrollToEnd() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const adj = this._chatScroll?.vadjustment;
            if (adj)
                adj.value = adj.upper - adj.page_size;
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- dev-хук для тестов во вложенном GNOME Shell ----------

    devCommand(cmd) {
        switch (cmd.op) {
        case 'open': this.button.menu.open(); break;
        case 'close': this.button.menu.close(); break;
        case 'type': this._entry.text = cmd.text; break;
        case 'send': this._submit(); break;
        case 'inject': { // показать ответ ассистента без запуска Claude (проверка рендера)
            if (!this._current)
                this._newSession();
            this._addItem(this._current, {role: cmd.role ?? 'assistant', text: cmd.text ?? ''});
            break;
        }
        case 'linkat': { // какая ссылка под точкой сцены (проверка попадания без реального клика)
            let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, cmd.x, cmd.y);
            if (actor instanceof St.Label)
                actor = actor.clutter_text;
            const [ok, lx, ly] = actor?.transform_stage_point?.(cmd.x, cmd.y) ?? [false, 0, 0];
            writeJson(cmd.path, {actor: actor?.constructor.name ?? null, link: actor?._linkAt?.(cmd.x, cmd.y)?.url ?? null,
                pos: ok && actor instanceof Clutter.Text ? actor.coords_to_position(lx, ly) : null, local: [lx, ly],
                text: actor?.text ?? null, ranges: actor?._linkRanges ?? null});
            break;
        }
        case 'stop': this._interrupt(); break;
        case 'new': this._newSession(); break;
        case 'terminal': this._openTerminal(); break;
        case 'dictate': this._toggleDictation(false); break;
        case 'windows': writeJson(cmd.path, global.get_window_actors().map(a => ({cls: a.meta_window.get_wm_class(), title: a.meta_window.get_title(), rect: (r => [r.x, r.y, r.width, r.height])(a.meta_window.get_frame_rect())}))); break;
        case 'dump': writeJson(cmd.path, {entry: this._entry.text, dictating: this._dictating,
            handyLastId: this._handyLastId}); break;
        case 'model': this._cycleModel(); break;
        case 'list': this._showView('list'); break;
        case 'chat': this._showView('chat'); break;
        case 'select': this._openSession([...this._sessions].sort((a, b) => b.updated - a.updated)[cmd.index]);
            this._showView('chat'); break;
        case 'decide': {
            const s = this._current;
            const item = [...(s.items ?? [])].reverse().find(i => i.role === 'perm' && i.status === 'pending');
            if (item)
                this._decide(s, item, cmd.decision);
            break;
        }
        }
    }

    destroy() {
        this._unwatchTerminalWindow();
        this._handyMonitor?.cancel();
        if (this._handyPending)
            GLib.source_remove(this._handyPending);
        if (this._renderPending)
            GLib.source_remove(this._renderPending);
        for (const s of this._sessions) {
            this._clearIdle(s);
            s.proc?.kill();
        }
        if (this._current && !this._isSaved(this._current))
            this._current.proc?.kill();
        this.button.destroy();
    }
}

export default class ClaudePanelExtension extends Extension {
    enable() {
        this._panel = new ClaudePanel(this);
        this._insertButton();

        Main.wm.addKeybinding('toggle-panel', this.getSettings(), Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._panel.button.menu.toggle());

        // На экране блокировки прячемся; процессы при этом продолжают работать.
        this._sessionModeId = Main.sessionMode.connect('updated', () => this._syncSessionMode());
        this._syncSessionMode();
        this._setupDevHook();
    }

    _insertButton() {
        // Рядом с AI Limits: сразу слева от его индикатора.
        const ai = Main.panel.statusArea[AI_LIMITS_UUID];
        let position = 0;
        if (ai) {
            const idx = Main.panel._rightBox.get_children().indexOf(ai.container);
            if (idx >= 0)
                position = idx;
        }
        Main.panel.addToStatusArea(this.uuid, this._panel.button, position, 'right');
    }

    _syncSessionMode() {
        const locked = Main.sessionMode.isLocked;
        if (locked)
            this._panel.button.menu.close();
        this._panel.button.visible = !locked;
    }

    _setupDevHook() {
        const dir = GLib.getenv('CLAUDE_PANEL_DEV_DIR');
        if (!dir)
            return;
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'cmd.json']));
        this._devMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._devMonitor.connect('changed', (_m, _f, _o, type) => {
            if (type !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && type !== Gio.FileMonitorEvent.CREATED)
                return;
            try {
                const cmd = readJson(file.get_path(), null);
                // Переименование файла даёт несколько событий — выполняем каждую команду один раз.
                if (!cmd || cmd.seq === this._devSeq)
                    return;
                this._devSeq = cmd.seq;
                if (cmd.op === 'shot') {
                    const stream = Gio.File.new_for_path(cmd.path).replace(null, false, Gio.FileCreateFlags.NONE, null);
                    new Shell.Screenshot().screenshot(false, stream, (o, res) => {
                        try {
                            o.screenshot_finish(res);
                        } catch (e) {
                            logError(e, 'claude-panel dev shot');
                        }
                        stream.close(null);
                    });
                } else {
                    this._panel.devCommand(cmd);
                }
            } catch (e) {
                logError(e, 'claude-panel dev');
            }
        });
    }

    disable() {
        this._devMonitor?.cancel();
        this._devMonitor = null;
        Main.wm.removeKeybinding('toggle-panel');
        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }
        this._panel?.destroy();
        this._panel = null;
    }
}
