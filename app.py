"""
WhiteBoard Pro - All-in-One Collaborative Whiteboard
Flask backend with Google Keep integration via gkeepapi
"""

import os
import io
import re
import json
import uuid
import base64
import logging
import secrets
import threading
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

from urllib.parse import urlparse, urlunparse

from flask import Flask, render_template, request, jsonify, session, send_file, redirect
from flask_cors import CORS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# .env loading
#
# Read before anything touches os.environ. A shell `$env:X = ...` only lives
# as long as that shell, so credentials set that way vanish on the next
# restart and the Google integration mysteriously "turns itself off".
# A real environment variable always wins over the file.
# ---------------------------------------------------------------------------

def load_dotenv(path=None):
    path = path or os.path.join(BASE_DIR, '.env')
    if not os.path.exists(path):
        return 0
    loaded = 0
    with open(path, 'r', encoding='utf-8') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
                loaded += 1
    return loaded


_dotenv_count = load_dotenv()


# ---------------------------------------------------------------------------
# App Configuration
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

# Unset (the default) allows every origin, which is fine for a single
# self-hosted instance behind its own domain. Set CORS_ORIGINS to a
# comma-separated allowlist to tighten that for a multi-tenant or public
# deployment.
_cors_origins = [o.strip() for o in os.environ.get('CORS_ORIGINS', '').split(',') if o.strip()]
CORS(app, origins=_cors_origins or '*')


# ---------------------------------------------------------------------------
# One canonical host
#
# http://localhost:5000 and http://127.0.0.1:5000 reach the same server but
# are two different *origins* to the browser, and almost everything that
# matters here is scoped to an origin:
#
#   · localStorage        — boards, projects, settings and themes saved on one
#                           are invisible on the other, so half the app looks
#                           empty or "missing features" depending on the URL
#   · cookies             — the Flask session, hence the OAuth flow
#   · Firebase Auth       — only `localhost` is on the authorised-domain list
#                           by default; 127.0.0.1 fails with
#                           auth/unauthorized-domain, which surfaces as the
#                           "OAuth error" on the whiteboard's sign-in button
#   · Google OAuth        — the redirect URI is registered for exactly one host
#   · window.postMessage  — the OAuth popup posts to its own origin, so the
#                           opener never hears back across the split
#
# Fixing each symptom separately is endless. Instead every loopback alias is
# redirected to the one canonical host, so there is only ever one origin and
# the two URLs become the same app. Set CANONICAL_HOST to override it, or to
# an empty value to switch this off.
# ---------------------------------------------------------------------------

_LOOPBACK_ALIASES = {'127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', ''}

_canonical_env = os.environ.get('CANONICAL_HOST')
if _canonical_env is None:
    # Default to whatever host the Google redirect is registered for: that is
    # the one host OAuth is guaranteed to accept.
    try:
        _canonical_env = urlparse(
            os.environ.get('GOOGLE_REDIRECT_URI')
            or 'http://localhost:5000/api/google/callback').hostname or 'localhost'
    except Exception:
        _canonical_env = 'localhost'

CANONICAL_HOST = (_canonical_env or '').strip()


@app.before_request
def _force_canonical_host():
    """Send every loopback alias to the one canonical origin."""
    if not CANONICAL_HOST:
        return None

    host = (request.host or '').split(':')[0].strip('[]')
    if host == CANONICAL_HOST:
        return None
    # Only loopback aliases are folded in. A LAN address (192.168.x.x, a
    # phone testing the board over Wi-Fi) is left alone — redirecting it to
    # "localhost" would point that device at itself.
    if host not in _LOOPBACK_ALIASES and host != '[::1]':
        return None

    port = ''
    if ':' in (request.host or '').rsplit(']', 1)[-1]:
        port = ':' + request.host.rsplit(':', 1)[1]

    parts = urlparse(request.url)
    target = urlunparse((parts.scheme, CANONICAL_HOST + port,
                         parts.path, parts.params, parts.query, parts.fragment))
    # 307 keeps the method and body, so a POST that lands on the wrong host
    # is replayed rather than silently downgraded to a GET.
    return redirect(target, code=307 if request.method not in ('GET', 'HEAD') else 302)


@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, post-check=0, pre-check=0, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '-1'
    return response


def _stable_secret_key():
    """
    The OAuth token file is keyed off the Flask session cookie, so a secret
    key that changes between restarts invalidates every session and orphans
    the stored Google credentials — the integration would appear to
    disconnect itself every time the server was restarted.

    Generate once, persist, reuse.
    """
    from_env = os.environ.get('SECRET_KEY')
    if from_env:
        return from_env

    key_file = os.path.join(BASE_DIR, 'data', '.secret_key')
    os.makedirs(os.path.dirname(key_file), exist_ok=True)
    if os.path.exists(key_file):
        with open(key_file, 'r', encoding='utf-8') as f:
            existing = f.read().strip()
        if existing:
            return existing

    generated = secrets.token_hex(32)
    with open(key_file, 'w', encoding='utf-8') as f:
        f.write(generated)
    return generated


app.secret_key = _stable_secret_key()
_secret_key_from_env = bool(os.environ.get('SECRET_KEY'))

# Sessions must outlive the browser window, or a user who closes the tab
# loses the session that points at their Google token file.
app.permanent_session_lifetime = timedelta(days=90)
app.config.update(
    SESSION_COOKIE_SAMESITE='Lax',   # 'Lax' still allows the OAuth redirect back
    SESSION_COOKIE_HTTPONLY=True,
)

# Directories
DATA_DIR = os.path.join(BASE_DIR, 'data')
PROJECTS_DIR = os.path.join(DATA_DIR, 'projects')
UPLOAD_DIR = os.path.join(BASE_DIR, 'static', 'uploads')

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(PROJECTS_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'}
MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 10 MB

# Files that can be attached to a board object. Uploads are served straight
# back out of /static, so this is an allow-list and not a deny-list: nothing
# the browser or the OS would execute (html, svg, js, exe, bat, ps1, …) is on
# it, and svg is excluded here even though images accept it, because an
# attachment is opened in a tab where its scripts would run same-origin.
ALLOWED_ATTACHMENT_EXTENSIONS = {
    # documents
    'pdf', 'txt', 'md', 'rtf', 'odt', 'ods', 'odp',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    # data
    'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
    # images
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'heic',
    # media
    'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'mov', 'webm', 'avi', 'mkv',
    # archives
    'zip', 'gz', 'tar', '7z', 'rar',
}
MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024  # 50 MB

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('whiteboard')

if not _secret_key_from_env:
    logger.warning(
        'SECRET_KEY not set — using a key generated into data/.secret_key. That '
        'is fine for a single instance as long as data/ is on a volume that '
        'survives restarts, but every replica of a scaled/multi-machine '
        'deployment needs the SAME key, so set SECRET_KEY explicitly for those.')

# Server-side Keep sessions  { session_token: gkeepapi.Keep instance }
keep_sessions = {}


# ---------------------------------------------------------------------------
# Helper Utilities
# ---------------------------------------------------------------------------

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_IMAGE_EXTENSIONS


SAFE_ID = re.compile(r'^[A-Za-z0-9_-]{1,80}$')


def safe_board_id(board_id):
    """
    Board ids come straight off the wire (URL segment *and* JSON body), so they
    are never trusted as filenames. Anything that is not a plain slug is
    rejected outright rather than sanitised, so an id like '../../secrets'
    cannot be coerced into a path that escapes DATA_DIR.
    """
    if not board_id or not SAFE_ID.match(str(board_id)):
        return None
    return str(board_id)


def board_path(board_id):
    safe = safe_board_id(board_id)
    if safe is None:
        raise ValueError(f'unsafe board id: {board_id!r}')
    return os.path.join(DATA_DIR, f'{safe}.json')


def new_board(name='Untitled Board'):
    return {
        'id': str(uuid.uuid4()),
        'name': name,
        'elements': [],
        'drawings': [],
        'created_at': datetime.utcnow().isoformat(),
        'updated_at': datetime.utcnow().isoformat(),
    }


KEEP_COLOR_MAP = {
    'DEFAULT': '#ffffff',
    'WHITE': '#ffffff',
    'RED': '#f28b82',
    'ORANGE': '#fbbc04',
    'YELLOW': '#fff475',
    'GREEN': '#ccff90',
    'TEAL': '#a7ffeb',
    'CERULEAN': '#cbf0f8',
    'BLUE': '#aecbfa',
    'DARK_BLUE': '#d7aefb',
    'PURPLE': '#d7aefb',
    'PINK': '#fdcfe8',
    'BROWN': '#e6c9a8',
    'GRAY': '#e8eaed',
}


# ---------------------------------------------------------------------------
# Page Routes
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    """Serve the main whiteboard application."""
    return render_template('index.html')


# ---------------------------------------------------------------------------
# Board CRUD API
# ---------------------------------------------------------------------------

@app.route('/api/boards', methods=['GET'])
def list_boards():
    """Return a list of all saved boards (summary only)."""
    boards = []
    for fname in os.listdir(DATA_DIR):
        if not fname.endswith('.json') or fname.endswith('.tmp'):
            continue
        try:
            with open(os.path.join(DATA_DIR, fname), 'r', encoding='utf-8') as f:
                data = json.load(f)
            board_id = safe_board_id(data.get('id')) or fname[:-5]
            boards.append({
                'id': board_id,
                'name': data.get('name', 'Untitled'),
                'created_at': data.get('created_at'),
                'updated_at': data.get('updated_at'),
                'element_count': len(data.get('elements', [])),
                'connection_count': len(data.get('connections', [])),
                'stroke_count': len(data.get('strokes', [])),
            })
        except Exception:
            logger.warning('Skipping unreadable board file: %s', fname)
            continue
    boards.sort(key=lambda b: b.get('updated_at', ''), reverse=True)
    return jsonify(boards)


@app.route('/api/board/<board_id>', methods=['GET'])
def get_board(board_id):
    """Retrieve a single board by ID."""
    if safe_board_id(board_id) is None:
        return jsonify({'error': 'Invalid board id'}), 400
    path = board_path(board_id)
    if not os.path.exists(path):
        return jsonify({'error': 'Board not found'}), 404
    with open(path, 'r', encoding='utf-8') as f:
        return jsonify(json.load(f))


@app.route('/api/board/save', methods=['POST'])
def save_board():
    """Create or update a board."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'error': 'Invalid JSON body'}), 400

    board_id = safe_board_id(data.get('id')) or str(uuid.uuid4())
    data['id'] = board_id
    data['updated_at'] = datetime.utcnow().isoformat()
    if 'created_at' not in data:
        data['created_at'] = data['updated_at']

    # Write to a temp file then replace, so a crash mid-write cannot leave a
    # half-written board on disk where a complete one used to be.
    path = board_path(board_id)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)

    logger.info('Board saved: %s (%d elements)', board_id, len(data.get('elements', [])))
    return jsonify({'id': board_id, 'message': 'Board saved successfully'})


@app.route('/api/board/export', methods=['POST'])
def export_board():
    """Export a board as a downloadable JSON file (streamed, never persisted)."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'error': 'Invalid JSON body'}), 400

    board_id = safe_board_id(data.get('id')) or 'export'
    payload = json.dumps(data, indent=2).encode('utf-8')
    return send_file(io.BytesIO(payload), as_attachment=True,
                     download_name=f'whiteboard_{board_id}.json',
                     mimetype='application/json')


@app.route('/api/board/<board_id>', methods=['DELETE'])
def delete_board(board_id):
    """Delete a board."""
    if safe_board_id(board_id) is None:
        return jsonify({'error': 'Invalid board id'}), 400
    path = board_path(board_id)
    if os.path.exists(path):
        os.remove(path)
        return jsonify({'message': 'Board deleted'})
    return jsonify({'error': 'Board not found'}), 404


@app.route('/api/board/<board_id>/duplicate', methods=['POST'])
def duplicate_board(board_id):
    """Server-side copy, so a board can be branched without a round trip."""
    if safe_board_id(board_id) is None:
        return jsonify({'error': 'Invalid board id'}), 400
    path = board_path(board_id)
    if not os.path.exists(path):
        return jsonify({'error': 'Board not found'}), 404

    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    data['id'] = str(uuid.uuid4())
    data['name'] = (data.get('name') or 'Untitled') + ' (copy)'
    data['created_at'] = data['updated_at'] = datetime.utcnow().isoformat()
    with open(board_path(data['id']), 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)

    return jsonify({'id': data['id'], 'name': data['name']})


# ---------------------------------------------------------------------------
# Image Upload API
# ---------------------------------------------------------------------------

@app.route('/api/upload/image', methods=['POST'])
def upload_image():
    """Handle image file upload, store in static/uploads."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Empty filename'}), 400

    if not allowed_file(file.filename):
        return jsonify({'error': 'File type not allowed'}), 400

    # Check size
    file.seek(0, os.SEEK_END)
    size = file.tell()
    file.seek(0)
    if size > MAX_IMAGE_SIZE:
        return jsonify({'error': 'File too large (max 10 MB)'}), 400

    ext = file.filename.rsplit('.', 1)[1].lower()
    filename = f'{uuid.uuid4().hex}.{ext}'
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)

    url = f'/static/uploads/{filename}'
    logger.info('Image uploaded: %s', url)
    return jsonify({'url': url, 'filename': filename})


@app.route('/api/upload/file', methods=['POST'])
def upload_file():
    """
    Attach any everyday document to a board object.

    /api/upload/image exists for the image element and only accepts the six
    formats the canvas can draw. Attachments are different: they are opened,
    not rendered, so a PDF, a spreadsheet or a zip is as valid as a PNG. The
    extension list is still a strict allow-list — anything executable stays
    out, because these files are served straight back from /static.
    """
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    original = (file.filename or '').strip()
    if not original:
        return jsonify({'error': 'Empty filename'}), 400

    ext = original.rsplit('.', 1)[1].lower() if '.' in original else ''
    if ext not in ALLOWED_ATTACHMENT_EXTENSIONS:
        allowed = ', '.join(sorted(ALLOWED_ATTACHMENT_EXTENSIONS))
        return jsonify({'error': f'"{ext or original}" is not an allowed file type.',
                        'fix': f'Allowed: {allowed}'}), 400

    file.seek(0, os.SEEK_END)
    size = file.tell()
    file.seek(0)
    if size > MAX_ATTACHMENT_SIZE:
        return jsonify({'error': f'File too large (max {MAX_ATTACHMENT_SIZE // (1024 * 1024)} MB).'}), 400

    filename = f'{uuid.uuid4().hex}.{ext}'
    file.save(os.path.join(UPLOAD_DIR, filename))

    url = f'/static/uploads/{filename}'
    logger.info('Attachment uploaded: %s (%s, %d bytes)', original, url, size)
    return jsonify({
        'url': url,
        'filename': filename,
        # The stored path is a uuid, so the original name is only ever
        # displayed. Keep it readable (spaces, unicode) but strip anything
        # that could read as a path.
        'name': re.sub(r'[\\/\x00-\x1f]', '', original)[:180] or filename,
        'size': size,
        'ext': ext,
    })


# ---------------------------------------------------------------------------
# Google Keep Integration API
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Google Keep sign-in
#
# There are three credentials that can get you into Keep, and only two of
# them still work. Knowing which is which is the whole problem:
#
#   App Password    The route this app shipped with, and the one every guide
#                   still describes. It goes through gpsoauth's
#                   `perform_master_login`, an endpoint Google has since shut
#                   to App Passwords. It now fails with BadAuthentication for
#                   a *correct* password, which is why "I used an App
#                   Password and it still says login failed" is the normal
#                   experience rather than a mistake by the user. Still tried
#                   first, because it costs one request and does work on a
#                   few older accounts.
#
#   Master token    A long-lived `aas_et/…` token. Works, and is what the
#                   other two routes are trying to obtain.
#
#   OAuth token     A one-time `oauth2_4/…` value taken from the browser after
#                   signing in at Google's embedded-setup page. Exchanged
#                   here for a master token, which is then stored by the
#                   caller and reused. This is the route that reliably works
#                   on a personal account today.
#
# The device id must be stable: a master token is bound to the device it was
# minted for, so a fresh random id on every call would invalidate the token
# the user saved last time.
# ---------------------------------------------------------------------------

def _keep_device_id():
    path = os.path.join(DATA_DIR, '.keep_device_id')
    existing = ''
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            existing = f.read().strip()
    if len(existing) == 16 and all(c in '0123456789abcdef' for c in existing):
        return existing
    generated = secrets.token_hex(8)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(generated)
    return generated


KEEP_EMBEDDED_SETUP_URL = 'https://accounts.google.com/EmbeddedSetup'


def _keep_master_token_from_oauth(email, oauth_token):
    """Trade a one-time browser oauth_token for a durable master token."""
    import gpsoauth
    res = gpsoauth.exchange_token(email, oauth_token, _keep_device_id())
    token = res.get('Token')
    if token:
        return token, None
    return None, (res.get('ErrorDetail') or res.get('Error')
                  or 'Google did not return a token for that value.')


@app.route('/api/keep/login', methods=['POST'])
def keep_login():
    """
    Sign in to Keep and hand back a master token the client can reuse.

    Accepts any of `password` (App Password), `master_token`, or
    `oauth_token`, and says precisely which one failed and what to do next
    rather than collapsing every cause into "Login failed".
    """
    try:
        import gkeepapi
    except ImportError:
        return jsonify({'error': 'gkeepapi is not installed. Run: pip install -r requirements.txt'}), 500

    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip()
    password = (data.get('password') or '').strip()
    master_token = (data.get('master_token') or '').strip()
    oauth_token = (data.get('oauth_token') or '').strip()

    if not email:
        return jsonify({'error': 'Your Google email address is required.'}), 400

    # A pasted value is easy to put in the wrong box. Route it by its own
    # prefix rather than by which field it landed in.
    for value in (password, master_token, oauth_token):
        if value.startswith('oauth2_4/') and not oauth_token:
            oauth_token, password, master_token = value, '', ''
        elif value.startswith('aas_et/') and not master_token:
            master_token, password = value, ''

    if not (password or master_token or oauth_token):
        return jsonify({
            'error': 'Enter an App Password, a master token, or a browser sign-in token.',
        }), 400

    keep = gkeepapi.Keep()
    device_id = _keep_device_id()

    # 1. A master token needs no exchange at all.
    if master_token:
        try:
            keep.authenticate(email, master_token, device_id=device_id)
            return jsonify({'token': keep.getMasterToken(), 'method': 'master_token'})
        except Exception as e:
            logger.info('Keep master-token auth failed: %s', e)
            return jsonify({
                'error': 'That master token was rejected.',
                'fix': 'It may have been revoked, or minted on another machine. '
                       'Get a fresh one with the browser sign-in below.',
                'detail': str(e)[:300],
            }), 401

    # 2. Exchange a browser oauth_token for one.
    if oauth_token:
        try:
            token, err = _keep_master_token_from_oauth(email, oauth_token)
        except ImportError:
            return jsonify({'error': 'gpsoauth is not installed. Run: pip install -r requirements.txt'}), 500
        except Exception as e:
            logger.error('Keep token exchange failed: %s', e)
            return jsonify({'error': f'Token exchange failed: {e}'}), 502

        if not token:
            return jsonify({
                'error': f'Google would not exchange that sign-in token ({err}).',
                'fix': 'The oauth_token is single-use and expires within minutes. '
                       'Sign in again at the embedded setup page and copy a fresh one.',
                'setupUrl': KEEP_EMBEDDED_SETUP_URL,
            }), 401

        try:
            keep.authenticate(email, token, device_id=device_id)
            return jsonify({'token': keep.getMasterToken(), 'method': 'oauth_token'})
        except Exception as e:
            logger.error('Keep auth after exchange failed: %s', e)
            return jsonify({'error': f'Signed in, but Keep refused the token: {e}'}), 502

    # 3. App Password. Tried last because it is the one Google has closed.
    try:
        keep.login(email, password, device_id=device_id)
        return jsonify({'token': keep.getMasterToken(), 'method': 'app_password'})
    except Exception as e:
        detail = str(e)
        logger.info('Keep App Password login failed: %s', detail)
        return jsonify({
            'error': 'Google rejected the App Password.',
            'fix': 'This is expected — Google closed the App Password route into Keep, so a '
                   'correct password fails here too. Use the browser sign-in instead: open the '
                   'setup page, sign in, then copy the "oauth_token" cookie value and paste it '
                   'below. You only do this once; the token it returns is saved and reused.',
            'setupUrl': KEEP_EMBEDDED_SETUP_URL,
            'needsBrowserToken': True,
            'detail': detail[:300],
        }), 401


@app.route('/api/keep/notes', methods=['GET'])
def keep_notes():
    """Fetch notes using stateless token resume."""
    token = request.headers.get('X-Keep-Token')
    email = request.headers.get('X-Keep-Email')
    if not token or not email:
        return jsonify({'error': 'Not authenticated.'}), 401

    try:
        import gkeepapi
        keep = gkeepapi.Keep()
        # Same device id the token was minted for — a master token is bound
        # to one, and resuming under a different id is rejected.
        keep.resume(email, token, device_id=_keep_device_id())
        keep.sync()
        out = []
        for note in keep.all():
            if note.trashed:
                continue

            color_name = note.color.name.upper() if note.color else 'DEFAULT'
            bg = KEEP_COLOR_MAP.get(color_name, '#ffffff')
            
            note_data = {
                'id': note.id,
                'title': note.title or '',
                'color': bg,
            }

            if hasattr(note, 'unchecked') and hasattr(note, 'checked'):
                note_data['type'] = 'list'
                items = []
                for item in note.unchecked:
                    items.append({'text': item.text, 'checked': False})
                for item in note.checked:
                    items.append({'text': item.text, 'checked': True})
                note_data['items'] = items
                note_data['content'] = '\n'.join(
                    [f"{'☑' if i['checked'] else '☐'} {i['text']}" for i in items]
                )
            else:
                note_data['type'] = 'note'
                note_data['content'] = note.text or ''

            out.append(note_data)

        return jsonify(out)
    except Exception as e:
        logger.error('Failed to fetch notes: %s', str(e))
        return jsonify({'error': str(e)}), 500


@app.route('/api/keep/import', methods=['POST'])
def keep_import():
    """Import selected notes using stateless token resume."""
    token = request.headers.get('X-Keep-Token')
    email = request.headers.get('X-Keep-Email')
    if not token or not email:
        return jsonify({'error': 'Not authenticated.'}), 401

    data = request.get_json(silent=True) or {}
    note_ids = data.get('note_ids', [])
    if not note_ids:
        return jsonify({'error': 'No notes selected.'}), 400

    try:
        import gkeepapi
        keep = gkeepapi.Keep()
        # Same device id the token was minted for — a master token is bound
        # to one, and resuming under a different id is rejected.
        keep.resume(email, token, device_id=_keep_device_id())
        keep.sync()

        elements = []
        col = 0
        row = 0
        cols_per_row = 4
        card_w = 240
        card_h = 240
        gap = 30
        start_x = 100
        start_y = 100

        for nid in note_ids:
            note = keep.get(nid)
            if not note:
                continue

            color_name = note.color.name.upper() if note.color else 'DEFAULT'
            hex_color = KEEP_COLOR_MAP.get(color_name, '#fff9b1')

            if hasattr(note, 'unchecked') and hasattr(note, 'checked'):
                items = []
                for item in note.unchecked:
                    items.append(f'☐ {item.text}')
                for item in note.checked:
                    items.append(f'☑ {item.text}')
                content = '\n'.join(items)
            else:
                content = note.text or ''

            x = start_x + col * (card_w + gap)
            y = start_y + row * (card_h + gap)

            elements.append({
                'id': str(uuid.uuid4()),
                'type': 'sticky-note',
                'x': x,
                'y': y,
                'width': card_w,
                'height': card_h,
                'rotation': 0,
                'content': f'{note.title}\n\n{content}'.strip() if note.title else content,
                'style': {
                    'backgroundColor': hex_color,
                    'fontSize': 14,
                    'fontFamily': 'Inter, sans-serif',
                },
                'locked': False,
                'zIndex': len(elements) + 1,
                'meta': {
                    'source': 'google-keep',
                    'keepId': note.id,
                    # The stamp the board reconciles against. Without it every
                    # imported note looks changed on the first live-sync poll.
                    'keepUpdated': (note.timestamps.updated.isoformat()
                                    if note.timestamps.updated else None),
                    'keepTitle': note.title or '',
                    # Whether this note HAS a title. The board renders a
                    # titled note as "title\n\nbody" and splits it back on
                    # the way out; doing that to an untitled note would
                    # promote its first line to a title it never had.
                    'keepTitled': bool((note.title or '').strip()),
                },
            })

            col += 1
            if col >= cols_per_row:
                col = 0
                row += 1

        return jsonify({'elements': elements, 'count': len(elements)})
    except Exception as e:
        logger.error('Keep import failed: %s', str(e))
        return jsonify({'error': str(e)}), 500


@app.route('/api/keep/logout', methods=['POST'])
def keep_logout():
    """Logout endpoint."""
    return jsonify({'message': 'Logged out'})


# ---------------------------------------------------------------------------
# Two-way Keep sync
#
# Import was one-directional: notes landed on the board and the two copies
# drifted apart from that moment on. These endpoints make the board a live
# view of Keep instead of a snapshot of it.
#
# The hard part of any two-way sync is not sending the change, it is deciding
# who wins when both sides moved. The policy here:
#
#   · Every note carries `updated`, straight from Keep.
#   · The client sends back the `updated` it last saw, as `baseUpdated`.
#   · If Keep's value is newer, someone edited the note elsewhere since the
#     board last looked. That is a conflict, and it is REFUSED rather than
#     overwritten — the response carries Keep's current text so the client
#     can show both and let a person choose.
#   · `force: true` is the explicit "mine wins" the user chose.
#
# Silently overwriting is the one behaviour that loses work, so it is the one
# behaviour this will not do on its own.
# ---------------------------------------------------------------------------

KEEP_HEX_TO_COLOR = {
    '#ffffff': 'White',   '#f28b82': 'Red',    '#fbbc04': 'Orange',
    '#fff475': 'Yellow',  '#ccff90': 'Green',  '#a7ffeb': 'Teal',
    '#cbf0f8': 'Blue',    '#aecbfa': 'Blue',   '#d7aefb': 'Purple',
    '#fdcfe8': 'Pink',    '#e6c9a8': 'Brown',  '#e8eaed': 'Gray',
}


# Live Keep sessions, keyed by (email, token).
#
# resume() re-authenticates and downloads the whole notes tree, which takes
# several seconds. Doing that on every poll would make a 20-second sync
# interval cost more than it saves, and would hammer Google for no reason.
# Keeping the session and calling sync() on it turns each poll into a small
# delta request.
#
# A gkeepapi session object isn't safe for two overlapping calls, so each
# session gets its OWN lock (held only for the duration of that session's own
# resume/sync). A single process-wide lock here used to serialize every
# user's Keep requests behind one another for the full network round trip —
# the `_keep_sessions_lock` below only ever guards the plain dict lookups,
# never the slow network calls.
_keep_sessions = {}
_keep_session_locks = {}
_keep_sessions_lock = threading.Lock()


def _keep_lock_for(key):
    with _keep_sessions_lock:
        lock = _keep_session_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _keep_session_locks[key] = lock
        return lock


def _keep_session(fresh=False):
    """Resume (or reuse) a Keep session from the request headers."""
    token = request.headers.get('X-Keep-Token')
    email = request.headers.get('X-Keep-Email')
    if not token or not email:
        return None, (jsonify({
            'error': 'Not signed in to Keep.',
            'fix': 'Open Import from Google Keep and connect once; the token is then remembered.',
        }), 401)

    key = f'{email}:{hash(token)}'
    try:
        import gkeepapi
        with _keep_lock_for(key):
            with _keep_sessions_lock:
                keep = None if fresh else _keep_sessions.get(key)
            if keep is None:
                keep = gkeepapi.Keep()
                keep.resume(email, token, device_id=_keep_device_id())
                with _keep_sessions_lock:
                    _keep_sessions[key] = keep
            else:
                keep.sync()
            return keep, None
    except Exception as e:
        with _keep_sessions_lock:
            _keep_sessions.pop(key, None)
        logger.info('Keep resume failed: %s', e)
        return None, (jsonify({
            'error': 'Keep rejected the stored token.',
            'fix': 'Sign in to Keep again — the token may have been revoked.',
            'detail': str(e)[:300],
        }), 401)


def _keep_shape(note):
    """One note, in the shape the board speaks."""
    color_name = note.color.name.upper() if note.color else 'DEFAULT'
    data = {
        'id': note.id,
        'title': note.title or '',
        'color': KEEP_COLOR_MAP.get(color_name, '#ffffff'),
        'pinned': bool(note.pinned),
        'archived': bool(note.archived),
        'trashed': bool(note.trashed),
        'titled': bool((note.title or '').strip()),
        'updated': note.timestamps.updated.isoformat() if note.timestamps.updated else None,
    }
    if hasattr(note, 'unchecked') and hasattr(note, 'checked'):
        items = [{'text': i.text, 'checked': False} for i in note.unchecked]
        items += [{'text': i.text, 'checked': True} for i in note.checked]
        data['type'] = 'list'
        data['items'] = items
        data['content'] = '\n'.join(f"{'☑' if i['checked'] else '☐'} {i['text']}" for i in items)
    else:
        data['type'] = 'note'
        data['content'] = note.text or ''
    return data


def _parse_iso(value):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


@app.route('/api/keep/state', methods=['GET'])
def keep_state():
    """
    Every live note with its `updated` stamp — the poll the board runs to
    notice edits made in the Keep app or on another device.
    """
    keep, err = _keep_session()
    if err:
        return err

    try:
        notes = [_keep_shape(n) for n in keep.all() if not n.trashed]
        return jsonify({
            'notes': notes,
            'count': len(notes),
            'syncedAt': datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.error('Keep state failed: %s', e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/keep/push', methods=['POST'])
def keep_push():
    """
    Send board edits back to Keep.

    Body:
      changes: [{ keepId, title?, content?, color?, pinned?, trashed?, baseUpdated? }]
      creates: [{ localId, title?, content?, color? }]
      force:   bool — overwrite even when Keep moved on
    """
    keep, err = _keep_session()
    if err:
        return err

    d = request.get_json(silent=True) or {}
    force = bool(d.get('force'))
    updated, created, conflicts, missing = [], [], [], []

    try:
        from gkeepapi.node import ColorValue
    except Exception:
        ColorValue = None

    def set_color(note, hex_value):
        if not (ColorValue and hex_value):
            return
        name = KEEP_HEX_TO_COLOR.get(str(hex_value).lower())
        if name and hasattr(ColorValue, name):
            note.color = getattr(ColorValue, name)

    try:
        for ch in d.get('changes', []):
            note = keep.get(ch.get('keepId'))
            if not note:
                # Deleted in Keep. Say so rather than silently doing nothing —
                # the board needs to unbind that sticky.
                missing.append(ch.get('keepId'))
                continue

            base = _parse_iso(ch.get('baseUpdated'))
            remote = note.timestamps.updated
            if base and remote and remote > base + timedelta(seconds=2) and not force:
                conflicts.append({'keepId': note.id, 'remote': _keep_shape(note)})
                continue

            if ch.get('trashed'):
                note.trash()
                updated.append({'keepId': note.id, 'trashed': True})
                continue

            if 'title' in ch:
                note.title = str(ch['title'] or '')
            if 'content' in ch and not hasattr(note, 'unchecked'):
                # List notes hold structured items; overwriting them with a
                # flat string would silently destroy the checkboxes.
                note.text = str(ch['content'] or '')
            if 'color' in ch:
                set_color(note, ch['color'])
            if 'pinned' in ch:
                note.pinned = bool(ch['pinned'])

            updated.append({'keepId': note.id})

        for c in d.get('creates', []):
            note = keep.createNote(str(c.get('title') or ''), str(c.get('content') or ''))
            set_color(note, c.get('color'))
            created.append({'localId': c.get('localId'), 'keepId': note.id})

        keep.sync()

        # Re-read the stamps AFTER the sync, so the client rebases onto what
        # Keep actually stored. Handing back the pre-sync value would make
        # the very next poll look like a remote edit and start a loop.
        for row in updated:
            n = keep.get(row['keepId'])
            if n:
                row['updated'] = n.timestamps.updated.isoformat() if n.timestamps.updated else None
        for row in created:
            n = keep.get(row['keepId'])
            if n:
                row['updated'] = n.timestamps.updated.isoformat() if n.timestamps.updated else None
                row['note'] = _keep_shape(n)

        return jsonify({
            'ok': True,
            'updated': updated,
            'created': created,
            'conflicts': conflicts,
            'missing': missing,
            'syncedAt': datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.error('Keep push failed: %s', e)
        return jsonify({'error': str(e)[:400]}), 500


# ===========================================================================
# PROJECT MANAGEMENT API
# ---------------------------------------------------------------------------
# When the user is signed in, Firestore is the source of truth and the
# browser talks to it directly — these endpoints are never called. They exist
# so the workspace is fully usable signed out and offline, on one machine.
#
# Storage layout:
#   data/pm/projects/<projectId>.json   one project record
#   data/pm/tasks/<projectId>.json      every task in that project, as a list
#
# Tasks are one file per *project* rather than per task: a project with 800
# tasks is 800 files to stat on every list otherwise, and the whole set is
# read together anyway.
# ===========================================================================

import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr

PM_DIR = os.path.join(DATA_DIR, 'pm')
PM_PROJECTS_DIR = os.path.join(PM_DIR, 'projects')
PM_TASKS_DIR = os.path.join(PM_DIR, 'tasks')
PM_TOKENS_DIR = os.path.join(PM_DIR, 'tokens')

for _d in (PM_DIR, PM_PROJECTS_DIR, PM_TASKS_DIR, PM_TOKENS_DIR):
    os.makedirs(_d, exist_ok=True)

# Serialises read-modify-write on the task files. Flask's dev server is
# threaded, and two overlapping /api/pm/sync calls would otherwise let the
# second one's read miss the first one's write.
_pm_lock = threading.Lock()


def _pm_project_path(pid):
    safe = safe_board_id(pid)
    if safe is None:
        raise ValueError(f'unsafe project id: {pid!r}')
    return os.path.join(PM_PROJECTS_DIR, f'{safe}.json')


def _pm_tasks_path(pid):
    safe = safe_board_id(pid)
    if safe is None:
        raise ValueError(f'unsafe project id: {pid!r}')
    return os.path.join(PM_TASKS_DIR, f'{safe}.json')


def _read_json(path, fallback):
    if not os.path.exists(path):
        return fallback
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        logger.warning('Unreadable PM file, ignoring: %s', path)
        return fallback


def _write_json(path, data):
    """Atomic write: a crash mid-save cannot truncate an existing file."""
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


@app.route('/api/pm/projects', methods=['GET'])
def pm_list():
    """Everything the local workspace knows, in one round trip."""
    projects, tasks = [], {}
    for fname in sorted(os.listdir(PM_PROJECTS_DIR)):
        if not fname.endswith('.json') or fname.endswith('.tmp'):
            continue
        p = _read_json(os.path.join(PM_PROJECTS_DIR, fname), None)
        if not p or not p.get('id'):
            continue
        projects.append(p)
        tasks[p['id']] = _read_json(_pm_tasks_path(p['id']), [])
    return jsonify({'projects': projects, 'tasks': tasks})


@app.route('/api/pm/sync', methods=['POST'])
def pm_sync():
    """
    Batched upsert from the client's write-behind queue.

    Body: { projects: [...], tasks: [...], deleted: [{projectId, id}] }
    Tasks are grouped by project so each task file is rewritten once,
    however many tasks in it changed.
    """
    data = request.get_json(silent=True) or {}
    written = {'projects': 0, 'tasks': 0, 'deleted': 0}

    with _pm_lock:
        for p in data.get('projects', []):
            pid = safe_board_id(p.get('id'))
            if not pid:
                continue
            p['updated_at'] = datetime.utcnow().isoformat()
            _write_json(_pm_project_path(pid), p)
            written['projects'] += 1

        by_project = {}
        for t in data.get('tasks', []):
            pid = safe_board_id(t.get('projectId'))
            if not pid or not t.get('id'):
                continue
            by_project.setdefault(pid, []).append(t)

        removals = {}
        for d in data.get('deleted', []):
            pid = safe_board_id(d.get('projectId'))
            if pid and d.get('id'):
                removals.setdefault(pid, set()).add(d['id'])

        for pid in set(by_project) | set(removals):
            existing = _read_json(_pm_tasks_path(pid), [])
            index = {t['id']: t for t in existing if isinstance(t, dict) and t.get('id')}

            for t in by_project.get(pid, []):
                index[t['id']] = t
                written['tasks'] += 1
            for tid in removals.get(pid, ()):
                if index.pop(tid, None) is not None:
                    written['deleted'] += 1

            _write_json(_pm_tasks_path(pid), list(index.values()))

    return jsonify({'ok': True, **written})


@app.route('/api/pm/project/<project_id>', methods=['DELETE'])
def pm_delete_project(project_id):
    if safe_board_id(project_id) is None:
        return jsonify({'error': 'Invalid project id'}), 400
    with _pm_lock:
        for path in (_pm_project_path(project_id), _pm_tasks_path(project_id)):
            if os.path.exists(path):
                os.remove(path)
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# Email automation
# ---------------------------------------------------------------------------

SMTP_SERVER = os.environ.get('SMTP_SERVER', 'smtp.gmail.com')
SMTP_PORT = int(os.environ.get('SMTP_PORT', 587))
SMTP_USER = os.environ.get('SMTP_USER')
SMTP_PASSWORD = os.environ.get('SMTP_PASSWORD')
SMTP_FROM_NAME = os.environ.get('SMTP_FROM_NAME', 'WhiteBoard Pro')

_email_configured = bool(SMTP_USER and SMTP_PASSWORD)
if not _email_configured:
    logger.info('Email is not configured (set SMTP_USER and SMTP_PASSWORD). '
                'Notifications will be logged instead of sent.')


def _email_shell(title, intro, body_html='', cta_label=None, cta_url=None, footer=''):
    """One template for every notification, so they all look like one product."""
    cta = ''
    if cta_label and cta_url:
        cta = (f'<a href="{cta_url}" style="display:inline-block;background:#4262ff;color:#ffffff;'
               f'padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;'
               f'font-size:14px;margin:18px 0">{cta_label}</a>')

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f4f5f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16161d">
  <div style="max-width:540px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ec;border-radius:14px;padding:30px">
    <div style="font-size:13px;font-weight:700;color:#4262ff;letter-spacing:.02em;margin-bottom:18px">
      WhiteBoard Pro &middot; Projects
    </div>
    <h1 style="margin:0 0 10px;font-size:20px;font-weight:650;line-height:1.35">{title}</h1>
    <p style="margin:0 0 4px;font-size:14.5px;line-height:1.6;color:#5a6274">{intro}</p>
    {body_html}
    {cta}
    <div style="border-top:1px solid #f1f2f6;margin-top:18px;padding-top:14px;font-size:12px;color:#929aab;line-height:1.55">
      {footer or 'You are receiving this because you are a member of this project.'}
    </div>
  </div>
</body></html>"""


def _send_via_gmail_api(to_email, subject, html):
    """
    Send as the connected Google account, using the gmail.send scope the
    Workspace connection already holds.

    This exists because the SMTP path needs a Gmail App Password, App
    Passwords require 2-Step Verification, and Google has been steadily
    withdrawing them — so "email is not configured" was the normal state of
    this app even for someone whose Google account was fully connected. The
    OAuth token can already send mail. Use it.

    Returns None when this route is unavailable, so the caller can fall
    through to SMTP rather than treat it as a failure.
    """
    creds = _load_credentials()
    if not creds:
        return None
    if 'https://www.googleapis.com/auth/gmail.send' not in set(creds.scopes or []):
        return None

    try:
        from googleapiclient.discovery import build
        svc = build('gmail', 'v1', credentials=creds, cache_discovery=False)

        raw = _read_json(_token_path(), None) or {}
        sender = (raw.get('profile') or {}).get('email')

        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['To'] = to_email
        if sender:
            msg['From'] = formataddr((SMTP_FROM_NAME, sender))
        msg.attach(MIMEText(html, 'html', 'utf-8'))

        encoded = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        svc.users().messages().send(userId='me', body={'raw': encoded}).execute()

        logger.info('Email sent to %s via Gmail API (%s)', to_email, subject)
        return {'sent': True, 'mode': 'gmail', 'to': to_email, 'from': sender}
    except Exception as e:
        logger.warning('Gmail API send to %s failed: %s', to_email, e)
        return {'sent': False, 'mode': 'error', 'error': str(e), 'to': to_email}


def send_email(to_email, subject, html):
    """
    Returns a status dict rather than raising: a failed notification must
    never turn into a failed task edit on the client.

    Three routes, in order of how likely they are to be available:
      1. the Gmail API, using the already-connected Google account
      2. SMTP, if an App Password was configured
      3. the log, with the UI told plainly that nothing was sent
    """
    result = _send_via_gmail_api(to_email, subject, html)
    if result and result.get('sent'):
        return result
    gmail_error = result.get('error') if result else None

    if not _email_configured:
        logger.info('[EMAIL NOT SENT — no Gmail connection and no SMTP] to=%s subject=%s',
                    to_email, subject)
        return {'sent': False, 'mode': 'simulated', 'to': to_email,
                'error': gmail_error}

    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = formataddr((SMTP_FROM_NAME, SMTP_USER))
        msg['To'] = to_email
        msg.attach(MIMEText(html, 'html', 'utf-8'))

        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=15) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(SMTP_USER, [to_email], msg.as_string())

        logger.info('Email sent to %s (%s)', to_email, subject)
        return {'sent': True, 'mode': 'smtp', 'to': to_email}
    except Exception as e:
        logger.warning('Email to %s failed: %s', to_email, e)
        return {'sent': False, 'mode': 'error', 'error': str(e), 'to': to_email}


def _email_route():
    """
    Which route mail will actually take right now, as (route, from_address).

    Every caller used to answer this with `_email_configured`, which only
    knows about SMTP. With SMTP blank and Google connected — the normal
    setup here — that reported "email is not configured", so the UI said the
    invitation had not been sent while the Gmail API was sending it
    perfectly. The toast was wrong, not the mail.
    """
    try:
        creds = _load_credentials()
        if creds and 'https://www.googleapis.com/auth/gmail.send' in set(creds.scopes or []):
            sender = ((_read_json(_token_path(), None) or {}).get('profile') or {}).get('email')
            return 'gmail', sender
    except Exception as e:
        logger.info('Could not check the Gmail send route: %s', e)
    if _email_configured:
        return 'smtp', SMTP_USER
    return None, None


# The last few sends, so a caller that fires and forgets can still be asked
# what happened. Bounded — this is a status aid, not a mail log.
_email_log = []
_EMAIL_LOG_MAX = 40


def _record_send(result):
    _email_log.append({**result, 'at': datetime.now(timezone.utc).isoformat()})
    del _email_log[:-_EMAIL_LOG_MAX]
    return result


def _send_batch(jobs, wait=True):
    """
    Send a batch and, when `wait`, report what actually happened.

    Small batches are sent on the request thread so the response can carry
    the truth: the Gmail API round-trip is ~400ms, and a person who clicks
    "Send invite" is entitled to know whether it went. Larger batches move
    to a background thread, because eight sequential SMTP handshakes is
    eight seconds of a spinning button.
    """
    if wait and len(jobs) <= 5:
        results = [_record_send(send_email(to, subject, html)) for to, subject, html in jobs]
        return results, False

    def run():
        for to, subject, html in jobs:
            _record_send(send_email(to, subject, html))
    threading.Thread(target=run, daemon=True).start()
    return [], True


def _send_async(jobs):
    """Fire and forget. Kept for callers that genuinely cannot wait."""
    _send_batch(jobs, wait=False)


def _delivery_summary(results, queued, route):
    """One shape for what the client shows after asking us to send."""
    if queued:
        return {'mode': route or 'simulated', 'queued': True,
                'sent': 0, 'failed': 0, 'results': []}
    sent = [r for r in results if r.get('sent')]
    failed = [r for r in results if not r.get('sent')]
    return {
        'mode': (sent[0].get('mode') if sent else (route or 'simulated')),
        'queued': False,
        'sent': len(sent),
        'failed': len(failed),
        'results': [{'to': r.get('to'), 'sent': bool(r.get('sent')),
                     'mode': r.get('mode'), 'error': r.get('error')} for r in results],
    }


ROLE_BLURB = {
    'owner': 'full control of the project',
    'admin': 'manage tasks and people',
    'member': 'create and edit tasks',
    'guest': 'comment on tasks assigned to you',
    'viewer': 'read-only access',
}


@app.route('/api/pm/invite', methods=['POST'])
def pm_invite():
    """Send project invitations. Membership itself is written by the client."""
    data = request.get_json(silent=True) or {}
    emails = [e.strip().lower() for e in (data.get('emails') or []) if '@' in str(e)]
    if not emails:
        return jsonify({'error': 'At least one valid email address is required'}), 400

    project_name = data.get('projectName', 'a project')
    inviter = data.get('inviter', 'A teammate')
    role = data.get('role', 'member')
    link = data.get('link') or request.host_url.rstrip('/')

    body = (f'<p style="margin:14px 0 0;font-size:14px;line-height:1.6;color:#5a6274">'
            f'Your role is <strong style="color:#16161d">{role}</strong> — '
            f'{ROLE_BLURB.get(role, "collaborate on this project")}.</p>')

    html = _email_shell(
        title=f'{inviter} invited you to “{project_name}”',
        intro='Tasks, whiteboards, timelines and files for this project all live in one workspace.',
        body_html=body,
        cta_label='Open the project',
        cta_url=link,
        footer='Sign in with the Google account this email was sent to and your access is linked automatically.',
    )

    route, sender = _email_route()
    results, queued = _send_batch(
        [(e, f'{inviter} invited you to “{project_name}”', html) for e in emails])

    summary = _delivery_summary(results, queued, route)
    return jsonify({
        'ok': True,
        'count': len(emails),
        'from': sender,
        # `mode` is what older callers read; the rest is what the UI needs to
        # tell the truth about delivery instead of guessing from SMTP config.
        **summary,
        'hint': None if route else
        ('No route to send mail yet. Connect Google in the sidebar and accept the '
         'Gmail permission — that alone is enough. SMTP with an App Password is '
         'the alternative if you would rather not connect an account.'),
    })


@app.route('/api/board/invite', methods=['POST'])
def board_invite():
    """
    Send whiteboard-sharing invitations. Whiteboards have no member/role
    model of their own the way projects do — a board just carries an
    `ownerId` plus `sharedWith`/`sharedEmails` arrays in Firestore, written
    by the client (same pattern as `/api/pm/invite`, scaled down). This
    endpoint only sends the email; it never touches Firestore itself.
    """
    data = request.get_json(silent=True) or {}
    emails = [e.strip().lower() for e in (data.get('emails') or []) if '@' in str(e)]
    if not emails:
        return jsonify({'error': 'At least one valid email address is required'}), 400

    board_name = data.get('boardName', 'a whiteboard')
    inviter = data.get('inviter', 'A teammate')
    link = data.get('link') or request.host_url.rstrip('/')

    html = _email_shell(
        title=f'{inviter} shared “{board_name}” with you',
        intro='It opens straight into this whiteboard — canvas, mind maps and all.',
        body_html='<p style="margin:14px 0 0;font-size:14px;line-height:1.6;color:#5a6274">'
                   'You can edit it live together the moment you open it.</p>',
        cta_label='Open the whiteboard',
        cta_url=link,
        footer='Sign in with the Google account this email was sent to and your access is linked automatically.',
    )

    route, sender = _email_route()
    results, queued = _send_batch(
        [(e, f'{inviter} shared “{board_name}” with you', html) for e in emails])

    summary = _delivery_summary(results, queued, route)
    return jsonify({
        'ok': True,
        'count': len(emails),
        'from': sender,
        **summary,
        'hint': None if route else
        ('No route to send mail yet. Connect Google in the sidebar and accept the '
         'Gmail permission — that alone is enough. SMTP with an App Password is '
         'the alternative if you would rather not connect an account.'),
    })


@app.route('/api/pm/notify', methods=['POST'])
def pm_notify():
    """
    Automation emails triggered by store events: assignment, @mention and
    completion. The client decides *whether* to call this (per the project's
    settings); this endpoint only decides what the email looks like.
    """
    d = request.get_json(silent=True) or {}
    to = (d.get('to') or '').strip().lower()
    if '@' not in to:
        return jsonify({'error': 'Invalid recipient'}), 400

    kind = d.get('kind')
    actor = d.get('actor', 'A teammate')
    task = d.get('taskTitle', 'a task')
    project = d.get('projectName', 'a project')
    link = d.get('link') or request.host_url.rstrip('/')

    def detail_rows(rows):
        cells = ''.join(
            f'<tr><td style="padding:5px 14px 5px 0;font-size:13px;color:#929aab">{k}</td>'
            f'<td style="padding:5px 0;font-size:13px;color:#16161d;font-weight:550">{v}</td></tr>'
            for k, v in rows if v
        )
        return f'<table style="margin:16px 0 0;border-collapse:collapse">{cells}</table>' if cells else ''

    if kind == 'assigned':
        subject = f'{actor} assigned you: {task}'
        html = _email_shell(
            title=task,
            intro=f'{actor} assigned this to you in <strong>{project}</strong>.',
            body_html=detail_rows([
                ('Due', d.get('dueDate') or 'No due date'),
                ('Priority', (d.get('priority') or 'none').title()),
                ('Project', project),
            ]),
            cta_label='Open the task', cta_url=link,
        )

    elif kind == 'mention':
        comment = str(d.get('comment', ''))[:600]
        subject = f'{actor} mentioned you on: {task}'
        html = _email_shell(
            title=f'{actor} mentioned you',
            intro=f'On <strong>{task}</strong> in {project}.',
            body_html=(f'<blockquote style="margin:16px 0 0;padding:12px 15px;background:#f6f7fa;'
                       f'border-left:3px solid #4262ff;border-radius:0 8px 8px 0;font-size:14px;'
                       f'line-height:1.6;color:#16161d">{comment}</blockquote>'),
            cta_label='Reply', cta_url=link,
        )

    elif kind == 'completed':
        subject = f'Completed: {task}'
        html = _email_shell(
            title=f'{task} is done',
            intro=f'{actor} marked this complete in <strong>{project}</strong>.',
            cta_label='View the task', cta_url=link,
        )

    elif kind == 'digest':
        items = d.get('items') or []
        rows = ''.join(
            f'<li style="margin:6px 0;font-size:14px;line-height:1.5">'
            f'<strong>{i.get("title", "")}</strong>'
            f'<span style="color:#929aab"> — {i.get("due", "")}</span></li>'
            for i in items[:25]
        )
        subject = f'{len(items)} task(s) need you today'
        html = _email_shell(
            title='Your day',
            intro=f'{len(items)} task(s) are due or overdue in {project}.',
            body_html=f'<ul style="margin:16px 0 0;padding-left:20px">{rows}</ul>',
            cta_label='Open the workspace', cta_url=link,
        )

    else:
        return jsonify({'error': f'Unknown notification kind: {kind}'}), 400

    route, _ = _email_route()
    _send_async([(to, subject, html)])
    return jsonify({'ok': True, 'mode': route or 'simulated', 'queued': True})


@app.route('/api/pm/email/status', methods=['GET'])
def pm_email_status():
    """
    Lets the UI say "email is not set up yet" instead of failing silently.

    There are two ways mail can go out, and only reporting the SMTP one made
    the app claim email was unavailable while it was perfectly able to send
    through the connected Google account.
    """
    route, sender = _email_route()
    gmail_ready = route == 'gmail'
    gmail_from = sender if gmail_ready else None

    return jsonify({
        'recent': list(reversed(_email_log[-12:])),
        'configured': gmail_ready or _email_configured,
        'route': 'gmail' if gmail_ready else ('smtp' if _email_configured else None),
        'gmail': {'ready': gmail_ready, 'from': gmail_from},
        'smtp': {'ready': _email_configured,
                 'server': SMTP_SERVER if _email_configured else None,
                 'from': SMTP_USER if _email_configured else None},
        # Kept for older callers that read these two at the top level.
        'server': SMTP_SERVER if _email_configured else None,
        'from': gmail_from or (SMTP_USER if _email_configured else None),
    })


@app.route('/api/pm/email/test', methods=['POST'])
def pm_email_test():
    """
    Send one real message and report exactly what happened.

    "Did the invite go out?" was previously unanswerable: the send is
    asynchronous and the response guessed from SMTP config. One button that
    sends a real email and shows the actual result settles it in five
    seconds, and tells the user which account it went out as.
    """
    d = request.get_json(silent=True) or {}
    to = (d.get('to') or '').strip().lower()
    route, sender = _email_route()

    if '@' not in to:
        to = sender or ''
    if '@' not in to:
        return jsonify({
            'ok': False,
            'error': 'No recipient, and no connected account to fall back on.',
            'fix': 'Connect Google in the sidebar, or pass an address to send to.',
        }), 400

    if not route:
        return jsonify({
            'ok': False,
            'route': None,
            'error': 'There is no way to send mail from this server yet.',
            'fix': 'Connect Google and accept the Gmail permission — nothing else is needed. '
                   'Or set SMTP_USER and SMTP_PASSWORD in .env with a Gmail App Password.',
        }), 400

    result = _record_send(send_email(
        to,
        'WhiteBoard Pro — email is working',
        _email_shell(
            title='Email is working',
            intro='This is the test message from your WhiteBoard Pro server. '
                  'Invitations, assignments and @mentions will arrive the same way.',
            body_html=f'<p style="margin:14px 0 0;font-size:13px;color:#929aab">'
                      f'Sent via <strong>{route}</strong>'
                      f'{" as " + sender if sender else ""}.</p>',
            footer='You asked for this from the workspace settings.',
        )))

    return jsonify({
        'ok': bool(result.get('sent')),
        'route': route,
        'to': to,
        'from': sender,
        'error': result.get('error'),
    }), (200 if result.get('sent') else 502)


# ===========================================================================
# GOOGLE WORKSPACE OAUTH  (Calendar · Gmail · Docs · Drive · Tasks)
# ---------------------------------------------------------------------------
# Dormant until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set. Every
# endpoint below returns a clear "not configured" response until then, so the
# UI can show a Connect button that explains itself rather than erroring.
#
# Setup (about five minutes):
#   1. console.cloud.google.com → create or pick a project
#   2. APIs & Services → Library → enable: Google Calendar API, Gmail API,
#      Google Docs API, Google Drive API, Google Tasks API
#   3. APIs & Services → OAuth consent screen → External → add yourself and
#      your teammates as Test users
#   4. Credentials → Create credentials → OAuth client ID → Web application
#      Authorised redirect URI:  http://localhost:5000/api/google/callback
#   5. Set the env vars, then restart:
#        $env:GOOGLE_CLIENT_ID     = "….apps.googleusercontent.com"
#        $env:GOOGLE_CLIENT_SECRET = "…"
#
# Tokens are written to data/pm/tokens/<session>.json. That directory holds
# live credentials — keep it out of version control.
# ===========================================================================

GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID')
GOOGLE_CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET')
GOOGLE_REDIRECT_URI = os.environ.get('GOOGLE_REDIRECT_URI', 'http://localhost:5000/api/google/callback')

# ---------------------------------------------------------------------------
# Scopes
# ---------------------------------------------------------------------------
# The original set could sign in perfectly and still show an empty workspace,
# because two of these scopes do far less than their names suggest:
#
#   drive.file   — grants access ONLY to files this app itself created. A
#                  brand-new client sees an empty Drive forever. It is the
#                  right scope for "save a board to Drive" and the wrong one
#                  for "show me my Drive".
#   gmail.send   — write-only. It cannot list, read or even count a message.
#
# So the connection was real and the data was unreachable. Reading the user's
# own Drive and mail needs the readonly scopes below. Both are *restricted*
# scopes: Google requires either app verification or that the account is
# listed as a Test user on the OAuth consent screen. For a self-hosted
# workspace the Test-user route is the intended path — see the README.
#
# drive.file is kept ALONGSIDE drive.readonly on purpose: readonly cannot
# write, and drive.file is what lets the app export a board back to Drive
# without asking for blanket write access to everything the user owns.
# ---------------------------------------------------------------------------

GOOGLE_SCOPES = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',

    # Calendar: full access, so the agenda can list calendars as well as
    # read and write events on them.
    'https://www.googleapis.com/auth/calendar',

    # Gmail: read the inbox, and send notification mail.
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',

    # Docs: create and edit documents the app makes.
    'https://www.googleapis.com/auth/documents',

    # Drive: see everything (readonly), write only what this app created.
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',

    'https://www.googleapis.com/auth/tasks',

    # Sheets: read cell values for the live dashboards, and write back the
    # ones a dashboard edits in place. drive.readonly can *find* a
    # spreadsheet but cannot read a single cell out of it — that needs the
    # Sheets API and its own scope.
    'https://www.googleapis.com/auth/spreadsheets',
]

# ---------------------------------------------------------------------------
# Google Keep — opt-in, and why
# ---------------------------------------------------------------------------
# The official Keep API (keep.googleapis.com) is a Google Workspace
# *enterprise* service. It authorises against a managed Workspace domain and
# returns 403 PERMISSION_DENIED for consumer @gmail.com accounts, whatever is
# enabled in the Cloud console — enabling the API there is necessary but not
# sufficient, and there is no setting that makes a personal account eligible.
#
# So this scope is off by default. Requesting a scope the account cannot be
# granted risks the whole consent screen, which would take Drive, Docs, Gmail
# and Calendar down with it — a working connection traded for one that cannot
# work. Set GOOGLE_ENABLE_KEEP=1 on a Workspace account to turn it on.
#
# For a personal account the legacy path (Keep → App Password, /api/keep/*)
# remains the only route, and /api/google/keep/notes says so rather than
# returning an empty list.
GOOGLE_KEEP_SCOPE = 'https://www.googleapis.com/auth/keep.readonly'
_keep_api_enabled = os.environ.get('GOOGLE_ENABLE_KEEP', '').strip().lower() in ('1', 'true', 'yes', 'on')
if _keep_api_enabled:
    GOOGLE_SCOPES.append(GOOGLE_KEEP_SCOPE)
    logger.info('Google Keep API scope requested (GOOGLE_ENABLE_KEEP is set). '
                'This only works on a Google Workspace account.')

# Scopes that must be present for a given surface to work at all. Used by
# /api/google/status so the UI can say "reconnect to grant Gmail access"
# instead of rendering an empty list and leaving the user to guess.
SCOPE_REQUIREMENTS = {
    'drive':    ['https://www.googleapis.com/auth/drive.readonly'],
    'docs':     ['https://www.googleapis.com/auth/drive.readonly'],
    'gmail':    ['https://www.googleapis.com/auth/gmail.readonly'],
    'calendar': ['https://www.googleapis.com/auth/calendar',
                 'https://www.googleapis.com/auth/calendar.events'],
    'tasks':    ['https://www.googleapis.com/auth/tasks'],
    'sheets':   ['https://www.googleapis.com/auth/spreadsheets',
                 'https://www.googleapis.com/auth/spreadsheets.readonly'],
}

_google_configured = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
if not _google_configured:
    logger.info('Google Workspace integration is dormant '
                '(set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable it).')


# ---------------------------------------------------------------------------
# oauthlib transport policy
#
# oauthlib raises InsecureTransportError for any non-https redirect, including
# http://localhost. Google itself permits localhost redirects — loopback never
# crosses the network, so there is nothing to intercept — but oauthlib applies
# the rule bluntly and the exception surfaces on the callback, not on the
# authorize step.
#
# The documented opt-out is OAUTHLIB_INSECURE_TRANSPORT. Enabling it blindly
# would also disable the check for a real deployment, so it is set ONLY when
# the configured redirect is http *and* points at loopback. Point
# GOOGLE_REDIRECT_URI at a real domain and the check comes straight back on.
# ---------------------------------------------------------------------------

def _is_loopback_redirect(uri):
    try:
        from urllib.parse import urlparse
        parsed = urlparse(uri)
        return (parsed.scheme == 'http'
                and parsed.hostname in ('localhost', '127.0.0.1', '::1', '[::1]'))
    except Exception:
        return False


_loopback_oauth = _is_loopback_redirect(GOOGLE_REDIRECT_URI)

if _google_configured and _loopback_oauth:
    os.environ.setdefault('OAUTHLIB_INSECURE_TRANSPORT', '1')
    logger.info('OAuth: allowing http on loopback for %s '
                '(this relaxation does NOT apply to a non-localhost redirect).',
                GOOGLE_REDIRECT_URI)
elif _google_configured and not GOOGLE_REDIRECT_URI.startswith('https://'):
    logger.warning('OAuth: GOOGLE_REDIRECT_URI is neither https nor loopback (%s). '
                   'Google will reject it and oauthlib will refuse the callback.',
                   GOOGLE_REDIRECT_URI)

# Google routinely returns a scope set that differs from the one requested —
# it expands `openid` into the userinfo scopes and reorders the rest. oauthlib
# treats any difference as a warning-level error and aborts the token
# exchange. Relaxing this compares the granted scopes rather than demanding an
# exact string match; the scopes actually granted are still recorded and shown
# by /api/google/status.
if _google_configured:
    os.environ.setdefault('OAUTHLIB_RELAX_TOKEN_SCOPE', '1')


def _google_client_config():
    return {
        'web': {
            'client_id': GOOGLE_CLIENT_ID,
            'client_secret': GOOGLE_CLIENT_SECRET,
            'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
            'token_uri': 'https://oauth2.googleapis.com/token',
            'redirect_uris': [GOOGLE_REDIRECT_URI],
        }
    }


# ---------------------------------------------------------------------------
# Pending OAuth flows
#
# Keyed by the `state` value Google round-trips back to us, NOT by the Flask
# session. The popup returns from a cross-site redirect, and the session
# cookie is not reliably present at that point — the common cause is a cookie
# host mismatch (app opened on 127.0.0.1, redirect registered as localhost:
# different cookie jars), but a strict cookie policy or a popup landing in
# another profile does it too.
#
# `state` is generated by oauthlib with ~180 bits of entropy, is used exactly
# once, and expires. It is a better flow identifier here than a cookie that
# may not survive the redirect.
# ---------------------------------------------------------------------------

import time

_pending_oauth = {}
_PENDING_OAUTH_TTL = 600          # 10 minutes to complete a consent screen


def _prune_pending_oauth():
    cutoff = time.time() - _PENDING_OAUTH_TTL
    for key in [k for k, v in _pending_oauth.items() if v['at'] < cutoff]:
        _pending_oauth.pop(key, None)


def _remember_oauth_flow(state, code_verifier):
    _prune_pending_oauth()
    _pending_oauth[state] = {'code_verifier': code_verifier, 'at': time.time()}


def _recall_oauth_flow(state):
    """Single use: recalling a flow consumes it, so a state cannot be replayed."""
    _prune_pending_oauth()
    entry = _pending_oauth.pop(state, None)
    return entry['code_verifier'] if entry else None


def _oauth_error_page(title, detail, fix, code=400):
    """A readable failure page in the popup, instead of a raw traceback."""
    from html import escape
    return f"""<!doctype html><meta charset="utf-8">
    <title>Google sign-in</title>
    <body style="margin:0;padding:40px;background:#f4f5f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#16161d">
      <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e6ec;border-radius:14px;padding:28px">
        <h2 style="margin:0 0 10px;font-size:18px">{escape(title)}</h2>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#5a6274">{escape(detail)}</p>
        <div style="background:#f6f7fa;border-left:3px solid #4262ff;border-radius:0 8px 8px 0;padding:12px 15px;font-size:13.5px;line-height:1.6">
          <strong>How to fix it</strong><br>{escape(fix)}
        </div>
        <p style="margin:18px 0 0;font-size:12.5px;color:#929aab">You can close this window.</p>
      </div>
    </body>""", code


def _token_path():
    """
    Where the Google credentials live.

    On loopback this server is a single-user local helper, so one shared token
    file is both simpler and far more robust — it does not depend on a cookie
    surviving the cross-site redirect back from Google. Keying this by session
    is what made a successful sign-in still read as "not connected": the
    callback saved the token under the popup's session, and the app, on a
    different cookie host, looked under a different one.

    Deployed on a real (non-loopback) host, fall back to per-session tokens so
    one person's Google account is not silently used for everybody.
    """
    if _loopback_oauth:
        return os.path.join(PM_TOKENS_DIR, 'google.json')

    key = session.get('pm_session')
    if not key:
        key = uuid.uuid4().hex
        session['pm_session'] = key
        session.permanent = True
    return os.path.join(PM_TOKENS_DIR, f'{key}.json')


def _save_credentials(creds, profile=None):
    """
    Persist the token. `profile` (email / name / picture) is written once at
    consent time and carried forward on every silent refresh, so the UI can
    always name the Google account it is talking to — the missing piece that
    made the connection feel anonymous and untrustworthy.
    """
    path = _token_path()
    previous = _read_json(path, None) or {}
    _write_json(path, {
        'token': creds.token,
        'refresh_token': creds.refresh_token or previous.get('refresh_token'),
        'token_uri': creds.token_uri,
        'client_id': creds.client_id,
        'client_secret': creds.client_secret,
        'scopes': list(creds.scopes or previous.get('scopes') or []),
        'expiry': creds.expiry.isoformat() if creds.expiry else None,
        'profile': profile or previous.get('profile'),
    })


def _fetch_profile(creds):
    """Who this token belongs to. Best effort — never fatal."""
    try:
        from googleapiclient.discovery import build
        info = build('oauth2', 'v2', credentials=creds,
                     cache_discovery=False).userinfo().get().execute()
        return {
            'email': info.get('email'),
            'name': info.get('name'),
            'picture': info.get('picture'),
            # Google's own stable per-account id — never changes for this
            # person, unlike the token itself. This is what becomes the
            # Firebase uid, so the same person lands on the same identity
            # every time they connect, on any device.
            'googleUid': info.get('id'),
        }
    except Exception as e:
        logger.info('Could not read Google profile: %s', e)
        return None


def _load_credentials():
    """
    Returns live credentials or None. Refreshes and re-persists silently when
    the access token has expired but the refresh token is still good.
    """
    if not _google_configured:
        return None
    raw = _read_json(_token_path(), None)
    if not raw or not raw.get('refresh_token'):
        return None

    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request as GoogleRequest
    except ImportError:
        logger.warning('google-auth is not installed. Run: pip install -r requirements.txt')
        return None

    creds = Credentials(
        token=raw.get('token'),
        refresh_token=raw.get('refresh_token'),
        token_uri=raw.get('token_uri', 'https://oauth2.googleapis.com/token'),
        client_id=raw.get('client_id', GOOGLE_CLIENT_ID),
        client_secret=raw.get('client_secret', GOOGLE_CLIENT_SECRET),
        scopes=raw.get('scopes', GOOGLE_SCOPES),
    )

    if not creds.valid:
        if not creds.refresh_token:
            return None
        try:
            creds.refresh(GoogleRequest())
            _save_credentials(creds)
        except Exception as e:
            logger.warning('Google token refresh failed: %s', e)
            return None
    return creds


def _google_service(name, version):
    creds = _load_credentials()
    if not creds:
        return None
    try:
        from googleapiclient.discovery import build
        return build(name, version, credentials=creds, cache_discovery=False)
    except ImportError:
        logger.warning('google-api-python-client is not installed. Run: pip install -r requirements.txt')
        return None


# Which console API each service needs enabled, for the error message below.
GOOGLE_API_NAMES = {
    'calendar': ('Google Calendar API', 'calendar-json.googleapis.com'),
    'docs': ('Google Docs API', 'docs.googleapis.com'),
    'drive': ('Google Drive API', 'drive.googleapis.com'),
    'gmail': ('Gmail API', 'gmail.googleapis.com'),
    'tasks': ('Google Tasks API', 'tasks.googleapis.com'),
    'keep': ('Google Keep API', 'keep.googleapis.com'),
    'sheets': ('Google Sheets API', 'sheets.googleapis.com'),
}


def _google_error(service, exc):
    """
    Turn a Google API exception into something the user can act on.

    The two failures that actually happen in practice — the API not being
    enabled in the console, and a scope the user did not grant — both come
    back as long opaque strings. Naming the fix beats echoing the wall of text.
    """
    text = str(exc)
    api_label, api_host = GOOGLE_API_NAMES.get(service, (service, ''))

    if 'accessNotConfigured' in text or 'has not been used in project' in text or 'is disabled' in text:
        return {
            'error': f'{api_label} is not enabled for this Google Cloud project.',
            'fix': f'Enable it here, wait about a minute, then try again: '
                   f'https://console.cloud.google.com/apis/library/{api_host}?project={GOOGLE_PROJECT_HINT}',
            'detail': text[:400],
        }, 400

    if 'insufficient' in text.lower() or 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' in text:
        return {
            'error': 'Your Google connection is missing a permission this action needs.',
            'fix': 'Disconnect Google in the sidebar and connect again, accepting every permission.',
            'detail': text[:400],
        }, 403

    if 'invalid_grant' in text or 'Token has been expired or revoked' in text:
        return {
            'error': 'Your Google connection has expired.',
            'fix': 'Reconnect from the sidebar. If your OAuth consent screen is still in '
                   '"Testing", Google expires refresh tokens after 7 days — publish the app '
                   'to stop that happening.',
            'detail': text[:400],
        }, 401

    logger.error('Google %s error: %s', service, text)
    return {'error': text[:500]}, 500


# The numeric prefix of the client id is the Cloud project number, which is
# enough for a working console deep link.
GOOGLE_PROJECT_HINT = (GOOGLE_CLIENT_ID or '').split('-')[0] or ''


def _surface_availability(granted):
    """
    Which parts of the workspace the granted scope set can actually serve.

    A surface counts as available when ANY of its listed scopes is present —
    Calendar, for instance, works with either the full scope or the narrower
    events one.
    """
    have = set(granted or [])
    return {name: any(s in have for s in needed)
            for name, needed in SCOPE_REQUIREMENTS.items()}


@app.route('/api/google/status', methods=['GET'])
def google_status():
    """Drives the Connect / Connected state in the UI."""
    if not _google_configured:
        return jsonify({
            'configured': False,
            'connected': False,
            'reason': 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart the server. '
                      'Setup steps are in the README under "Google Workspace".',
        })
    raw = _read_json(_token_path(), None)
    connected = bool(raw and raw.get('refresh_token'))
    granted = (raw or {}).get('scopes', [])

    # A token minted before the scope set was widened still authenticates
    # perfectly — it just cannot see Drive or Gmail. That is exactly the
    # failure that reads as "connected, but nothing shows up", so name it.
    missing = [s for s in GOOGLE_SCOPES if s not in set(granted)]
    stale = connected and bool(missing)

    # If the app is being browsed on a different host than the registered
    # redirect (the classic 127.0.0.1 vs localhost split), say so — it is
    # invisible otherwise and it breaks cookies in ways that look like
    # unrelated OAuth failures. With the canonical-host redirect in front of
    # every request this should now be unreachable on loopback; it still
    # catches a LAN address, which is deliberately never redirected.
    browsing_host = urlparse(request.host_url).hostname
    redirect_host = urlparse(GOOGLE_REDIRECT_URI).hostname
    mismatch = browsing_host != redirect_host

    account = (raw or {}).get('profile') or None

    return jsonify({
        'configured': True,
        'connected': connected,
        'account': account,
        # Same object under the name the whiteboard's header reads. Two names
        # for one thing is not elegant, but reading the wrong one is what
        # made a fully connected account still render a second, broken
        # "Google Sign in" button in the top bar.
        'profile': account,
        'scopes': granted,
        'missingScopes': missing,
        'needsReconsent': stale,
        'available': _surface_availability(granted),
        'reconsentHint': (
            'This connection was made before the app asked for permission to read your '
            'Drive, Docs and Gmail, so those panels have nothing to show. Reconnect and '
            'accept every permission — it takes one click.'
        ) if stale else None,
        'redirectUri': GOOGLE_REDIRECT_URI,
        'hostMismatch': mismatch,
        'hostHint': (
            f'You are using the app at {browsing_host}, but the Google redirect is registered '
            f'for {redirect_host}. Sign-in still works, but open the app at '
            f'http://{redirect_host}:5000 to keep everything on one host.'
        ) if mismatch else None,
    })


# ---------------------------------------------------------------------------
# Firebase identity bridge
#
# Firebase Authentication and the Workspace OAuth connection above used to be
# two unrelated sign-ins — connecting Workspace never signed you into
# Firebase, so live sync / sharing (which run on Firebase's identity) asked
# for a second, separate Google consent screen. That second screen is also
# what broke when Firebase's own stored OAuth client secret went stale
# (auth/invalid-credential) — a Google Cloud console problem, not something
# fixable in this app.
#
# This removes the second sign-in entirely: once Workspace is connected, the
# client calls this endpoint, which mints a Firebase custom token for that
# same Google account and upserts a matching Firebase Auth user record (so
# email/name/photo are populated the same way a real Google sign-in would
# set them). The uid is derived from Google's own stable per-account id, so
# the same person always lands on the same Firebase identity — on any
# device, any session, forever — which is exactly what board ownership and
# project membership need to keep working correctly.
# ---------------------------------------------------------------------------

_firebase_admin_app = None
_firebase_admin_error = None


def _firebase_admin():
    """
    Lazily initialise the Firebase Admin SDK.

    Only a genuinely permanent failure (the package itself missing) is
    cached — a missing key file is retried on every call, since the whole
    point is that someone can drop that file in *after* the server is
    already running and have it start working without a restart.
    """
    global _firebase_admin_app, _firebase_admin_error
    if _firebase_admin_app is not None:
        return _firebase_admin_app
    if _firebase_admin_error == 'firebase-admin is not installed':
        return None
    try:
        import firebase_admin
        from firebase_admin import credentials as fb_credentials
    except ImportError:
        _firebase_admin_error = 'firebase-admin is not installed'
        logger.warning('Firebase Admin not available: %s. Run: pip install -r requirements.txt', _firebase_admin_error)
        return None

    key_path = os.environ.get('FIREBASE_SERVICE_ACCOUNT',
                               os.path.join(DATA_DIR, 'firebase-service-account.json'))
    if not os.path.exists(key_path):
        if _firebase_admin_error != f'no service account key at {key_path}':
            _firebase_admin_error = f'no service account key at {key_path}'
            logger.warning(
                'Firebase Admin not configured (%s). One Google sign-in cannot bridge to Firebase '
                'without it — get a key from Firebase console -> Project settings -> Service '
                'accounts -> Generate new private key, save it to that path (or point '
                'FIREBASE_SERVICE_ACCOUNT at it) — no restart needed once it is there.', _firebase_admin_error)
        return None

    try:
        cred = fb_credentials.Certificate(key_path)
        _firebase_admin_app = firebase_admin.initialize_app(cred)
        _firebase_admin_error = None
        logger.info('Firebase Admin initialised — one Google sign-in now covers Firebase too.')
        return _firebase_admin_app
    except Exception as e:
        _firebase_admin_error = str(e)
        logger.warning('Firebase Admin init failed: %s', e)
        return None


@app.route('/api/auth/firebase-token', methods=['GET'])
def firebase_token():
    """A Firebase custom token for whoever the current Workspace connection belongs to."""
    if _firebase_admin() is None:
        return jsonify({
            'error': 'Firebase Admin is not configured on the server.',
            'fix': 'Generate a service account key (Firebase console -> Project settings -> '
                   'Service accounts -> Generate new private key) and save it to '
                   'data/firebase-service-account.json, then restart the server.',
        }), 501

    creds = _load_credentials()
    if not creds:
        return jsonify({'error': 'Connect Google Workspace first.'}), 401

    raw = _read_json(_token_path(), None) or {}
    profile = raw.get('profile') or {}
    google_uid = profile.get('googleUid')
    if not google_uid:
        # Token predates this feature (googleUid was added alongside it) —
        # one reconnect refreshes the stored profile and fixes this for good.
        return jsonify({
            'error': 'This Google connection predates the account id this needs.',
            'fix': 'Reconnect Google Workspace once — Drive/Gmail/Calendar keep working the whole time.',
        }), 409

    from firebase_admin import auth as fb_auth
    email = profile.get('email')
    preferred_uid = 'google:' + google_uid
    profile_fields = {
        'display_name': profile.get('name'),
        'photo_url': profile.get('picture'),
    }
    profile_fields = {k: v for k, v in profile_fields.items() if v}

    # Whoever already owns this email address wins, whatever uid they were
    # given. Anyone who signed in through the older direct-to-Firebase popup
    # already has an account under Firebase's own generated uid, and their
    # boards and project memberships are keyed to *that* uid — minting a
    # second account for the same person under `google:<id>` would both be
    # refused (EMAIL_EXISTS) and orphan everything they already own.
    record = None
    if email:
        try:
            record = fb_auth.get_user_by_email(email)
        except fb_auth.UserNotFoundError:
            record = None
        except Exception as e:
            logger.warning('Firebase lookup by email failed: %s', e)
    if record is None:
        try:
            record = fb_auth.get_user(preferred_uid)
        except fb_auth.UserNotFoundError:
            record = None
        except Exception as e:
            logger.warning('Firebase lookup by uid failed: %s', e)

    try:
        if record is None:
            record = fb_auth.create_user(uid=preferred_uid, email=email,
                                         email_verified=True, **profile_fields)
        elif profile_fields:
            record = fb_auth.update_user(record.uid, **profile_fields)
    except Exception as e:
        logger.warning('Firebase user upsert failed: %s', e)
        return jsonify({'error': f'Could not prepare the Firebase identity: {e}'}), 502

    try:
        token = fb_auth.create_custom_token(record.uid)
    except Exception as e:
        logger.warning('Firebase custom token mint failed: %s', e)
        return jsonify({'error': f'Could not mint a sign-in token: {e}'}), 502

    return jsonify({'token': token.decode('utf-8') if isinstance(token, bytes) else token})


@app.route('/voice/<board_id>', methods=['GET'])
def voice_page(board_id):
    """
    A microphone and nothing else, for joining a board's voice channel from
    a phone when the computer has no usable mic. Deliberately not the whole
    board: a phone does not need the canvas to carry a voice.
    """
    if not SAFE_ID.match(board_id or ''):
        return 'Unknown board.', 404
    return render_template('voice.html', board_id=board_id)


@app.route('/api/network/hosts', methods=['GET'])
def network_hosts():
    """
    Addresses this server can be reached on from *another* device.

    "localhost" in a QR code is useless — on the phone that scans it, it
    means the phone. The LAN address is the one that can actually resolve,
    so report it and let the client prefer it.
    """
    import socket
    port = (request.host.split(':') + ['5000'])[1]
    hosts = [{'host': request.host.split(':')[0], 'port': port, 'lan': False}]
    try:
        # Nothing is actually sent; this just asks the OS which local
        # interface would be used to reach the outside world.
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(('8.8.8.8', 80))
            lan_ip = probe.getsockname()[0]
        finally:
            probe.close()
        if lan_ip and not lan_ip.startswith('127.'):
            hosts.append({'host': lan_ip, 'port': port, 'lan': True})
    except Exception as e:
        logger.info('Could not determine the LAN address: %s', e)
    return jsonify({'hosts': hosts})


@app.route('/api/google/auth', methods=['GET'])
def google_auth():
    if not _google_configured:
        return jsonify({'error': 'Google integration is not configured on this server.'}), 501
    try:
        from google_auth_oauthlib.flow import Flow
    except ImportError:
        return jsonify({'error': 'google-auth-oauthlib is not installed. Run: pip install -r requirements.txt'}), 500

    flow = Flow.from_client_config(_google_client_config(), scopes=GOOGLE_SCOPES,
                                   redirect_uri=GOOGLE_REDIRECT_URI)
    # access_type=offline + prompt=consent is what actually yields a refresh
    # token; without it Google returns one only on the very first consent and
    # the integration silently dies a week later.
    auth_url, state = flow.authorization_url(
        access_type='offline', include_granted_scopes='true', prompt='consent')

    # PKCE: authorization_url() generates a one-time code_verifier and sends
    # only its SHA-256 hash to Google. The callback builds a *new* Flow object,
    # so the verifier has to be carried across in the session or the token
    # exchange fails with "Missing code verifier". Storing state alone is not
    # enough — that is a different value solving a different problem.
    _remember_oauth_flow(state, flow.code_verifier)

    # Also mirrored into the session as a belt-and-braces path for the case
    # where the server is restarted mid-flow (the in-memory store is lost but
    # the cookie is not).
    session.permanent = True
    session['google_oauth_state'] = state
    session['google_code_verifier'] = flow.code_verifier

    logger.info('OAuth: authorize started (PKCE %s)',
                'on' if flow.code_verifier else 'off')
    return jsonify({'url': auth_url})


@app.route('/api/google/callback')
def google_callback():
    if not _google_configured:
        return 'Google integration is not configured.', 501
    try:
        from google_auth_oauthlib.flow import Flow
    except ImportError:
        return 'google-auth-oauthlib is not installed.', 500

    # Google reports user-side failures as query params, not exceptions.
    denied = request.args.get('error')
    if denied:
        return _oauth_error_page(
            'Google sign-in was cancelled' if denied == 'access_denied' else 'Google returned an error',
            'You declined the permissions, or the consent screen closed early.'
            if denied == 'access_denied' else denied,
            'Close this window and click Connect again. Accept every permission on the consent screen.')

    returned_state = request.args.get('state')

    # Recall the PKCE verifier by state first (cookie-independent), and only
    # fall back to the session copy. Google rejects the exchange with
    # "Missing code verifier" if neither is available.
    code_verifier = _recall_oauth_flow(returned_state) if returned_state else None
    source = 'state'
    if not code_verifier:
        code_verifier = session.get('google_code_verifier')
        source = 'session'

    if not code_verifier:
        return _oauth_error_page(
            'Sign-in could not be matched to a request',
            'The one-time PKCE verifier for this sign-in is not on the server or in the session.',
            'The sign-in may have taken longer than 10 minutes, or the server restarted midway. '
            'Close this window and click Connect again.')

    try:
        flow = Flow.from_client_config(
            _google_client_config(), scopes=GOOGLE_SCOPES,
            state=returned_state or session.get('google_oauth_state'),
            redirect_uri=GOOGLE_REDIRECT_URI)
        flow.code_verifier = code_verifier
        logger.info('OAuth: callback matched via %s', source)

        # Flask sits behind the dev server as http; if the app is ever put
        # behind a TLS-terminating proxy, request.url still says http and
        # oauthlib compares it against the registered https redirect.
        authorization_response = request.url
        if GOOGLE_REDIRECT_URI.startswith('https://') and authorization_response.startswith('http://'):
            authorization_response = 'https://' + authorization_response[len('http://'):]

        flow.fetch_token(authorization_response=authorization_response)
        creds = flow.credentials

        if not creds.refresh_token:
            # Without a refresh token the connection dies in an hour. This
            # happens when Google has already granted consent and was not
            # asked again — the fix is to revoke and re-consent.
            logger.warning('Google returned no refresh token.')
            return _oauth_error_page(
                'Connected, but without a refresh token',
                'Google did not return a refresh token, so this connection would stop working within the hour.',
                'Remove this app at https://myaccount.google.com/permissions, then click Connect again.')

        _save_credentials(creds, profile=_fetch_profile(creds))
        # Both are single-use; leaving them behind invites a replay.
        session.pop('google_oauth_state', None)
        session.pop('google_code_verifier', None)
        logger.info('Google connected. Scopes granted: %s', ', '.join(creds.scopes or []))

        # Consent screens let a user untick individual permissions. Say so at
        # the moment it happens rather than leaving an empty panel later.
        skipped = [s for s in GOOGLE_SCOPES if s not in set(creds.scopes or [])]
        if skipped:
            logger.warning('Google consent skipped %d scope(s): %s',
                           len(skipped), ', '.join(skipped))

    except Exception as e:
        text = str(e)
        logger.error('Google OAuth callback failed: %s', text)

        if 'insecure_transport' in text or 'InsecureTransport' in text:
            return _oauth_error_page(
                'OAuth refused a plain-HTTP redirect',
                'oauthlib requires https unless the redirect is loopback.',
                f'GOOGLE_REDIRECT_URI is currently "{GOOGLE_REDIRECT_URI}". '
                'It must be exactly http://localhost:5000/api/google/callback, then restart the server.')

        if 'redirect_uri_mismatch' in text:
            return _oauth_error_page(
                'Redirect URI mismatch',
                'The redirect this server sent does not match one registered on the OAuth client.',
                f'Add exactly this, with no trailing slash, under Credentials → your OAuth client → '
                f'Authorised redirect URIs: {GOOGLE_REDIRECT_URI}')

        if 'Scope has changed' in text:
            return _oauth_error_page(
                'Google returned a different scope set',
                'Google expanded or reordered the requested scopes and oauthlib rejected the difference.',
                'Restart the server — OAUTHLIB_RELAX_TOKEN_SCOPE is set at startup and fixes this.')

        if 'code verifier' in text.lower() or 'code_verifier' in text:
            return _oauth_error_page(
                'PKCE verifier did not reach the token exchange',
                'Google requires the one-time verifier generated when sign-in started, and it was not sent.',
                'Restart the server so the fix is loaded, then click Connect again. If it persists, '
                'your browser is not returning the session cookie to the popup.')

        if 'invalid_client' in text:
            return _oauth_error_page(
                'Google rejected the client credentials',
                'The client ID or secret is wrong, or the secret has been reset.',
                'Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart the server.')

        if 'MismatchingState' in text or 'state' in text.lower() and 'mismatch' in text.lower():
            return _oauth_error_page(
                'Session state did not match',
                'The browser session that started sign-in is not the one that came back.',
                'Close the popup and click Connect again in the same browser window.')

        return _oauth_error_page('Google sign-in failed', text[:500],
                                 'The full error is in the server console.')

    # Two ways in, so two ways out. Opened as a popup, tell the opener and
    # close. Navigated in the main tab — which is what happens when the
    # browser blocks popups — there is nothing to close and window.close()
    # is a no-op, so the user was left stranded on this page. Go back to the
    # app instead.
    #
    # window.opener is NOT a reliable way to tell those two cases apart:
    # accounts.google.com sends Cross-Origin-Opener-Policy: same-origin,
    # which severs a popup's opener reference the moment it navigates
    # there — even though it really was opened as a popup and really can
    # still close itself. Trusting `opener` here made a genuine popup
    # believe it was the main tab and load the *entire app* inside its own
    # small window. BroadcastChannel isn't tied to the opener reference at
    # all, so it survives that; and window.close() itself only actually
    # fails when this truly isn't a popup, so try it regardless of what
    # `opener` reads as and only fall back to redirecting if it's still
    # open a moment later.
    return """<!doctype html><meta charset="utf-8">
    <body style="font-family:system-ui;padding:40px;text-align:center">
      <h3>Google connected</h3><p id="msg">You can close this window.</p>
      <script>
        try { new BroadcastChannel('wbpro-google-oauth').postMessage({ type: 'google-connected' }); } catch (e) {}
        try { window.opener && window.opener.postMessage({ type: 'google-connected' }, window.location.origin); } catch (e) {}
        setTimeout(function () {
          try { window.close(); } catch (e) {}
          setTimeout(function () {
            if (!window.closed) {
              document.getElementById('msg').textContent = 'Taking you back to the board\\u2026';
              window.location.replace('/?google=connected');
            }
          }, 400);
        }, 300);
      </script>
    </body>"""


@app.route('/api/google/keep/notes', methods=['GET'])
def google_keep_notes():
    """
    Notes from the official Keep API.

    Enabling the Keep API in the Cloud console is necessary but not
    sufficient: keep.googleapis.com only serves Google Workspace accounts, so
    a personal @gmail.com account gets 403 no matter what is switched on.
    Rather than return an empty list and let that look like "you have no
    notes", every unavailable case says exactly which one it is and what the
    working alternative is.
    """
    if not _keep_api_enabled:
        return jsonify({
            'error': 'The Google Keep API is not switched on for this server.',
            'fix': 'The Keep API only serves Google Workspace accounts, never personal '
                   '@gmail.com ones. On a Workspace account, set GOOGLE_ENABLE_KEEP=1 in '
                   '.env, restart, and reconnect Google. On a personal account, use '
                   'Import from Google Keep in the top bar, which signs in with an App '
                   'Password instead.',
            'alternative': 'app-password',
        }), 501

    creds = _load_credentials()
    if not creds:
        return jsonify({'error': 'Google is not connected.'}), 401
    if GOOGLE_KEEP_SCOPE not in set(creds.scopes or []):
        return jsonify({
            'error': 'This connection was made before Keep was switched on.',
            'fix': 'Reconnect your Google account and accept the Keep permission.',
        }), 403

    try:
        from googleapiclient.discovery import build
        svc = build('keep', 'v1', credentials=creds, cache_discovery=False)
        res = svc.notes().list(pageSize=int(request.args.get('limit', 50))).execute()

        notes = []
        for n in res.get('notes', []):
            body = n.get('body', {})
            text = (body.get('text') or {}).get('text', '')
            items = [
                {'text': (i.get('text') or {}).get('text', ''), 'checked': bool(i.get('checked'))}
                for i in (body.get('list') or {}).get('listItems', [])
            ]
            notes.append({
                'id': n.get('name', '').split('/')[-1],
                'title': n.get('title', ''),
                'text': text or '\n'.join(i['text'] for i in items),
                'items': items,
                'trashed': bool(n.get('trashed')),
                'updated': n.get('updateTime'),
            })
        return jsonify({'notes': notes, 'nextPage': res.get('nextPageToken')})

    except Exception as e:
        body, code = _google_error('keep', e)
        text = str(e)
        if 'PERMISSION_DENIED' in text or code == 403:
            body['fix'] = (
                'keep.googleapis.com serves Google Workspace accounts only. A personal '
                '@gmail.com account cannot be granted access however the Cloud project is '
                'configured. Use Import from Google Keep in the top bar instead — it signs '
                'in with an App Password and works on personal accounts.')
            body['alternative'] = 'app-password'
        return jsonify(body), code


@app.route('/api/google/disconnect', methods=['POST'])
def google_disconnect():
    path = _token_path()
    if os.path.exists(path):
        os.remove(path)
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# Google Calendar — two-way task/event mirroring
# ---------------------------------------------------------------------------

@app.route('/api/google/calendar/push', methods=['POST'])
def google_calendar_push():
    """
    Create or update the calendar event mirroring a task's due date.
    Returns the event id, which the client stores on the task so the next
    push updates the same event instead of creating a duplicate.
    """
    svc = _google_service('calendar', 'v3')
    if not svc:
        return jsonify({'error': 'Google Calendar is not connected.'}), 401

    d = request.get_json(silent=True) or {}
    title = d.get('title', 'Task')
    due = d.get('dueDate')
    if not due:
        return jsonify({'error': 'The task has no due date.'}), 400

    due_time = d.get('dueTime')
    if due_time:
        start = {'dateTime': f'{due}T{due_time}:00', 'timeZone': d.get('timeZone', 'UTC')}
        end_hour = f'{(int(due_time[:2]) + 1) % 24:02d}{due_time[2:]}'
        end = {'dateTime': f'{due}T{end_hour}:00', 'timeZone': d.get('timeZone', 'UTC')}
    else:
        # All-day events are half-open in the Calendar API: end must be the
        # day after, or the event does not render at all.
        nxt = (datetime.strptime(due, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
        start, end = {'date': due}, {'date': nxt}

    body = {
        'summary': title,
        'description': (d.get('description') or '') + (f"\n\n{d['link']}" if d.get('link') else ''),
        'start': start,
        'end': end,
        'source': {'title': 'WhiteBoard Pro', 'url': d.get('link', '')} if d.get('link') else None,
        'attendees': [{'email': e} for e in (d.get('attendees') or []) if '@' in e] or None,
        'reminders': {'useDefault': True},
    }
    body = {k: v for k, v in body.items() if v is not None}

    try:
        event_id = d.get('eventId')
        if event_id:
            ev = svc.events().update(calendarId='primary', eventId=event_id, body=body).execute()
        else:
            ev = svc.events().insert(calendarId='primary', body=body).execute()
        return jsonify({'ok': True, 'eventId': ev['id'], 'htmlLink': ev.get('htmlLink')})
    except Exception as e:
        body, code = _google_error('calendar', e)
        return jsonify(body), code


@app.route('/api/google/calendar/delete', methods=['POST'])
def google_calendar_delete():
    svc = _google_service('calendar', 'v3')
    if not svc:
        return jsonify({'error': 'Google Calendar is not connected.'}), 401
    d = request.get_json(silent=True) or {}
    event_id = d.get('eventId')
    if not event_id:
        return jsonify({'error': 'eventId is required'}), 400
    try:
        svc.events().delete(calendarId=d.get('calendarId') or 'primary',
                            eventId=event_id, sendUpdates='none').execute()
    except Exception as e:
        # A 410 means it is already gone, which is the outcome we wanted.
        logger.info('Calendar delete: %s', e)
    return jsonify({'ok': True})


@app.route('/api/google/calendar/events', methods=['GET'])
def google_calendar_events():
    """Pull upcoming events so the Calendar view can show meetings beside tasks."""
    svc = _google_service('calendar', 'v3')
    if not svc:
        return jsonify({'error': 'Google Calendar is not connected.'}), 401

    time_min = request.args.get('from') or datetime.utcnow().strftime('%Y-%m-%dT00:00:00Z')
    time_max = request.args.get('to') or (datetime.utcnow() + timedelta(days=60)).strftime('%Y-%m-%dT00:00:00Z')
    cal_id = request.args.get('calendarId') or 'primary'
    try:
        res = svc.events().list(calendarId=cal_id, timeMin=time_min, timeMax=time_max,
                                singleEvents=True, orderBy='startTime', maxResults=250).execute()
        events = [_event_shape(e, cal_id) for e in res.get('items', [])]
        return jsonify({
            'events': events,
            'calendarId': cal_id,
            'timeZone': res.get('timeZone'),
            'syncedAt': datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        body, code = _google_error('calendar', e)
        return jsonify(body), code


def _event_shape(e, cal_id='primary'):
    """
    One event, in the shape the board speaks.

    `updated` and `etag` are the two fields that make two-way editing safe:
    the board sends the etag it last saw back on an update, and Google
    refuses the write if the event moved on in the meantime. That turns a
    silent overwrite into a conflict the user can see.
    """
    return {
        'id': e['id'],
        'calendarId': cal_id,
        'title': e.get('summary', '(no title)'),
        'description': e.get('description', ''),
        'location': e.get('location', ''),
        'start': e['start'].get('date') or e['start'].get('dateTime'),
        'end': e['end'].get('date') or e['end'].get('dateTime'),
        'allDay': 'date' in e['start'],
        'link': e.get('htmlLink'),
        'updated': e.get('updated'),
        'etag': e.get('etag'),
        'status': e.get('status'),
        'colorId': e.get('colorId'),
        'organizer': (e.get('organizer') or {}).get('email'),
        'attendees': [{'email': a.get('email'), 'status': a.get('responseStatus')}
                      for a in (e.get('attendees') or [])],
        # Google refuses writes to an event you only have read access to.
        # Knowing that up front means the board can show it read-only rather
        # than letting someone edit it and fail on save.
        'writable': not e.get('locked') and e.get('status') != 'cancelled',
    }


@app.route('/api/google/calendar/event', methods=['POST'])
def google_calendar_event_write():
    """
    Create or update any calendar event — not only the mirror of a task.

    /calendar/push exists for the task case and takes a task's shape (a due
    date, a priority). This one takes an event's shape: a start, an end, and
    the fields a person editing a calendar expects to be able to change.
    """
    svc = _google_service('calendar', 'v3')
    if not svc:
        return jsonify({'error': 'Google Calendar is not connected.'}), 401

    d = request.get_json(silent=True) or {}
    cal_id = d.get('calendarId') or 'primary'
    tz = d.get('timeZone') or 'UTC'
    all_day = bool(d.get('allDay'))
    start_raw, end_raw = d.get('start'), d.get('end')

    if not start_raw:
        return jsonify({'error': 'An event needs a start.'}), 400

    if all_day:
        start_day = str(start_raw)[:10]
        # All-day events are half-open: without an end of the following day
        # the event does not render at all.
        end_day = str(end_raw or '')[:10]
        if not end_day or end_day <= start_day:
            end_day = (datetime.strptime(start_day, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
        start, end = {'date': start_day}, {'date': end_day}
    else:
        if not end_raw:
            base = _parse_iso(start_raw) or datetime.now(timezone.utc)
            end_raw = (base + timedelta(hours=1)).isoformat()
        start = {'dateTime': start_raw, 'timeZone': tz}
        end = {'dateTime': end_raw, 'timeZone': tz}

    body = {
        'summary': d.get('title') or 'Untitled event',
        'description': d.get('description') or '',
        'location': d.get('location') or '',
        'start': start,
        'end': end,
    }
    if d.get('colorId'):
        body['colorId'] = str(d['colorId'])
    attendees = [{'email': e} for e in (d.get('attendees') or []) if '@' in str(e)]
    if attendees:
        body['attendees'] = attendees

    try:
        event_id = d.get('eventId')
        if event_id:
            # If-Match on the etag the board last saw: Google returns 412 when
            # someone else changed the event since, instead of quietly
            # discarding their edit.
            headers = {'If-Match': d['etag']} if d.get('etag') else None
            req = svc.events().update(calendarId=cal_id, eventId=event_id, body=body,
                                      sendUpdates='none')
            if headers:
                req.headers.update(headers)
            ev = req.execute()
        else:
            ev = svc.events().insert(calendarId=cal_id, body=body, sendUpdates='none').execute()
        return jsonify({'ok': True, 'event': _event_shape(ev, cal_id)})
    except Exception as e:
        if '412' in str(e) or 'conditionNotMet' in str(e):
            return jsonify({
                'error': 'This event was changed in Google Calendar since the board last read it.',
                'fix': 'Refresh the calendar block to pull the newer version, then edit again.',
                'conflict': True,
            }), 409
        body, code = _google_error('calendar', e)
        return jsonify(body), code


# ---------------------------------------------------------------------------
# Google Docs — create a doc from a task or project
# ---------------------------------------------------------------------------

@app.route('/api/google/docs/create', methods=['POST'])
def google_docs_create():
    """
    Create a Google Doc seeded with the task's content and return its URL,
    which the client attaches to the task.
    """
    docs = _google_service('docs', 'v1')
    if not docs:
        return jsonify({'error': 'Google Docs is not connected.'}), 401

    d = request.get_json(silent=True) or {}
    title = d.get('title', 'Untitled')
    content = d.get('content', '')

    try:
        doc = docs.documents().create(body={'title': title}).execute()
        doc_id = doc['documentId']
        if content:
            docs.documents().batchUpdate(documentId=doc_id, body={
                'requests': [{'insertText': {'location': {'index': 1}, 'text': content}}]
            }).execute()
        return jsonify({
            'ok': True, 'documentId': doc_id,
            'url': f'https://docs.google.com/document/d/{doc_id}/edit',
        })
    except Exception as e:
        body, code = _google_error('docs', e)
        return jsonify(body), code


# ---------------------------------------------------------------------------
# Google Drive — browse and search everything the user owns or can see
# ---------------------------------------------------------------------------

# Drive returns a mime type; the UI wants a short kind it can colour and
# filter on. Anything unlisted falls through to 'file'.
DRIVE_KINDS = {
    'application/vnd.google-apps.document': 'doc',
    'application/vnd.google-apps.spreadsheet': 'sheet',
    'application/vnd.google-apps.presentation': 'slides',
    'application/vnd.google-apps.form': 'form',
    'application/vnd.google-apps.drawing': 'drawing',
    'application/vnd.google-apps.folder': 'folder',
    'application/pdf': 'pdf',
}

DRIVE_FIELDS = ('nextPageToken,files(id,name,mimeType,webViewLink,iconLink,'
                'thumbnailLink,modifiedTime,size,starred,shared,owners(displayName,emailAddress),'
                'lastModifyingUser(displayName))')


def _drive_kind(mime):
    if mime in DRIVE_KINDS:
        return DRIVE_KINDS[mime]
    if mime.startswith('image/'):
        return 'image'
    if mime.startswith('video/'):
        return 'video'
    if mime.startswith('audio/'):
        return 'audio'
    return 'file'


def _drive_shape(f):
    owner = (f.get('owners') or [{}])[0]
    return {
        'id': f.get('id'),
        'name': f.get('name'),
        'mimeType': f.get('mimeType'),
        'kind': _drive_kind(f.get('mimeType', '')),
        'link': f.get('webViewLink'),
        'icon': f.get('iconLink'),
        'thumbnail': f.get('thumbnailLink'),
        'modified': f.get('modifiedTime'),
        'size': int(f['size']) if str(f.get('size', '')).isdigit() else None,
        'starred': bool(f.get('starred')),
        'shared': bool(f.get('shared')),
        'owner': owner.get('displayName') or owner.get('emailAddress'),
        'lastEditor': (f.get('lastModifyingUser') or {}).get('displayName'),
    }


def _drive_escape(term):
    """Drive query strings are single-quoted; backslash-escape the quotes."""
    return term.replace('\\', '\\\\').replace("'", "\\'")


@app.route('/api/google/drive/list', methods=['GET'])
def google_drive_list():
    """
    Browse or search Drive.

    Query params
      q       free-text search across name and full text
      filter  all | everything | recent | starred | shared | folder
              | doc | sheet | slides | pdf | image
      folder  a folder id, to list its direct children
      page    a nextPageToken from a previous response

    Two things used to hide files here.

    First, browsing with no folder listed *every* file in the account as one
    flat run, so a folder and a file six levels inside it sat side by side
    and the first page was an arbitrary slice of the whole Drive. Browsing
    now starts at My Drive's root and descends, which is what the folder
    trail in the UI was already built for. `filter=everything` keeps the old
    flat behaviour for when you genuinely want it.

    Second, `sharedWithMe` was being asked for against `corpora=allDrives`.
    Shared-with-me is a property of the *user* corpus — it does not exist in
    the all-drives one — so that chip could only ever come back empty. Each
    query now runs against the corpus that can answer it.
    """
    svc = _google_service('drive', 'v3')
    if not svc:
        return jsonify({'error': 'Google Drive is not connected.'}), 401

    term = (request.args.get('q') or '').strip()
    kind = (request.args.get('filter') or 'all').strip()
    folder = (request.args.get('folder') or '').strip()

    clauses = ['trashed = false']
    if term:
        safe = _drive_escape(term)
        clauses.append(f"(name contains '{safe}' or fullText contains '{safe}')")

    if folder:
        clauses.append(f"'{_drive_escape(folder)}' in parents")
    elif kind == 'all' and not term:
        # Top of the tree. Without this the listing is every file in the
        # account at once, truncated to one page.
        clauses.append("'root' in parents")

    if kind == 'starred':
        clauses.append('starred = true')
    elif kind == 'shared':
        clauses.append('sharedWithMe = true')
    elif kind in ('doc', 'sheet', 'slides', 'folder'):
        mime = next(m for m, k in DRIVE_KINDS.items() if k == kind)
        clauses.append(f"mimeType = '{mime}'")
    elif kind == 'pdf':
        clauses.append("mimeType = 'application/pdf'")
    elif kind == 'image':
        clauses.append("mimeType contains 'image/'")

    # Drive ignores orderBy entirely once the query contains fullText, so
    # asking for one on a search is noise. Folders sort first when browsing
    # so the tree reads as a tree.
    if term:
        order = None
    elif kind == 'recent':
        order = 'viewedByMeTime desc'
    else:
        order = 'folder,modifiedTime desc'

    # sharedWithMe and starred live in the user corpus; everything else can
    # span shared drives too.
    user_corpus = kind in ('shared', 'starred')

    params = dict(
        q=' and '.join(clauses),
        pageSize=max(1, min(int(request.args.get('limit', 100)), 1000)),
        pageToken=request.args.get('page') or None,
        fields=DRIVE_FIELDS,
        supportsAllDrives=True,
    )
    if order:
        params['orderBy'] = order
    if user_corpus:
        params['corpora'] = 'user'
    else:
        params['corpora'] = 'allDrives'
        params['includeItemsFromAllDrives'] = True

    try:
        res = svc.files().list(**params).execute()
        return jsonify({
            'files': [_drive_shape(f) for f in res.get('files', [])],
            'nextPage': res.get('nextPageToken'),
        })
    except Exception as e:
        body, code = _google_error('drive', e)
        return jsonify(body), code


@app.route('/api/google/drive/about', methods=['GET'])
def google_drive_about():
    """Storage usage, for the workspace header."""
    svc = _google_service('drive', 'v3')
    if not svc:
        return jsonify({'error': 'Google Drive is not connected.'}), 401
    try:
        q = svc.about().get(fields='storageQuota,user(displayName,emailAddress,photoLink)').execute()
        quota = q.get('storageQuota', {})
        return jsonify({
            'user': q.get('user', {}),
            'usage': int(quota.get('usage', 0) or 0),
            'limit': int(quota['limit']) if quota.get('limit') else None,
        })
    except Exception as e:
        body, code = _google_error('drive', e)
        return jsonify(body), code


# ---------------------------------------------------------------------------
# Google Docs — list existing documents, and create new ones
# ---------------------------------------------------------------------------

@app.route('/api/google/docs/list', methods=['GET'])
def google_docs_list():
    """
    Every Google Doc the user can open, newest first.

    This is a Drive query, not a Docs one: the Docs API can fetch a document
    by id but has no listing endpoint at all. Asking Docs for a list is why
    "my documents" looked empty even when the API was enabled.
    """
    svc = _google_service('drive', 'v3')
    if not svc:
        return jsonify({'error': 'Google Drive is not connected.'}), 401

    term = (request.args.get('q') or '').strip()
    doc_type = (request.args.get('type') or 'document').strip()
    mime = {
        'document': 'application/vnd.google-apps.document',
        'spreadsheet': 'application/vnd.google-apps.spreadsheet',
        'presentation': 'application/vnd.google-apps.presentation',
    }.get(doc_type, 'application/vnd.google-apps.document')

    clauses = ['trashed = false', f"mimeType = '{mime}'"]
    if term:
        clauses.append(f"name contains '{_drive_escape(term)}'")

    try:
        res = svc.files().list(
            q=' and '.join(clauses), pageSize=60, orderBy='modifiedTime desc',
            fields=DRIVE_FIELDS, corpora='allDrives',
            includeItemsFromAllDrives=True, supportsAllDrives=True,
        ).execute()
        return jsonify({'files': [_drive_shape(f) for f in res.get('files', [])]})
    except Exception as e:
        body, code = _google_error('drive', e)
        return jsonify(body), code


# ---------------------------------------------------------------------------
# Gmail — read the inbox
# ---------------------------------------------------------------------------

def _header(payload, name):
    for hdr in (payload or {}).get('headers', []):
        if hdr.get('name', '').lower() == name.lower():
            return hdr.get('value', '')
    return ''


def _gmail_shape(msg):
    payload = msg.get('payload', {})
    frm = _header(payload, 'From')
    # "Ada Lovelace <ada@example.com>" -> name and address apart.
    name, _, addr = frm.rpartition('<')
    return {
        'id': msg['id'],
        'threadId': msg.get('threadId'),
        'from': (name or addr or frm).strip().strip('"') or frm,
        'fromEmail': addr.rstrip('>').strip() or frm,
        'subject': _header(payload, 'Subject') or '(no subject)',
        'date': _header(payload, 'Date'),
        'snippet': msg.get('snippet', ''),
        'unread': 'UNREAD' in (msg.get('labelIds') or []),
        'starred': 'STARRED' in (msg.get('labelIds') or []),
        'link': f"https://mail.google.com/mail/u/0/#inbox/{msg['id']}",
    }


def _fan_out(fn, items, workers=8):
    """
    Run `fn` over `items` concurrently, preserving input order.

    Several Google APIs only expose "list the ids" plus "fetch one" — Gmail
    messages and label counts both work that way. Done in sequence, a
    twenty-five message inbox is twenty-six round trips one after another,
    which is what made the mailbox take the better part of a minute. These
    calls are IO-bound, so a small thread pool collapses that to roughly one
    round trip. httplib2 connections are not thread-safe to share, but the
    Google client builds a fresh one per thread, so each worker is isolated.
    """
    if not items:
        return []
    results = [None] * len(items)
    with ThreadPoolExecutor(max_workers=min(workers, len(items))) as pool:
        futures = {pool.submit(fn, item): i for i, item in enumerate(items)}
        for future in as_completed(futures):
            i = futures[future]
            try:
                results[i] = future.result()
            except Exception as e:
                logger.warning('Parallel Google call failed: %s', e)
    return [r for r in results if r is not None]


@app.route('/api/google/gmail/list', methods=['GET'])
def google_gmail_list():
    """
    Message headers for a mailbox view.

    Gmail has no "give me the inbox with subjects" call: list() returns bare
    ids, and each id then needs its own get(). Those gets run in parallel.
    """
    svc = _google_service('gmail', 'v1')
    if not svc:
        return jsonify({'error': 'Gmail is not connected.'}), 401

    label = (request.args.get('label') or 'INBOX').upper()
    term = (request.args.get('q') or '').strip()
    limit = min(int(request.args.get('limit', 25)), 50)

    try:
        listing = svc.users().messages().list(
            userId='me',
            labelIds=[label] if label and label != 'ALL' else None,
            q=term or None,
            maxResults=limit,
        ).execute()

        def fetch(stub):
            return _gmail_shape(svc.users().messages().get(
                userId='me', id=stub['id'], format='metadata',
                metadataHeaders=['From', 'To', 'Subject', 'Date'],
            ).execute())

        messages = _fan_out(fetch, listing.get('messages', []))
        return jsonify({'messages': messages,
                        'estimate': listing.get('resultSizeEstimate', len(messages))})
    except Exception as e:
        body, code = _google_error('gmail', e)
        return jsonify(body), code


@app.route('/api/google/gmail/message/<message_id>', methods=['GET'])
def google_gmail_message(message_id):
    """One message, flattened to plain text for the reading pane."""
    svc = _google_service('gmail', 'v1')
    if not svc:
        return jsonify({'error': 'Gmail is not connected.'}), 401

    def walk(part, out):
        """Depth-first over the MIME tree, collecting text/plain bodies."""
        if part.get('mimeType') == 'text/plain' and part.get('body', {}).get('data'):
            out.append(base64.urlsafe_b64decode(
                part['body']['data'].encode()).decode('utf-8', 'replace'))
        for child in part.get('parts', []) or []:
            walk(child, out)

    try:
        msg = svc.users().messages().get(userId='me', id=message_id, format='full').execute()
        payload = msg.get('payload', {})
        chunks = []
        walk(payload, chunks)
        return jsonify({
            'id': msg['id'],
            'subject': _header(payload, 'Subject') or '(no subject)',
            'from': _header(payload, 'From'),
            'to': _header(payload, 'To'),
            'date': _header(payload, 'Date'),
            'body': ('\n'.join(chunks))[:20000] or msg.get('snippet', ''),
            'link': f"https://mail.google.com/mail/u/0/#inbox/{msg['id']}",
        })
    except Exception as e:
        body, code = _google_error('gmail', e)
        return jsonify(body), code


@app.route('/api/google/gmail/labels', methods=['GET'])
def google_gmail_labels():
    """System and user labels, with unread counts, for the mailbox rail."""
    svc = _google_service('gmail', 'v1')
    if not svc:
        return jsonify({'error': 'Gmail is not connected.'}), 401
    # Only these system labels are shown in the rail, and a mailbox can have
    # hundreds of user labels — fetching counts for all of them would be far
    # slower than the panel is worth.
    SHOWN = {'INBOX', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'SPAM', 'TRASH'}

    try:
        res = svc.users().labels().list(userId='me').execute()
        wanted = [lb for lb in res.get('labels', [])
                  if lb['id'] in SHOWN or lb.get('type') != 'system'][:40]

        def detail(lb):
            d = svc.users().labels().get(userId='me', id=lb['id']).execute()
            return {
                'id': lb['id'],
                'name': lb.get('name'),
                'system': lb.get('type') == 'system',
                'unread': d.get('messagesUnread', 0),
                'total': d.get('messagesTotal', 0),
            }

        return jsonify({'labels': _fan_out(detail, wanted)})
    except Exception as e:
        body, code = _google_error('gmail', e)
        return jsonify(body), code


# ---------------------------------------------------------------------------
# Google Tasks
# ---------------------------------------------------------------------------

@app.route('/api/google/tasks/list', methods=['GET'])
def google_tasks_list():
    """Every task list, with its open tasks."""
    svc = _google_service('tasks', 'v1')
    if not svc:
        return jsonify({'error': 'Google Tasks is not connected.'}), 401
    try:
        lists = svc.tasklists().list(maxResults=50).execute().get('items', [])
        show_completed = request.args.get('completed') == '1'

        def _fetch_one(tl):
            items = svc.tasks().list(
                tasklist=tl['id'], maxResults=100,
                showCompleted=show_completed,
                showHidden=False,
            ).execute().get('items', [])
            return {
                'id': tl['id'],
                'title': tl.get('title', 'Tasks'),
                'tasks': [{
                    'id': t['id'],
                    'title': t.get('title', '(untitled)'),
                    'notes': t.get('notes', ''),
                    'due': t.get('due'),
                    'done': t.get('status') == 'completed',
                } for t in items],
            }

        # One task list per Google account is common, but several is not
        # rare — fetching them one after another turned this into an N+1
        # waterfall and made it the slowest tab in the Workspace panel.
        out = _fan_out(_fetch_one, lists)
        return jsonify({'lists': out})
    except Exception as e:
        body, code = _google_error('tasks', e)
        return jsonify(body), code


@app.route('/api/google/tasks/create', methods=['POST'])
def google_tasks_create():
    """Push a project task into Google Tasks."""
    svc = _google_service('tasks', 'v1')
    if not svc:
        return jsonify({'error': 'Google Tasks is not connected.'}), 401

    d = request.get_json(silent=True) or {}
    tasklist = d.get('listId')
    try:
        if not tasklist:
            tasklist = (svc.tasklists().list(maxResults=1).execute()
                        .get('items', [{}])[0].get('id', '@default'))
        body = {'title': d.get('title', 'Task'), 'notes': d.get('notes', '')}
        if d.get('dueDate'):
            # Google Tasks stores an RFC-3339 timestamp but ignores the time.
            body['due'] = f"{d['dueDate']}T00:00:00.000Z"
        created = svc.tasks().insert(tasklist=tasklist, body=body).execute()
        return jsonify({'ok': True, 'id': created['id'], 'listId': tasklist})
    except Exception as e:
        body, code = _google_error('tasks', e)
        return jsonify(body), code


# ---------------------------------------------------------------------------
# Calendar — list the calendars themselves
# ---------------------------------------------------------------------------

@app.route('/api/google/calendar/calendars', methods=['GET'])
def google_calendar_calendars():
    svc = _google_service('calendar', 'v3')
    if not svc:
        return jsonify({'error': 'Google Calendar is not connected.'}), 401
    try:
        res = svc.calendarList().list(maxResults=50).execute()
        return jsonify({'calendars': [{
            'id': c['id'],
            'name': c.get('summary', c['id']),
            'primary': bool(c.get('primary')),
            'color': c.get('backgroundColor'),
            'role': c.get('accessRole'),
        } for c in res.get('items', [])]})
    except Exception as e:
        body, code = _google_error('calendar', e)
        return jsonify(body), code


# ===========================================================================
# GOOGLE SHEETS  — the data behind the live dashboards
# ---------------------------------------------------------------------------
# drive.readonly can find a spreadsheet and tell you its name; it cannot read
# one cell out of it. Values come from sheets.googleapis.com, which needs the
# Sheets API enabled and the spreadsheets scope granted.
#
# A dashboard polls /values on an interval, so these endpoints are written to
# be cheap and to fail loudly rather than return an empty grid that reads as
# "your data is gone".
# ===========================================================================

SHEET_MIME = 'application/vnd.google-apps.spreadsheet'


@app.route('/api/google/sheets/list', methods=['GET'])
def google_sheets_list():
    """Spreadsheets in the user's Drive, most recently touched first."""
    svc = _google_service('drive', 'v3')
    if not svc:
        return jsonify({'error': 'Google Drive is not connected.'}), 401

    q = (request.args.get('q') or '').strip()
    query = f"mimeType='{SHEET_MIME}' and trashed=false"
    if q:
        query += f" and name contains '{_drive_escape(q)}'"

    try:
        res = svc.files().list(
            q=query,
            pageSize=min(int(request.args.get('limit', 40)), 100),
            orderBy='modifiedTime desc',
            fields='files(id,name,modifiedTime,owners(displayName),webViewLink,iconLink)',
            supportsAllDrives=True, includeItemsFromAllDrives=True,
        ).execute()
        return jsonify({'sheets': [{
            'id': f['id'],
            'name': f.get('name', 'Untitled spreadsheet'),
            'modified': f.get('modifiedTime'),
            'owner': (f.get('owners') or [{}])[0].get('displayName'),
            'link': f.get('webViewLink'),
        } for f in res.get('files', [])]})
    except Exception as e:
        body, code = _google_error('drive', e)
        return jsonify(body), code


def _sheet_id_from(value):
    """
    Accept a bare id or any spreadsheet URL.

    People paste the URL — it is what the address bar gives them — and
    demanding the 44-character id out of the middle of it is a needless way
    to make the feature look broken.
    """
    value = (value or '').strip()
    m = re.search(r'/spreadsheets/d/([a-zA-Z0-9-_]+)', value)
    if m:
        return m.group(1)
    return value.split('?')[0].split('#')[0].strip('/')


@app.route('/api/google/sheets/meta', methods=['GET'])
def google_sheets_meta():
    """Tab names and grid sizes, so a dashboard can offer real ranges."""
    sheet_id = _sheet_id_from(request.args.get('id'))
    if not sheet_id:
        return jsonify({'error': 'A spreadsheet id or URL is required.'}), 400

    svc = _google_service('sheets', 'v4')
    if not svc:
        return jsonify({'error': 'Google Sheets is not connected.'}), 401

    try:
        res = svc.spreadsheets().get(
            spreadsheetId=sheet_id,
            fields='properties(title),sheets(properties(sheetId,title,index,gridProperties))',
        ).execute()
        return jsonify({
            'id': sheet_id,
            'title': (res.get('properties') or {}).get('title'),
            'link': f'https://docs.google.com/spreadsheets/d/{sheet_id}/edit',
            'tabs': [{
                'id': s['properties']['sheetId'],
                'title': s['properties']['title'],
                'index': s['properties'].get('index', 0),
                'rows': (s['properties'].get('gridProperties') or {}).get('rowCount', 0),
                'cols': (s['properties'].get('gridProperties') or {}).get('columnCount', 0),
            } for s in res.get('sheets', [])],
        })
    except Exception as e:
        body, code = _google_error('sheets', e)
        return jsonify(body), code


@app.route('/api/google/sheets/values', methods=['GET'])
def google_sheets_values():
    """
    Cell values for one range, as a rectangular grid.

    The API omits trailing empty cells, so a 5-column sheet comes back with
    rows of 5, 3 and 1 entries. Every consumer of this — a table, a chart, a
    KPI tile — assumes a rectangle, so the padding happens once, here.
    """
    sheet_id = _sheet_id_from(request.args.get('id'))
    rng = (request.args.get('range') or '').strip()
    if not sheet_id:
        return jsonify({'error': 'A spreadsheet id or URL is required.'}), 400

    svc = _google_service('sheets', 'v4')
    if not svc:
        return jsonify({'error': 'Google Sheets is not connected.'}), 401

    try:
        req = svc.spreadsheets().values().get(
            spreadsheetId=sheet_id,
            range=rng or 'A1:Z1000',
            valueRenderOption=request.args.get('render', 'UNFORMATTED_VALUE'),
            dateTimeRenderOption='FORMATTED_STRING',
        )
        res = req.execute()
        rows = res.get('values', []) or []
        width = max((len(r) for r in rows), default=0)
        grid = [list(r) + [''] * (width - len(r)) for r in rows]

        return jsonify({
            'id': sheet_id,
            'range': res.get('range', rng),
            'rows': len(grid),
            'cols': width,
            'values': grid,
            'fetchedAt': datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        body, code = _google_error('sheets', e)
        return jsonify(body), code


@app.route('/api/google/sheets/values', methods=['PUT'])
def google_sheets_write():
    """Write a rectangular block back. Used by editable dashboard cells."""
    d = request.get_json(silent=True) or {}
    sheet_id = _sheet_id_from(d.get('id'))
    rng = (d.get('range') or '').strip()
    values = d.get('values')

    if not sheet_id or not rng:
        return jsonify({'error': 'A spreadsheet id and a range are required.'}), 400
    if not isinstance(values, list):
        return jsonify({'error': '`values` must be a list of rows.'}), 400

    svc = _google_service('sheets', 'v4')
    if not svc:
        return jsonify({'error': 'Google Sheets is not connected.'}), 401

    try:
        res = svc.spreadsheets().values().update(
            spreadsheetId=sheet_id, range=rng,
            valueInputOption='USER_ENTERED',
            body={'values': values},
        ).execute()
        return jsonify({'ok': True,
                        'updatedCells': res.get('updatedCells', 0),
                        'range': res.get('updatedRange', rng)})
    except Exception as e:
        body, code = _google_error('sheets', e)
        return jsonify(body), code


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def _check_loopback_port(port):
    """
    Warn if something else already owns 127.0.0.1:<port>.

    Binding to 0.0.0.0 does NOT conflict with a server bound to
    127.0.0.1 on the same port — the OS treats the more specific
    address as the better match — so both start without error and the
    *other* one answers every request to localhost. Nothing fails, no
    port-in-use message appears, and the app simply seems to have lost
    half its features or gone back several versions.

    That is not hypothetical: this is exactly what an unrelated Flask
    project left running on this machine was doing. It costs one socket
    to rule out, and the alternative is unfindable.
    """
    import socket
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(('127.0.0.1', port))
        return True
    except OSError:
        pass
    finally:
        probe.close()

    other = ''
    try:
        import urllib.request
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=2) as r:
            body = r.read(4000).decode('utf-8', 'replace')
        m = re.search(r'<title>(.*?)</title>', body, re.I | re.S)
        if m:
            other = f'\n  It is serving a page titled: "{m.group(1).strip()}"'
    except Exception:
        pass

    logger.error('')
    logger.error('=' * 74)
    logger.error('  ANOTHER SERVER ALREADY OWNS 127.0.0.1:%d%s', port, other)
    logger.error('')
    logger.error('  Refusing to start. This process CAN bind 0.0.0.0:%d without an error,', port)
    logger.error('  but the other one is more specific, so it wins every request to')
    logger.error('  localhost and 127.0.0.1 — the browser would show that app, not this')
    logger.error('  one, with no error anywhere to explain it.')
    logger.error('')
    logger.error('  Find and stop it, then start this server again:')
    logger.error('      netstat -ano | findstr :%d', port)
    logger.error('      taskkill /PID <pid> /F')
    logger.error('')
    logger.error('  To run anyway (they will fight over localhost): set')
    logger.error('  WB_ALLOW_PORT_CONFLICT=1')
    logger.error('=' * 74)
    logger.error('')
    return False


if __name__ == '__main__':
    logger.info('Starting WhiteBoard Pro server …')

    # Only in the reloader's parent, or this prints twice on every restart.
    if os.environ.get('WERKZEUG_RUN_MAIN') != 'true':
        if not _check_loopback_port(5000) and \
                os.environ.get('WB_ALLOW_PORT_CONFLICT', '').strip().lower() not in ('1', 'true', 'yes'):
            raise SystemExit(1)

    # Report the route mail will actually take. Checking only SMTP said "not
    # configured" while the connected Google account was perfectly able to
    # send, which is exactly the confusion the Gmail route was added to end.
    try:
        _route, _sender = _email_route()
    except Exception:
        _route, _sender = None, None

    if _route:
        _email_note = f'{"Gmail API" if _route == "gmail" else "SMTP"} as {_sender or "the connected account"}'
    else:
        _email_note = 'not configured (notifications will be logged)'

    logger.info('  Email:  %s', _email_note)
    logger.info('  Open:   http://%s:5000  (every loopback alias redirects here, '
                'so there is only one origin)', CANONICAL_HOST or 'localhost')
    logger.info('  Google: %s', 'configured' if _google_configured else 'dormant (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)')
    logger.info('  Keep:   %s', 'API enabled (Workspace accounts only)' if _keep_api_enabled
                else 'App Password route (the only one personal accounts have)')
    # Only reached via `python app.py` directly — gunicorn (the Docker
    # image's entrypoint) imports `app` as a WSGI callable and never runs
    # this block, so this debug flag has no effect in that deployment.
    _flask_debug = os.environ.get('FLASK_DEBUG', '1').strip().lower() in ('1', 'true', 'yes')

    # WB_HTTPS=1 serves over a throwaway self-signed certificate.
    #
    # Only one thing needs this, but it needs it absolutely: browsers refuse
    # microphone access on an insecure origin unless it is localhost, so a
    # phone joining the voice channel over the LAN address gets no mic at
    # all over plain http. The certificate is untrusted, so the phone will
    # show a warning to click through once — fine for testing on your own
    # network, not a substitute for real HTTPS in front of a deployment.
    _https = os.environ.get('WB_HTTPS', '').strip().lower() in ('1', 'true', 'yes')
    if _https:
        logger.info('  HTTPS:  on (self-signed — expect a one-time browser warning)')
        app.run(debug=_flask_debug, host='0.0.0.0', port=5000, ssl_context='adhoc')
    else:
        app.run(debug=_flask_debug, host='0.0.0.0', port=5000)
