#!/bin/bash
# ---------------------------------------------------------------------------
# One-shot repair for a PythonAnywhere deployment.
#
#   cd ~/whiteboard-pro && git pull && bash fix_pythonanywhere.sh
#
# Safe to run repeatedly. It rewrites the WSGI file, installs the
# requirements into the virtualenv (not the system Python, which is the
# mistake a fresh console invites), checks .env, tests that outbound traffic
# actually works through the proxy, and reloads the web app.
# ---------------------------------------------------------------------------

set -u

USERNAME="$(whoami)"
PROJECT_DIR="$HOME/whiteboard-pro"
VENV="$HOME/.virtualenvs/whiteboard"
WSGI="/var/www/${USERNAME}_pythonanywhere_com_wsgi.py"
PROXY="http://proxy.server:3128"

ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
info() { printf '  ...   %s\n' "$1"; }
head1() { printf '\n\033[1m%s\033[0m\n' "$1"; }

echo "=================================================="
echo " WhiteBoard Pro - PythonAnywhere repair"
echo " user: $USERNAME"
echo "=================================================="

# --- 1. sanity -------------------------------------------------------------
head1 "1. Locations"
[ -d "$PROJECT_DIR" ] && ok "project  $PROJECT_DIR" || { bad "no project at $PROJECT_DIR"; exit 1; }
[ -d "$VENV" ]        && ok "venv     $VENV"        || { bad "no virtualenv at $VENV"; exit 1; }
[ -f "$WSGI" ]        && ok "wsgi     $WSGI"        || info "wsgi file will be created: $WSGI"

# --- 2. WSGI file ----------------------------------------------------------
# Written fresh every run so a half-edited file cannot linger. The proxy
# variables are the important part: a free account cannot open sockets
# directly, and web workers (unlike consoles) are not given these, so every
# server-side Google call dies with [Errno 101] Network is unreachable.
head1 "2. WSGI configuration"
cat > "$WSGI" <<EOF
import os
import sys

PROJECT_DIR = '$PROJECT_DIR'

if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

os.chdir(PROJECT_DIR)

# Free accounts reach the internet only through this proxy, and only for
# allowlisted hosts. requests, httplib2 and google-auth all read these.
PROXY = '$PROXY'
for _v in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
    os.environ[_v] = PROXY

from app import app as application
EOF
ok "written with proxy settings"

# --- 3. dependencies -------------------------------------------------------
# Activating explicitly: a fresh console has no virtualenv, and pip would
# silently do a --user install against the system Python that the web app
# cannot see.
head1 "3. Dependencies (inside the virtualenv)"
# shellcheck disable=SC1091
source "$VENV/bin/activate"
info "python: $(python --version 2>&1) at $(command -v python)"

case "$(command -v python)" in
  "$VENV"/*) ok "using the virtualenv" ;;
  *) bad "not inside the virtualenv - aborting before a stray --user install"; exit 1 ;;
esac

cd "$PROJECT_DIR"
if pip install -q -r requirements.txt 2>/tmp/pipfail; then
  ok "requirements.txt installed"
else
  bad "pip failed:"; tail -5 /tmp/pipfail
fi

python - <<'PY'
mods = ['flask', 'flask_cors', 'googleapiclient', 'google_auth_oauthlib', 'firebase_admin']
for m in mods:
    try:
        __import__(m)
        print('  OK    import %s' % m)
    except Exception as e:
        print('  FAIL  import %s -> %s' % (m, e))
PY

# --- 4. .env ---------------------------------------------------------------
head1 "4. Google credentials (.env)"
if [ -f "$PROJECT_DIR/.env" ]; then
  for key in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI; do
    if grep -q "^${key}=." "$PROJECT_DIR/.env"; then ok "$key set"; else bad "$key missing or empty"; fi
  done
  want="https://${USERNAME}.pythonanywhere.com/api/google/callback"
  if grep -q "^GOOGLE_REDIRECT_URI=${want}$" "$PROJECT_DIR/.env"; then
    ok "redirect URI matches this host"
  else
    bad "GOOGLE_REDIRECT_URI should be exactly:"
    echo "        $want"
    echo "        (and the identical string must be in Google Cloud Console)"
  fi
else
  bad "no .env - Google Workspace stays disabled"
  echo "        create $PROJECT_DIR/.env with GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI"
fi

# --- 5. outbound test ------------------------------------------------------
# The real question behind the 500s: can this account reach Google at all?
head1 "5. Outbound connectivity through the proxy"
export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"
python - <<'PY'
import os
print('  ...   proxy =', os.environ.get('HTTPS_PROXY'))

try:
    import requests
    r = requests.get('https://oauth2.googleapis.com/', timeout=25)
    print('  OK    requests  -> oauth2.googleapis.com  HTTP %s' % r.status_code)
except Exception as e:
    print('  FAIL  requests  -> %s: %s' % (type(e).__name__, e))

# google-api-python-client uses httplib2, not requests. It reads the same
# environment variables but through its own code path, so it is tested
# separately - this is the one that backs /api/google/drive/list etc.
try:
    import httplib2
    h = httplib2.Http(timeout=25)
    resp, _ = h.request('https://www.googleapis.com/discovery/v1/apis', 'GET')
    print('  OK    httplib2  -> www.googleapis.com     HTTP %s' % resp.status)
except Exception as e:
    print('  FAIL  httplib2  -> %s: %s' % (type(e).__name__, e))
PY

# --- 6. app import ---------------------------------------------------------
head1 "6. Importing the app the way the web worker does"
python -c "import app; print('  OK    app imported, %d routes' % len(list(app.app.url_map.iter_rules())))" \
  || bad "app failed to import - the site would return 502"

# --- 7. reload -------------------------------------------------------------
# Touching the WSGI file is what makes PythonAnywhere pick up new code; it is
# the console equivalent of the green Reload button.
head1 "7. Reloading the web app"
touch "$WSGI" && ok "reload triggered"

echo
echo "=================================================="
echo " Done. Now check:"
echo "   https://${USERNAME}.pythonanywhere.com/api/google/status"
echo " Any FAIL above is the thing to fix next."
echo "=================================================="
