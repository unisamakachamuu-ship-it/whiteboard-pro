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
