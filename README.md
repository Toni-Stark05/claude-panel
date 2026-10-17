# Claude Panel — расширение GNOME Shell

Быстрый чат с Claude Code из верхней панели GNOME: свои сессии, подтверждение действий,
голосовой ввод через Handy (опционально). Весь трафик идёт через HTTP-прокси.

## Требования

- GNOME Shell 47 (в `metadata.json` указана только она; на других версиях не проверялось).
- [Claude Code](https://docs.anthropic.com/claude-code) с выполненным входом (`claude` в `PATH` или `~/.local/bin/claude`).
- `python3`, `curl`, `glib-compile-schemas` (пакет `glib2`/`libglib2.0-bin`).
- HTTP/HTTPS-прокси. Панель **не запускается без доступного прокси** (fail closed), SOCKS не поддерживается.

## Установка

```bash
git clone <url> claude-panel && cd claude-panel
./install.sh
```

Скрипт кладёт расширение в `~/.local/share/gnome-shell/extensions/claude-panel@tonistark`,
скрипты моста — в `~/.local/lib/claude-panel/`, и, если конфига нет, копирует `config.example`
в `~/.config/ask-claude/config`. Откройте этот файл и впишите свой `PROXY_URL`.
Утилита `ask-claude` сама не нужна — только этот файл.

После установки перелогиньтесь. Панель открывается по `Super+Shift+C` или кликом по значку.

## Настройки

Хранятся в gsettings (`org.gnome.shell.extensions.claude-panel`):

```bash
# кнопка терминала: по умолчанию выполняет команду `cds` в ~/code — это личный алиас автора,
# замените на свою команду и папку:
gsettings set org.gnome.shell.extensions.claude-panel terminal-command 'claude'
gsettings set org.gnome.shell.extensions.claude-panel terminal-directory '~'
# режим разрешений: auto (безопасное одобряется само) или default (спрашивать о каждом действии)
gsettings set org.gnome.shell.extensions.claude-panel permission-mode 'default'
# модель для новых сессий: sonnet | haiku | opus
gsettings set org.gnome.shell.extensions.claude-panel default-model 'sonnet'
# хоткей
gsettings set org.gnome.shell.extensions.claude-panel toggle-panel "['<Super><Shift>c']"
```

Переменные окружения моста: `ASK_CLAUDE_CONFIG_DIR`, `CLAUDE_PANEL_CLAUDE_BIN`,
`CLAUDE_PANEL_WORKSPACE`, `CLAUDE_PANEL_STATE_DIR`, `CLAUDE_PANEL_HANDY_DB`.

## Как устроено

- `extension/` — само расширение; только рисует UI.
- `bridge/bridge.py` — проверяет прокси, чистит окружение и делает `exec claude -p --input-format stream-json ...`
  в отдельной папке `~/.local/share/claude-panel/workspace`, чтобы сессии панели не смешивались с остальными.
- `bridge/handy.py` — голосовой ввод через [Handy](https://handy.computer); без Handy просто не используется.
- Список сессий и лог: `~/.local/state/claude-panel/`.

## Удаление

```bash
gnome-extensions disable claude-panel@tonistark
rm -rf ~/.local/share/gnome-shell/extensions/claude-panel@tonistark ~/.local/lib/claude-panel
```
