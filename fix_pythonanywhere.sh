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
# allowlisted hosts. requests and google-auth read these variables.
PROXY = '$PROXY'
for _v in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
    os.environ[_v] = PROXY

# httplib2 does NOT reliably honour those variables, and
# google-api-python-client builds every Drive, Gmail, Calendar, Docs, Tasks
# and Sheets call on httplib2 — which is why those returned 500 with
# [Errno 101] while the OAuth exchange, which uses requests, succeeded.
# It needs the proxy as an object, so force it onto every Http instance,
# including the ones googleapiclient constructs internally where there is
# no opportunity to pass one in.
try:
    import httplib2

    # httplib2 sets its own .socks to None when no socks module can be
    # imported, and it routes every proxied connection through
    # socks.socksocket — so PySocks is what makes proxying possible here at
    # all. PROXY_TYPE_HTTP is 3; read it from the module when present rather
    # than relying on the literal.
    _socks = getattr(httplib2, 'socks', None)
    _PROXY_INFO = httplib2.ProxyInfo(
        getattr(_socks, 'PROXY_TYPE_HTTP', 3), 'proxy.server', 3128)
    _http_init = httplib2.Http.__init__

    def _http_init_proxied(self, *args, **kwargs):
        # proxy_info is the third positional parameter; only fill it in when
        # the caller has not supplied it either way.
        if len(args) < 3 and 'proxy_info' not in kwargs:
            kwargs['proxy_info'] = _PROXY_INFO
        _http_init(self, *args, **kwargs)

    httplib2.Http.__init__ = _http_init_proxied
except Exception:
    pass

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

# httplib2 proxies exclusively through socks.socksocket, and sets its own
# .socks attribute to None when no socks module imports — which leaves it
# unable to use a proxy at all. PySocks provides that module.
if pip install -q PySocks 2>/tmp/pipfail2; then
  ok "PySocks installed (httplib2 needs it to proxy)"
else
  bad "PySocks failed:"; tail -3 /tmp/pipfail2
fi

python - <<'PY'
import httplib2
s = getattr(httplib2, 'socks', None)
print('  ...   httplib2 %s, socks module: %s'
      % (getattr(httplib2, '__version__', '?'),
         'present' if s else 'MISSING - cannot proxy'))
PY

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

# google-api-python-client uses httplib2, not requests, and httplib2 does
# not honour the environment variables - this is what backs
# /api/google/drive/list and friends. Tested both ways so the report shows
# the bare behaviour and the fix the WSGI file installs.
URL = 'https://www.googleapis.com/discovery/v1/apis'

try:
    import httplib2
    try:
        resp, _ = httplib2.Http(timeout=25).request(URL, 'GET')
        print('  ...   httplib2 bare        HTTP %s' % resp.status)
    except Exception as e:
        print('  ...   httplib2 bare        fails as expected (%s)' % type(e).__name__)

    _socks = getattr(httplib2, 'socks', None)
    if _socks is None:
        print('  FAIL  httplib2 has no socks module - proxying is impossible')
        raise SystemExit(0)
    proxy = httplib2.ProxyInfo(getattr(_socks, 'PROXY_TYPE_HTTP', 3), 'proxy.server', 3128)
    resp, _ = httplib2.Http(timeout=25, proxy_info=proxy).request(URL, 'GET')
    print('  OK    httplib2 via proxy -> www.googleapis.com  HTTP %s' % resp.status)
except Exception as e:
    print('  FAIL  httplib2 via proxy -> %s: %s' % (type(e).__name__, e))
PY

# Prove the patch the WSGI file installs actually takes effect, by importing
# that file and then making an unmodified httplib2 call through it.
head1 "5b. The proxy patch as the web worker will apply it"
python - <<PY
import importlib.util, sys
spec = importlib.util.spec_from_file_location('pa_wsgi', '$WSGI')
try:
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    import httplib2
    resp, _ = httplib2.Http(timeout=25).request(
        'https://www.googleapis.com/discovery/v1/apis', 'GET')
    print('  OK    patched httplib2 reaches Google  HTTP %s' % resp.status)
except Exception as e:
    print('  FAIL  %s: %s' % (type(e).__name__, e))
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
