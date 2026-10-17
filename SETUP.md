# Инструкция: настроить Claude Code «как у автора» и поставить Claude Panel

Этот файл можно целиком отдать Claude Code: `claude "прочитай SETUP.md из этого репозитория и выполни его по шагам, спрашивая меня, где нужны мои данные"`.
Ожидаемое окружение: Fedora/любой Linux, GNOME Shell 47, bash.

## 0. Что понадобится от пользователя

- Адрес HTTP-прокси вида `http://USER:PASSWORD@HOST:PORT` (SOCKS не подходит).
- Выполненный вход в Claude Code (`claude` → `/login`).

## 1. Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash     # ставит ~/.local/bin/claude
claude --version                                   # у автора: 2.1.302
```

## 2. Прокси в оболочке (как у автора)

Добавить в `~/.bashrc` (подставить свой адрес прокси):

```bash
# ===== PROXY CONFIG (HTTP) =====
PROXY_URL="http://USER:PASSWORD@HOST:PORT"

proxy_run() {            # запускает команду только если прокси включён
    if [ -z "$HTTP_PROXY" ]; then
        echo -e "\e[1;33m[WARN]\e[0m \e[33mProxy is off. Cannot run $1\e[0m"
    else
        shift; "$@"
    fi
}
proxy_check() {
    if [ -z "$HTTP_PROXY" ]; then echo -e "\e[31mProxy is off.\e[0m"
    else echo -e "\e[32mProxy on. Your IP: $(curl -s https://icanhazip.com)\e[0m"; fi
}
alias proxy_on='export HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL" http_proxy="$PROXY_URL" https_proxy="$PROXY_URL"; echo -e "\e[32mProxy enabled (HTTP)\e[0m"'
alias proxy_off='unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; echo -e "\e[31mProxy disabled\e[0m"'

proxy_on      # прокси включается при каждом запуске оболочки
proxy_check

# Claude Code всегда с личным плагином; cds — то же самое, но откажется стартовать без прокси
alias claude='claude --plugin-dir ~/.claude/my-plugin --verbose'
alias cds='proxy_run cds claude --plugin-dir ~/.claude/my-plugin --verbose'
alias cdt='CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 proxy_run cdt claude --plugin-dir ~/.claude/my-plugin --verbose'
```

Затем `source ~/.bashrc` и проверить, что `proxy_check` показывает IP прокси.
Если личного плагина (`~/.claude/my-plugin`, см. п. 4) нет — уберите `--plugin-dir ~/.claude/my-plugin` из алиасов, иначе `claude` не стартует.

## 3. Плагины Claude Code автора

Установленные через маркетплейсы (ставятся внутри `claude` командами `/plugin`):

| Плагин | Маркетплейс | Состояние у автора |
|---|---|---|
| `superpowers` 5.0.5 | `obra/superpowers-marketplace` | включён |
| `claude-mem` 13.41.0 | `thedotmack/claude-mem` | установлен, **выключен** |

```bash
claude plugin marketplace add obra/superpowers-marketplace
claude plugin install superpowers@superpowers-marketplace
# по желанию (у автора выключен):
claude plugin marketplace add thedotmack/claude-mem
claude plugin install claude-mem@thedotmack
```

Настройки `~/.claude/settings.json`, которые стоит повторить:

```json
{
  "env": { "CLAUDE_CODE_FORK_SUBAGENT": "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1" },
  "enabledPlugins": { "superpowers@superpowers-marketplace": true },
  "extraKnownMarketplaces": {
    "superpowers-marketplace": { "source": { "source": "github", "repo": "obra/superpowers-marketplace" } }
  }
}
```

Остальное у автора (модель, хуки, статус-лайн от Orca, рабочие скиллы `dh-*`) — личное/рабочее и для копирования не предназначено.

## 4. Личный плагин `personal` (`~/.claude/my-plugin`)

Это локальный плагин автора (NX-миграционный тулкит: скиллы `nx-*`, агенты `dependency-mapper`, `infrastructure-scanner`, `service-analyzer`, `utility-cataloger`). В этот репозиторий он не входит — попросите у автора отдельно и распакуйте в `~/.claude/my-plugin`. Подключается он не установкой, а флагом `--plugin-dir ~/.claude/my-plugin` (уже в алиасах выше); проверка: внутри `claude` набрать `/personal:` и увидеть список скиллов.

## 5. Claude Panel (расширение GNOME из этого репозитория)

```bash
git clone git@github.com:Toni-Stark05/claude-panel.git ~/code/claude-panel
cd ~/code/claude-panel && ./install.sh
```

Скрипт:
- копирует расширение в `~/.local/share/gnome-shell/extensions/claude-panel@tonistark` и компилирует gschema;
- кладёт `bridge.py` и `handy.py` в `~/.local/lib/claude-panel/`;
- если нет `~/.config/ask-claude/config`, создаёт его из `config.example` — **впишите туда свой `PROXY_URL`** (права 600). Без доступного прокси панель не запускается.

Потом перелогиниться в GNOME. Открыть панель: `Super+Shift+C`.

Кнопка «терминал» в панели по умолчанию запускает `cds` в `~/code` (алиас из п. 2). Если алиаса нет:

```bash
gsettings set org.gnome.shell.extensions.claude-panel terminal-command 'claude'
gsettings set org.gnome.shell.extensions.claude-panel terminal-directory '~'
```

Другие настройки и устройство — в `README.md`.

## 6. Проверка

```bash
proxy_check                                   # IP прокси
claude -p "скажи ок"                          # ответ через прокси
gnome-extensions info claude-panel@tonistark  # State: ACTIVE после релогина
tail ~/.local/state/claude-panel/log          # лог моста, если панель не отвечает
```
