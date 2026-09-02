"""
WSGI entry point for PythonAnywhere.

PythonAnywhere does not run the Dockerfile and does not use gunicorn — it
imports a module and looks for a callable named `application`. Point the
"WSGI configuration file" box on the Web tab at this file (or paste its
contents into the file it already made for you) and set the virtualenv path
just below it.

Everything the app needs is read from the environment or from a .env file
sitting next to app.py, exactly as it is locally, so there is nothing to
configure in here beyond the project path.
"""

import os
import sys

# ---------------------------------------------------------------------------
# Point this at the checkout. Change USERNAME to your PythonAnywhere username.
# ---------------------------------------------------------------------------
PROJECT_DIR = '/home/USERNAME/whiteboard-pro'

if PROJECT_DIR not in sys.path:
    # insert, not append: a stale copy of this project earlier on the path
    # would otherwise win the import.
    sys.path.insert(0, PROJECT_DIR)

# app.py resolves data/ and static/uploads/ relative to its own location, so
# it does not depend on the working directory — but Flask's template loader
# and anything that shells out does, and PythonAnywhere starts workers in /.
os.chdir(PROJECT_DIR)

# ---------------------------------------------------------------------------
# Outbound access on a free account
# ---------------------------------------------------------------------------
# A free PythonAnywhere account cannot open a socket to the internet
# directly; everything has to go through their HTTP proxy, and only to sites
# on their allowlist (Google's APIs are on it). Consoles get these variables
# set for them, web app workers do not — so without this block every
# server-side Google call dies with:
#
#     [Errno 101] Network is unreachable
#
# requests, httplib2 and google-auth all read these, which covers the whole
# Google Workspace OAuth exchange and the REST APIs behind it.
#
# What this does NOT fix: firebase-admin talks to Firestore over gRPC, which
# ignores HTTP proxies, so /api/auth/firebase-token stays unavailable on a
# free account. Nothing user-facing depends on it — signing in and board sync
# both run in the browser, which is not behind this firewall.
PROXY = 'http://proxy.server:3128'
for _var in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
    os.environ[_var] = PROXY

# ...except httplib2, which ignores those variables, and which is what
# google-api-python-client builds every Drive, Gmail, Calendar, Docs, Tasks
# and Sheets request on. That split is why the OAuth exchange (requests)
# could succeed while all six of those endpoints returned 500. httplib2
# wants the proxy as an object, and googleapiclient constructs its Http
# instances internally, so the default has to be patched.
try:
    import httplib2

    # httplib2 routes every proxied connection through socks.socksocket and
    # sets its own .socks to None when no socks module can be imported —
    # leaving it unable to proxy at all. `pip install PySocks` supplies it.
    # PROXY_TYPE_HTTP is 3; prefer the module's own constant when available.
    _socks = getattr(httplib2, 'socks', None)
    _PROXY_INFO = httplib2.ProxyInfo(
        getattr(_socks, 'PROXY_TYPE_HTTP', 3), 'proxy.server', 3128)
    _http_init = httplib2.Http.__init__

    def _http_init_proxied(self, *args, **kwargs):
        # proxy_info is the third positional parameter; only fill it in when
        # the caller supplied it neither positionally nor by keyword.
        if len(args) < 3 and 'proxy_info' not in kwargs:
            kwargs['proxy_info'] = _PROXY_INFO
        _http_init(self, *args, **kwargs)

    httplib2.Http.__init__ = _http_init_proxied
except Exception:
    # Not on PythonAnywhere, or httplib2 absent — the app runs either way.
    pass

# app.py loads PROJECT_DIR/.env itself on import. Create that file on the
# server (see DEPLOY.md) for GOOGLE_CLIENT_ID and friends. Anything set here
# instead would also work:
#
#   os.environ.setdefault('SECRET_KEY', '...')
#
# but leaving SECRET_KEY unset is fine — app.py generates one into
# data/.secret_key and PythonAnywhere's disk is persistent, so it survives
# reloads and nobody gets signed out.

from app import app as application  # noqa: E402  (path setup must come first)
