# Deploying to PythonAnywhere (free, no card)

A free "Beginner" account gives one always-on web app at
`https://USERNAME.pythonanywhere.com`, a real persistent disk and no payment
method. That combination is why this is the deployment target — boards saved
on the server actually survive a restart here, which they do not on the free
tier of most container hosts.

The deployment starts with **no boards at all**: `data/` is excluded by
`.gitignore`, so nothing from a development machine travels with the code.

---

## 1. Account

Sign up at <https://www.pythonanywhere.com/registration/register/beginner/>.
No card is requested.

## 2. Get the code onto the server

Open **Consoles -> Bash** and clone the repository:

```bash
git clone https://github.com/unisamakachamuu-ship-it/whiteboard-pro.git
cd whiteboard-pro
```

A private repository will ask for credentials. GitHub no longer accepts an
account password here, so either make the repository public or generate a
personal access token (Settings -> Developer settings -> Tokens) and paste
that as the password.

## 3. Virtualenv and dependencies

```bash
mkvirtualenv --python=/usr/bin/python3.10 whiteboard
pip install -r requirements-pythonanywhere.txt
```

Use `requirements-pythonanywhere.txt`, not `requirements.txt` — the full file
pulls in google-api-python-client and firebase-admin, roughly 150 MB that a
free account's 512 MB disk cannot spare. The file itself explains what is
left out and why nothing user-facing breaks.

`mkvirtualenv` leaves the environment active and prints its path, which is
`/home/USERNAME/.virtualenvs/whiteboard`. Step 5 needs that path.

## 4. Create the web app

**Web** tab -> **Add a new web app**:

| Prompt | Choose |
| --- | --- |
| Domain | the free `USERNAME.pythonanywhere.com` |
| Framework | **Manual configuration** — *not* the Flask option |
| Python version | **3.10** |

Manual configuration matters: the Flask preset overwrites the WSGI file with
a stub app, and the next step would be undone.

## 5. Point it at the app

Still on the **Web** tab:

**WSGI configuration file** — click the link and replace everything in the
file with the contents of `pythonanywhere_wsgi.py` from this repository, then
change `USERNAME` on the `PROJECT_DIR` line to your own username.

**Virtualenv** — enter:

```
/home/USERNAME/.virtualenvs/whiteboard
```

**Static files** — add one mapping, so the 40-odd CSS and JS files are served
directly by the web server instead of going through Python on every request:

| URL | Directory |
| --- | --- |
| `/static/` | `/home/USERNAME/whiteboard-pro/static/` |

Then press the green **Reload** button.

## 6. Open it

```
https://USERNAME.pythonanywhere.com
```

An empty whiteboard, on a permanent address, shareable with anyone.

---

## Firebase and Google, once the URL exists

The address is fixed, so OAuth can finally be configured against it — this is
what the temporary tunnel URL could never support.

**Firebase console** (project `project-board-1ee28`) ->
Authentication -> Settings -> **Authorized domains** -> add:

```
USERNAME.pythonanywhere.com
```

Without this, Google sign-in fails with `auth/unauthorized-domain`, and since
signed-out boards are stored per-browser rather than per-account, every
visitor would see a different whiteboard.

The server-side Google Workspace integrations (Calendar, Gmail, Docs, Drive,
Tasks, Sheets) stay dormant on a free account: their libraries are not in the
slim install, and a free account's outbound allowlist would block several of
those calls regardless. Board sync is unaffected — it runs in the visitor's
browser and talks to Firestore directly.

---

## Before sharing the link

`/api/boards` and `/api/board/<id>` have no authentication. Anyone who opens
the address can list, read, edit and delete every board stored on the server,
and `USERNAME.pythonanywhere.com` is guessable.

Among friends that may be exactly what is wanted — one shared space with
nothing to log into. It is worth knowing rather than discovering. Signing in
with Google moves boards into Firestore, where `firestore.rules` scopes them
per account; the unauthenticated JSON API is the server-side copy.

---

## Keeping it alive

A free web app is disabled after three months. The **Web** tab shows a
"Run until 3 months from today" button that resets the clock — pressing it
occasionally is the entire maintenance burden.
