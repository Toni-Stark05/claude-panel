#!/usr/bin/env bash
# Установка claude-panel для текущего пользователя.
set -euo pipefail
cd "$(dirname "$0")"

UUID=claude-panel@tonistark
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
LIB_DIR="$HOME/.local/lib/claude-panel"
CONFIG="${ASK_CLAUDE_CONFIG_DIR:-$HOME/.config/ask-claude}/config"

for c in python3 curl glib-compile-schemas; do
  command -v "$c" >/dev/null || { echo "Нужна программа: $c" >&2; exit 1; }
done
if ! command -v claude >/dev/null && [ ! -x "$HOME/.local/bin/claude" ]; then
  echo "Не найден claude (Claude Code). Установите его: https://docs.anthropic.com/claude-code" >&2
  exit 1
fi

mkdir -p "$EXT_DIR" "$LIB_DIR"
cp -r extension/. "$EXT_DIR/"
glib-compile-schemas "$EXT_DIR/schemas"
install -m 644 bridge/bridge.py bridge/handy.py "$LIB_DIR/"

if [ ! -f "$CONFIG" ]; then
  mkdir -p "$(dirname "$CONFIG")"
  install -m 600 config.example "$CONFIG"
  echo "Создан $CONFIG — впишите туда свой PROXY_URL (без него панель не запустится)."
fi

if command -v gnome-extensions >/dev/null; then
  gnome-extensions enable "$UUID" 2>/dev/null || true
fi
echo "Готово. Перелогиньтесь в GNOME (на Wayland перезапуск Shell иначе невозможен), затем Super+Shift+C."
