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
