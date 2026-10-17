#!/usr/bin/python3 -I
"""Мост между GNOME-расширением claude-panel и Claude Code.

  bridge.py --session-id UUID --model MODEL    новая сессия
  bridge.py --resume UUID --model MODEL        продолжить сессию

Берёт прокси из ~/.config/ask-claude/config (тот же, что у ask-claude), проверяет его
(fail closed: без прокси не запускаемся), выставляет переменные окружения и делает exec claude
в режиме stream-json. Дальше расширение общается с claude напрямую через stdin/stdout.
Ошибка до запуска claude — одна строка {"type":"bridge_error","message":...} в stdout и код 3.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

HOME = os.path.expanduser('~')
CONFIG = os.path.join(os.environ.get('ASK_CLAUDE_CONFIG_DIR') or os.path.join(HOME, '.config/ask-claude'), 'config')
WORKSPACE = os.environ.get('CLAUDE_PANEL_WORKSPACE') or os.path.join(HOME, '.local/share/claude-panel/workspace')
STATE_DIR = os.environ.get('CLAUDE_PANEL_STATE_DIR') or os.path.join(HOME, '.local/state/claude-panel')
LOG = os.path.join(STATE_DIR, 'log')
CLAUDE = os.environ.get('CLAUDE_PANEL_CLAUDE_BIN') or (
    os.path.join(HOME, '.local/bin/claude') if os.path.isfile(os.path.join(HOME, '.local/bin/claude'))
    else shutil.which('claude') or os.path.join(HOME, '.local/bin/claude'))
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
MODEL_RE = re.compile(r'^[A-Za-z0-9.\-\[\]_]+$')


def mask(s):
    return re.sub(r'(://[^:/@]+:)[^@]+@', r'\1***@', s)


def log(msg):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    with open(LOG, 'a') as f:
        f.write(f'{time.strftime("%F %T")} [{os.getpid()}] {mask(msg)}\n')


def fail(msg):
    log('ERROR: ' + msg)
    sys.stdout.write(json.dumps({'type': 'bridge_error', 'message': msg}, ensure_ascii=False) + '\n')
    sys.stdout.flush()
    sys.exit(3)


def load_config():
    if not os.path.isfile(CONFIG):
        fail(f'Нет конфига {CONFIG}')
    # Конфиг — bash-файл; читаем его тем же bash, что и ask-claude.
    out = subprocess.run(
        ['bash', '-c', 'source "$1"; printf "%s\\0%s\\0%s\\0" "$PROXY_URL" "${NO_PROXY:-localhost,127.0.0.1,::1}" '
                       '"${PROXY_CHECK_URL:-https://api.anthropic.com/}"', '_', CONFIG],
        capture_output=True, text=True, timeout=10, env={'PATH': '/usr/bin:/bin', 'HOME': HOME})
    parts = out.stdout.split('\0')
    if len(parts) < 3:
        fail('Не удалось прочитать конфиг прокси')
    return parts[0], parts[1], parts[2]


def check_proxy(proxy, url):
    # Пароль передаём через stdin (-K -), чтобы он не светился в списке процессов.
    r = subprocess.run(['curl', '-K', '-', '--noproxy', '', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '10', url],
                       input=f'proxy = "{proxy}"\n', capture_output=True, text=True, timeout=20)
    code = r.stdout.strip()
    log(f'proxy check http_code={code}')
    return code not in ('', '000', '407')


def main(argv):
    args = dict(zip(argv[1::2], argv[2::2]))
    sid = args.get('--session-id') or args.get('--resume') or ''
    model = args.get('--model', 'sonnet')
    perm_mode = args.get('--permission-mode', 'default')
    if perm_mode not in ('default', 'auto'):
        fail('Неверный режим разрешений')
    if not UUID_RE.match(sid) or not MODEL_RE.match(model):
        fail('Неверные аргументы моста')

    proxy, no_proxy, check_url = load_config()
    if not proxy:
        fail('PROXY_URL не задан в ~/.config/ask-claude/config — без прокси не запускаюсь')
    if not re.match(r'^https?://', proxy):
        fail('PROXY_URL должен быть http:// или https:// (SOCKS Claude Code не поддерживает)')
    if not check_proxy(proxy, check_url):
        fail('Прокси недоступен — запрос не отправлен (прямое соединение запрещено)')

    # Чистое окружение по белому списку: никаких унаследованных CLAUDE*/ANTHROPIC*/прокси-переменных
    # (например, если оболочку запустили из другой сессии Claude Code — тогда claude взял бы её режим).
    keep = ('HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LANGUAGE', 'XDG_RUNTIME_DIR',
            'DBUS_SESSION_BUS_ADDRESS', 'WAYLAND_DISPLAY', 'DISPLAY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP')
    env = {k: v for k, v in os.environ.items() if k in keep or k.startswith('LC_')}
    env.update({
        'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy, 'http_proxy': proxy, 'https_proxy': proxy,
        'NO_PROXY': no_proxy, 'no_proxy': no_proxy,
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
        'ENABLE_CLAUDEAI_MCP_SERVERS': 'false',
    })
    os.makedirs(WORKSPACE, exist_ok=True)
    os.chdir(WORKSPACE)  # отдельная папка → сессии панели не смешиваются с остальными

    cmd = [CLAUDE, '-p',
           '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
           '--include-partial-messages',
           '--permission-prompt-tool', 'stdio',      # запросы разрешений → в панель
           '--setting-sources', '',                  # без чужих хуков/плагинов/allow-правил
           '--strict-mcp-config',
           '--disallowed-tools', 'AskUserQuestion',  # интерактивных вопросов в панели нет
           '--permission-mode', perm_mode,           # auto или default — задаётся в панели; всегда явно
           '--model', model]
    cmd += ['--resume', sid] if '--resume' in args else ['--session-id', sid]
    log(f'exec claude {"resume" if "--resume" in args else "new"} session={sid} model={model} mode={perm_mode}')
    os.execve(CLAUDE, cmd, env)


if __name__ == '__main__':
    main(sys.argv)
