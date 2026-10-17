#!/usr/bin/python3 -I
"""Хелпер claude-panel для голосового ввода через Handy.

  handy.py last-id DB          id последней записи в истории Handy (0, если пусто)
  handy.py since DB ID         самая новая запись с id > ID: {"id":..,"text":..} или {}
  handy.py release             завершить зависший wl-copy, запущенный Handy

Пока открыто меню GNOME Shell (панель Claude), wl-copy не может получить фокус и висит,
а после закрытия панели Handy вставил бы текст в другое окно. Панель вставляет текст сама
и снимает этот wl-copy.
"""
import json
import os
import signal
import sqlite3
import sys


def connect(db):
    return sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=2)


def last_id(db):
    with connect(db) as c:
        row = c.execute('select coalesce(max(id), 0) from transcription_history').fetchone()
    print(row[0])


def since(db, min_id):
    with connect(db) as c:
        row = c.execute('select id, transcription_text, post_processed_text, post_process_requested '
                        'from transcription_history where id > ? order by id desc limit 1', (min_id,)).fetchone()
    if not row:
        print('{}')
        return
    rid, text, post, requested = row
    if requested and post:
        text = post
    print(json.dumps({'id': rid, 'text': text or ''}, ensure_ascii=False))


def proc_field(pid, name):
    try:
        with open(f'/proc/{pid}/status') as f:
            for line in f:
                if line.startswith(name + ':'):
                    return line.split(':', 1)[1].strip()
    except OSError:
        return None
    return None


def release():
    handy = {p for p in os.listdir('/proc') if p.isdigit() and proc_field(p, 'Name') == 'handy'
             and int(proc_field(p, 'Uid').split()[0]) == os.getuid()}
    killed = 0
    for p in os.listdir('/proc'):
        if p.isdigit() and proc_field(p, 'Name') == 'wl-copy' and proc_field(p, 'PPid') in handy:
            try:
                os.kill(int(p), signal.SIGTERM)
                killed += 1
            except OSError:
                pass
    print(killed)


def main(argv):
    try:
        if len(argv) == 3 and argv[1] == 'last-id':
            last_id(argv[2])
        elif len(argv) == 4 and argv[1] == 'since':
            since(argv[2], int(argv[3]))
        elif len(argv) == 2 and argv[1] == 'release':
            release()
        else:
            print(__doc__, file=sys.stderr)
            return 2
    except Exception as e:  # noqa: BLE001
        print(f'handy.py: {e}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
