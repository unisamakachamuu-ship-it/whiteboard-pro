"""
Build a static copy of the whiteboard into dist/, for drag-and-drop hosting
(Netlify Drop, Cloudflare Pages, Firebase Hosting, GitHub Pages).

Why this works at all: templates/index.html contains 46 Jinja tags and every
single one of them is `url_for('static', filename=...)`. There is no server
rendered state in the page, so rewriting those to plain /static/ paths turns
it into an ordinary HTML file. All the whiteboard logic already runs in the
browser.

What you get without the Flask backend:

  works    the canvas, every tool, themes, templates, undo, the command
           palette, and board sync through Firebase once signed in
  works    boards saved in the browser (localStorage) when signed out
  gone     /api/upload — images and file attachments have nowhere to go
  gone     the Google Workspace panel (Calendar, Gmail, Docs, Drive, Tasks,
           Sheets) and Google Keep, which are server-side proxies
  gone     /voice/<board> — the phone companion page is server-rendered

app.js already treats a missing backend as an offline server: it tries
Firebase first, then Flask, then the local copy, and when Firebase is signed
in the failed Flask call is silent (see save() and loadBoard()). So a signed
in user sees no errors at all.

Usage:  python build_static.py
"""

import os
import re
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(BASE_DIR, 'dist')

# {{ url_for('static', filename='css/style.css') }}  ->  /static/css/style.css
URL_FOR = re.compile(
    r"""\{\{\s*url_for\(\s*['"]static['"]\s*,\s*filename\s*=\s*['"](?P<f>[^'"]+)['"]\s*\)\s*\}\}"""
)

# Uploads are the previous instance's user data, not part of the app, and
# _selftest is a development harness — neither belongs in a fresh deploy.
SKIP_DIRS = {'uploads'}
SKIP_FILES = {'_selftest.html', '_selftest.js'}


def build():
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST)

    # 1. index.html, with the Jinja tags resolved.
    src = os.path.join(BASE_DIR, 'templates', 'index.html')
    with open(src, encoding='utf-8') as f:
        html = f.read()

    html, n = URL_FOR.subn(lambda m: '/static/' + m.group('f'), html)

    leftover = re.findall(r'\{\{.*?\}\}|\{%.*?%\}', html)
    if leftover:
        raise SystemExit(
            'Unresolved template syntax left in index.html — a static build '
            'would ship it verbatim to the browser:\n  '
            + '\n  '.join(leftover[:10])
        )

    with open(os.path.join(DIST, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'index.html          {n} url_for tags rewritten')

    # 2. static/, minus the previous instance's uploads.
    copied = 0
    for root, dirs, files in os.walk(os.path.join(BASE_DIR, 'static')):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name in SKIP_FILES:
                continue
            abs_src = os.path.join(root, name)
            rel = os.path.relpath(abs_src, BASE_DIR)
            abs_dst = os.path.join(DIST, rel)
            os.makedirs(os.path.dirname(abs_dst), exist_ok=True)
            shutil.copy2(abs_src, abs_dst)
            copied += 1
    print(f'static/             {copied} files copied')

    total = sum(
        os.path.getsize(os.path.join(r, n))
        for r, _, fs in os.walk(DIST) for n in fs
    )
    print(f'\ndist/ ready         {total / 1024 / 1024:.1f} MB')
    print('Drag the dist folder onto https://app.netlify.com/drop')


if __name__ == '__main__':
    build()
