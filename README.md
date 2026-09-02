---
title: WhiteBoard Pro
emoji: 🎨
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 5000
pinned: false
---

<!-- The block above is Hugging Face Spaces configuration. It must stay at the
     very top of this file or the Space will not build. `app_port` matches the
     port gunicorn binds in the Dockerfile. GitHub renders it as a table and
     otherwise ignores it. -->

# 🎨 WhiteBoard Pro — All-in-One Collaborative Whiteboard

An infinite, Miro-class whiteboard built with **vanilla HTML/CSS/JS** and a **Python Flask** backend.
Sticky notes, shapes, freehand ink, flowcharts, mind maps, charts, tables, algorithm blocks — plus a
command palette, fourteen colour themes, shape recognition, multi-tab live collaboration and version history.

No build step. No framework. `python app.py` and you are drawing.

---

## ✨ What it does

### Canvas & objects
| | |
|---|---|
| **Infinite canvas** | Pan, zoom (0.05×–8×), fit-to-content, minimap, five canvas patterns |
| **15 object types** | Sticky note · text · shape (17 kinds) · image · frame · connector · flowchart node (10 kinds) · mind-map topic · chart (7 kinds) · algorithm block · table · checklist · code block · comment · embed |
| **Freehand ink** | Pen and highlighter on a viewport-sized bitmap with camera-space culling — thousands of strokes stay at 60 fps |
| **Connectors** | Elbow / curved / straight routing, port-aware, arrowheads on either end, labels, attach to *any* object |
| **Mind maps** | Tidy-tree layout that balances left/right around the root, self-sizing nodes, collapsible branches |
| **Charts** | Bar, horizontal bar, line, area, pie, donut, scatter — with a real data editor and CSV paste |

### Editing
| | |
|---|---|
| **Selection** | Rubber-band on the canvas, shift to add, click-through frames, group / ungroup |
| **Transform** | 8 resize handles, rotate with 15° snapping, alignment guides, grid snap, alt-drag to duplicate |
| **Arrange** | Align, distribute, **tidy up into a grid**, **pack**, match size, layer ordering |
| **Auto-layout** | Layered (Sugiyama-style) layout for anything wired with connectors — one keystroke turns a mess into a flow |
| **Undo / redo** | 80-step history; live drags and slider scrubs collapse into exactly one entry |

### 🆕 Power features
| | |
|---|---|
| **Live code cells** | Run **real Python** (Pyodide) or JavaScript on the canvas. State carries between cells, DataFrames render as tables, matplotlib figures as images, `%pip install` works, and output is saved with the board |
| **Logic circuits** | Gates that actually evaluate — AND/OR/NOT/XOR/NAND/NOR/XNOR, live wires, feedback loops that settle into a real SR latch, oscillation detection, and a generated truth table |
| **Sheets dashboards** | Point a panel at a Google Sheet and it becomes KPI tiles, charts, gauges and sortable tables that re-read it on a timer |
| **⌘K universal search** | Fuzzy search across 110+ actions, tools, templates, every named object on the board, plus your projects, tasks, and cached Keep notes/calendar events |
| **Smart shapes** | Draw a rough rectangle, ellipse, triangle or line with the pen and it snaps to the real object |
| **14 colour themes** | **iOS Light · iOS Dark** (the default: Apple's system palette, SF type, continuous corners, translucent chrome) · Daylight · Graphite · Midnight · Dracula · Nord · Forest · Cobalt · Paper · Solarized · Ocean · Rosé · High contrast — each with its own sticky-note palette |
| **Live collaboration** | Real-time sync with other signed-in people over Firestore — live cursors, follow-their-view, and edits in both directions. Share a board (top bar, next to Live) to give someone access; falls back to same-machine `BroadcastChannel` tabs when not signed in |
| **Version history** | Named snapshots plus a five-minute auto-save, all restorable |
| **Workshop mode** | Dot voting with live counts, emoji reactions, sort-by-votes, and a facilitation timer |
| **Convert anything** | Turn a selection into a checklist, table, mind map, flowchart or sticky grid — or split one note into many |
| **Attachments** | Hang a Google Doc, a Drive file, an uploaded file or a link off *any* object. Browse Drive without leaving the canvas |
| **Areas & owners** | Assign a frame to teammates — it marks out the part of the board they own, and turns into real tracked tasks in one step |
| **Change type** | Retype an object after the fact — sticky ⇄ shape ⇄ flowchart node ⇄ text ⇄ comment — keeping its connectors, group and z-order |
| **Outline import** | Paste an indented outline or Markdown bullets → a full mind map |
| **Insights** | Board outline (click to fly to any object) and a statistics panel |
| **Quick bar** | A contextual toolbar that follows the selection: colour, bold, size, duplicate, react, lock, delete |
| **Presentation** | Frames become slides, with a thumbnail sorter and a laser pointer |
| **Focus mode** | `F11` hides all chrome for a distraction-free canvas |

### Import / export
JSON (round-trips), **PNG** (full board, transparent, or selection only), **SVG**, **Markdown**
(frames → headings, mind maps → nested lists, tables → Markdown tables), **CSV** (every table, chart
and checklist), print/PDF, clipboard image, and **Google Keep** note import.

---

## 🗂 Projects — the work-management side

**Projects is the front door.** The app opens here, not on a bare canvas, because
a whiteboard only means something inside a project. Press **Back to canvas** to
leave, **Projects** in the top bar (or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>)
to come back. To land on the last board instead, set `landing: 'canvas'` in
settings.

A **task** here is a real, first-class record — not a checkbox. It carries
multiple assignees, a status from the project's own pipeline, a priority,
start and due dates, an estimate and logged time, subtasks, a checklist,
dependencies, tags, comments with @mentions, attachments, custom fields, and
links to objects on the whiteboard.

### Five views over the same tasks

| View | What it is for |
|---|---|
| **Board** | Kanban. Drag between columns to change status — or group by assignee, priority, list or sprint and drag to change *that* instead. WIP limits per column. |
| **List** | A dense editable table. Click any cell to change it, shift-click to select a run, then bulk-assign / re-date / re-prioritise. Subtasks nest inline. |
| **Calendar** | A month grid of everything due. Drag a task to a different day to reschedule it. |
| **Timeline** | A Gantt chart. Drag the bar to move a task, drag an edge to resize it, with arrows drawn between blocked tasks. |
| **Workload** | Who is over capacity, per person per day, with one button to spread unassigned work across the team by current load. |

Filters, grouping and sorting are shared: set a filter on List and it is still
set when you switch to Calendar. <kbd>1</kbd>–<kbd>5</kbd> switch views,
<kbd>N</kbd> makes a task, <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes anything.

### Whiteboards belong to projects

A project can hold any number of whiteboards, reached from the **Boards** tab in
its header or from its context menu. Each one is a separate canvas that reopens
as itself, and the board's own header shows which project it belongs to — click
that chip to go back.

Boards are stored per board **and per account**:

```
wbpro.board.v3::<account>::<boardId>    one board's contents
wbpro.lastboard.v3::<account>           which board to reopen
```

Previously a single key held one board, so every save overwrote it, every reload
restored it, and two people sharing a browser profile shared a canvas — which is
why every project appeared to open the same whiteboard. Signing in or out now
moves the canvas with the account; nothing is deleted in either direction, and
the one board from the old layout is carried across on first run.

### Roles

`owner` · `admin` · `member` · `guest` · `viewer`. Enforced in the UI **and**
in `firestore.rules`, which is the real boundary. A project always keeps at
least one owner.

Two things used to lock people out of their own projects, both resolving every
permission check to `viewer`:

- **A project created while signed out had no members at all.** The owner
  record was only written when there was a signed-in user to write it from, so
  the creator was not on their own project. A project with nobody on it has no
  access boundary to enforce, so it now resolves to `owner` — and new projects
  get a real owner record whether or not you are signed in.
- **Roles saved by older builds were display strings** — `"Owner"`, `"Admin"`,
  `"Editor"` — which are not the ids in `ROLES`, so they fell through to
  `viewer`. Roles are normalised on read, with `Editor` mapping to `member`.

That is why *Invite teammates* was missing and *Delete project* was greyed
out. Neither change loosens Firestore: a signed-in user who is not a member of
a Firestore-backed project is still `viewer`, and `firestore.rules` is
unchanged.

### Google Workspace, inside the app

A sixth destination in the sidebar. Not links out — your actual data:

| Panel | What it shows |
|---|---|
| **Overview** | Recent Drive files, your documents, your inbox, the next two weeks, open Google Tasks. Five cards, loaded in parallel, each resolving on its own. |
| **Drive** | Browse and full-text search everything you own or can see, with folder navigation, breadcrumbs, type filters, starred and shared-with-me |
| **Docs** | Every Doc, Sheet and Slides deck, searchable; create a new Doc without leaving |
| **Mail** | Label rail with unread counts, message list with Gmail search syntax, and a reading pane |
| **Calendar** | Your agenda grouped by day, with your calendar list |
| **Tasks** | Every Google Tasks list and its open tasks |

And it joins up with the projects: attach a Drive file to a task, turn an email
into a task with the thread linked, or drop a file link onto the whiteboard.

### Files on the whiteboard

Any object can carry attachments — a Google Doc, a Drive file, a file from
your machine, or a plain link. Select it and use **Attachments** in the
properties panel, or click the paperclip badge on the object itself.

| Source | What happens |
|---|---|
| **Google Drive / Docs** | browse and search Drive in a picker on the canvas — same endpoint as the Workspace screen, so folders, search and filters behave identically |
| **Upload a file** | stored under `static/uploads` and served back; 50 MB, allow-listed extensions |
| **Paste a link** | anything with an address — Figma, a ticket, a wiki page |

Attachments live on the element as `el.attachments`, so they travel through
the `Store` like everything else: undo/redo, autosave, version history, JSON
export and realtime sync all cover them without a line of extra code.

The **Attach to the whiteboard** button in the Workspace screen attaches to
the selected object, or makes a note to hang from if nothing is selected. It
used to drop a sticky note with the URL typed into its text — a note *about* a
file, which you could not open and which broke as soon as anyone edited it.

### Areas & owners

A frame marks out a region of the board. Assign it to teammates and it becomes
an **area of responsibility** — "checkout flow", "onboarding copy", "the API":

- the frame shows their avatars in its corner
- **All areas on this board** lists every area with its owner, and flies to it
- **Create tasks from this area** turns every object inside into a real
  tracked task in the project, assigned to the area's owners and linked back
  to the object it came from

Membership comes from the project the board belongs to, so these are the same
people as on the project's tasks — not a second roster that drifts out of step.
What counts as "inside" is decided by an object's centre, so an object nudged
half over an edge still belongs to exactly one area.

### Project templates

Ten templates that create actual tracked work — a status pipeline, lists,
custom fields, and a dated task tree with dependencies and subtasks:

Software sprint · Product launch · Marketing campaign · Client onboarding ·
Website redesign · Event planning · Content calendar · Bug triage & support ·
Hiring pipeline · Research study

These are distinct from the 42 **canvas** templates below, which draw shapes.
Each project template names a canvas template it pairs with, so a sprint can
seed both its tasks and its planning board.

---

## 🚀 Quick start

```bash
pip install -r requirements.txt
python app.py
```

Open **http://localhost:5000**.

Press <kbd>Ctrl</kbd>+<kbd>K</kbd> for the canvas command palette, or
**Projects** for the work-management workspace. Everything works signed out on
one machine; sign in with Google to sync and collaborate.

### There is only one URL

`http://localhost:5000` and `http://127.0.0.1:5000` reach the same server but
are **different origins** to the browser, and nearly everything that matters
here is scoped to an origin: `localStorage` (boards, projects, settings,
themes), cookies, the Google OAuth redirect, the popup's `postMessage`, and
Firebase's authorised-domain list — which contains `localhost` and *not*
`127.0.0.1`.

That is why the same app appeared to have different features depending on
which address you typed, and why the Google button on the whiteboard failed
with an OAuth error on one of them.

The server now **redirects every loopback alias to one canonical host**, so
the two addresses are the same app with the same data. Set `CANONICAL_HOST`
in `.env` to change it, or to an empty value to switch the behaviour off. A
LAN address is deliberately never redirected — a phone on the same Wi-Fi must
not be sent to its own localhost.

### If features "disappear", check nothing else owns the port

Binding `0.0.0.0:5000` does **not** conflict with another process bound to
`127.0.0.1:5000`. Both start with no error, and the more specific one wins
every request to localhost — so the browser shows *that* app instead of this
one, silently. This has actually happened here: an unrelated Flask project
left running by an agent console was answering on `127.0.0.1:5000`.

The server now refuses to start when that is the case and prints what to do:

```powershell
netstat -ano | findstr :5000
taskkill /PID <pid> /F
```

Set `WB_ALLOW_PORT_CONFLICT=1` to start anyway.

### Deploying with Docker

```bash
cp .env.example .env      # fill in whatever integrations you want; all optional
docker compose up --build
```

Open **http://localhost:5000**. `data/` (boards, OAuth tokens, the session
secret) and `static/uploads/` persist in named Docker volumes across
rebuilds/restarts — don't delete those volumes unless you mean to lose that
data. The image runs under `gunicorn`, not Flask's dev server, so
`FLASK_DEBUG` has no effect on it.

Without Docker, `gunicorn app:app` works the same way directly:

```bash
pip install -r requirements.txt
gunicorn --bind 0.0.0.0:5000 --workers 4 app:app
```

Set `CORS_ORIGINS` (comma-separated) in `.env` to restrict cross-origin
requests to specific domains — unset allows any origin, which is fine for a
single self-hosted instance behind its own domain.

---

## 🔄 Two-way sync — Keep notes and Calendar events

Import used to be a snapshot: notes landed on the canvas and the two copies
drifted apart from that second on. These make the board a live view instead.

### Google Keep — live, both ways

**Keep button → switch on "Live two-way sync".** Off by default, per browser,
because it writes to your real Keep account and that has to be a decision.

- The **first line of a sticky is the note's title**, the rest is the body.
  That is already how the importer lays a note out, so it round-trips with
  nothing new to learn.
- Edit a sticky → written to Keep (debounced, so typing is one write).
  Edit on your phone → the sticky updates on the next poll (45s).
- **Send board selection → Keep** creates Keep notes from sticky notes that
  aren't linked yet. Deliberately explicit — a board has hundreds of stickies
  and almost none belong in your Keep.
- A note deleted in Keep leaves its sticky on the board, **marked "not in
  Keep"**. Nothing on your board is ever deleted by a sync.

**Conflicts are refused, not resolved.** Each note carries Keep's `updated`
stamp; the board remembers the stamp and a hash of the text both sides last
agreed on. If both changed, neither is overwritten — you get a side-by-side
view and choose *Keep this, overwrite Keep* or *Use Keep's version*. A sync
that quietly picks a winner is one that eventually eats something you wrote
and you find out weeks later.

### Google Calendar — live, editable

The **calendar block** (left toolbar) is a real calendar, not a feed.

- **Agenda** view for what's next, **Week** view for where the gaps are.
- Create, retitle, move and delete events — all written straight to Google
  Calendar. Click empty space in a week column to add an event on that day.
- Pick any calendar you have access to, and it re-reads on a timer.
- Every event carries its **etag**, sent back as `If-Match` on save. If the
  event changed in Google since the board read it, Google refuses the write
  and the block says so instead of silently discarding one of the two edits.

---

## 🧪 Live blocks — code, circuits and dashboards

Three board objects that compute rather than illustrate. All three are on the
left toolbar, below the chart and table tools.

### Live code cell — Python & JavaScript

A notebook cell as a board object. Write code, press
<kbd>Ctrl</kbd>+<kbd>Enter</kbd>, see real output next to the diagram that
explains it.

- **Real CPython** through Pyodide, downloaded from a CDN the first time a
  Python cell runs (about 10 MB, once per session — the cell reports its
  progress rather than appearing to hang). Needs internet on that first run.
- `import pandas` / `numpy` / `matplotlib` just works — packages Pyodide ships
  are fetched automatically. `%pip install <package>` installs anything else
  through micropip.
- A DataFrame renders as a **table** (via `_repr_html_`), and matplotlib
  figures render as **images**.
- **State carries between cells**, in reading order — top to bottom, then left
  to right. "Run every cell on this board" in the ⋮ menu uses that same order.
- Output is saved with the board (capped, so a runaway loop cannot bloat it),
  so a board is readable without re-running anything.
- JavaScript cells get `console`, `display(x)`, top-level `await`, and a
  read-only `board` helper: `board.tables()`, `board.byType('sticky-note')`,
  `board.note('result')`. Assign without `let`/`const` to persist a variable
  across cells.

Code runs in your own browser, on your own machine — the same trust boundary
as the developer console. Nothing is sent to the server to execute.

### Logic circuit

Gates that actually evaluate. Add inputs, gates and outputs from the palette,
click an output pin then an input pin to wire them, and click a switch to flip
it — every wire and lamp downstream updates immediately.

- AND, OR, NOT, XOR, NAND, NOR, XNOR, drawn as the standard IEEE shapes.
- **Feedback is supported**: cross-coupled NORs settle into a working SR
  latch. A loop that never settles is reported as *oscillating* rather than
  showing whichever value it stopped on.
- **Truth table** for the whole circuit, generated from the circuit itself.
- Opens as a half adder, so it explains itself on arrival.

### Live Google Sheets dashboard

Point a panel at a spreadsheet and it becomes KPI tiles, charts and tables
that re-read the sheet on a timer.

- Paste a spreadsheet link or browse your Drive; pick a range and a refresh
  interval (15s to 15min, or manual).
- **KPI tiles** with a change indicator, **line / bar / area** charts,
  **donuts**, **gauges** and a sortable **data table** — drawn inline, so no
  chart library to load and everything follows the board's theme.
- Columns are typed from the data, so `1,240`, `$1,240.50`, `(320)`, `12%` and
  `1.2k` all count as numbers.
- One filter row, CSV export, and a "build me a dashboard" button that lays
  out a sensible starting set from the columns it found.
- The last read is cached with the board, so it opens showing numbers rather
  than a spinner.

**Two things to enable once**, both surfaced in the app when missing:

1. Enable the **Google Sheets API** in your Cloud project —
   <https://console.cloud.google.com/apis/library/sheets.googleapis.com>
2. **Reconnect Google** and accept the new `spreadsheets` permission. Drive
   can find a spreadsheet but cannot read a single cell out of it; that needs
   the Sheets API and its own scope.

---

## ☁️ Multi-user setup (Firebase)

Signed out, projects live in `data/pm/` and `localStorage` — one device, no
sharing. Signing in with Google switches the workspace to Firestore and offers
to upload anything created locally first.

**Publish the security rules before inviting anyone.** A Firebase project
starts either world-writable (test mode, which expires) or fully locked; a
shared workspace needs neither.

1. [Firebase console](https://console.firebase.google.com) → your project
2. **Firestore Database** → create it if you have not
3. **Rules** tab → paste `firestore.rules` from this repo → **Publish**
4. **Authentication** → **Sign-in method** → enable **Google**
5. **Authentication** → **Settings** → **Authorised domains** → add your
   deployed domain (`localhost` is allowed by default)

The rules grant access via two arrays on each project document: `memberUids`
for people who have signed in, and `memberEmails` for people invited before
they ever did. That second one is what makes an invite work — the invitee can
read the project the moment they sign in with that address, and their uid is
written in automatically.

> Your Firebase web config in `static/js/firebase-sync.js` is *meant* to be
> public — it identifies the project, it does not authorise anything. The
> rules are what protect your data. Publish them.

Whiteboard **boards** use a simpler, separate model: `ownerId` plus
`sharedWith`/`sharedEmails` on the board document. Click **Share this board**
(top bar) to add someone by email — they get an invite email and, once
shared, can both read and live-edit the board, not just view it. This is
what makes **Live collaboration** (above) actually reach another person
instead of only other tabs on your own machine.

---

## 📧 Email automation

Assignment, @mention and completion notifications, plus invitations.

There are two ways mail goes out, tried in this order:

| Route | Needs | Sends as |
|---|---|---|
| **Gmail API** | nothing — the `gmail.send` scope is part of connecting Google | your connected Google account |
| **SMTP** | a Gmail App Password in `.env` | `SMTP_USER` |

**If you have connected Google, email already works.** The Gmail route was
added because the SMTP one needs an App Password, App Passwords require
2-Step Verification, and Google keeps narrowing where they are available — so
"email is not configured" was the normal state of this app even for someone
whose Google account was fully connected. The token can already send mail, so
it does.

`GET /api/pm/email/status` reports which route is live:

```json
{ "configured": true, "route": "gmail", "gmail": { "ready": true, "from": "you@gmail.com" } }
```

SMTP remains as a fallback for a deployment with no Google connection. Gmail
needs an **App Password**, not your account password
([Google Account → Security → App Passwords](https://myaccount.google.com/apppasswords)):

```ini
SMTP_USER=you@gmail.com
SMTP_PASSWORD=xxxxxxxxxxxxxxxx    # 16-character app password
SMTP_FROM_NAME=Your Team
```

If neither route is available, every send is logged to the console and the UI
says so rather than pretending it worked.

Which emails go out is per project — **Projects → project menu → Settings →
Email automation**.

### "I added a member and no email arrived"

Usually it *did* arrive. `/api/pm/invite` used to report its result from the
SMTP setting alone, so with SMTP blank — the normal setup when Google is
connected — it answered `"mode": "simulated"` and the UI said *"Email is not
configured yet"* while the Gmail API was sending the invitation perfectly. The
toast was wrong, not the mail.

Now:

- Small batches are sent **before** the response, so the toast reports what
  actually happened, per address, including the sending account.
- The **People** panel states which route invitations take, above the invite
  box, and offers **Send a test** — one real message to the connected
  account's own address, with the result shown.
- `GET /api/pm/email/status` also returns the last few sends.

If it genuinely was not sent, check the recipient's spam folder first: mail
from a personal Gmail account to an address that has never corresponded with
it is the usual reason an invitation is not seen.

---

## 🔗 Google Workspace (Drive · Docs · Gmail · Calendar · Tasks)

Open **Google Workspace** in the project sidebar. It shows your Drive, your
documents, your inbox, your agenda and your task lists, and lets you attach a
Drive file to a task, turn an email into a task, or attach a file to an object
on the whiteboard.

### One account, not two

The app used to have two unrelated Google logins that knew nothing about each
other:

| | What it is | What it gives you |
|---|---|---|
| The top-bar **Google Sign in** | Firebase Authentication | identity — cloud sync, sharing, project membership |
| **Connect Google account** in Workspace | server-side OAuth 2.0 | data — Drive, Docs, Gmail, Calendar, Tasks |

You could be fully connected to Workspace and still see "Google Sign in" in
the top bar, and clicking it opened a second consent screen for a different
product. When a popup blocker ate that window it failed with no explanation.

They are now one account. The top-bar button connects whichever half is
missing, the avatar menu shows the live state of both, and the cloud chip
reports the **weaker** of the two — so "connected" always means both:

| Chip | Meaning |
|---|---|
| ☁️ cloud-check | both halves connected, all scopes granted |
| ⚠️ warning | one half only, scopes missing, or the two halves are different Google accounts |
| ☁️ cloud-slash | not connected |

Sign-in failures now name themselves and link to the console page that fixes
them — an unauthorised domain, the Google provider being switched off in
Firebase, a blocked popup (which retries as a full-page redirect). If the
Firebase half fails, the Workspace half is unaffected and the app says so,
because Drive and Docs keep working without it.

### Setup

1. [console.cloud.google.com](https://console.cloud.google.com) → create or
   pick a project
2. **APIs & Services → Library** → enable **all five**: Google Drive API,
   Google Docs API, Gmail API, Google Calendar API, Google Tasks API
3. **APIs & Services → OAuth consent screen** → *External* → add yourself and
   your teammates under **Test users**
4. **Credentials → Create credentials → OAuth client ID → Web application**
   Authorised redirect URI: `http://localhost:5000/api/google/callback`
5. Put the credentials in `.env` (not the shell — a `$env:` variable dies with
   the window), then restart:

```ini
GOOGLE_CLIENT_ID=….apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
GOOGLE_REDIRECT_URI=http://localhost:5000/api/google/callback
```

6. Click **Connect Google account** and accept **every** permission. Skipping
   one leaves exactly that panel empty.

### Scopes, and why the old ones showed nothing

Two of the scopes this app originally asked for do far less than their names
suggest, which is why an account could connect successfully and still show an
empty Drive and no mail at all:

| Scope | What it actually grants |
| --- | --- |
| `drive.file` | **Only files this app itself created.** A fresh client sees an empty Drive forever. |
| `gmail.send` | **Write-only.** It cannot list, read, or even count a message. |

The set is now:

| Product | Scopes | Sensitivity |
| --- | --- | --- |
| Drive | `drive.readonly` + `drive.file` | restricted + sensitive |
| Docs | `documents` | sensitive |
| Gmail | `gmail.readonly` + `gmail.send` | restricted |
| Calendar | `calendar` | sensitive |
| Tasks | `tasks` | sensitive |

`drive.file` is kept alongside `drive.readonly` deliberately: readonly cannot
write, and `drive.file` is what lets the app save a board back to Drive without
asking for blanket write access to everything you own.

**Restricted scopes need either Google app verification or your account listed
as a Test user.** For a self-hosted workspace the Test-user route is the
intended path — no verification, no review, up to 100 accounts.

> While the consent screen is in *Testing*, Google expires refresh tokens after
> 7 days. Publish the app (still unverified) to stop that.

### Files and folders that were not showing

Three things hid Drive content, none of them a permissions problem:

| Cause | Effect | Now |
|---|---|---|
| Browsing with no folder listed **every file in the account as one flat run** | folders and files from six levels down sat side by side, truncated to one page — an arbitrary slice of your Drive | browsing starts at My Drive's root and descends, which is what the folder trail was already built for. `filter=everything` keeps the flat view |
| **Shared with me** was queried against `corpora=allDrives` | shared-with-me is a property of the *user* corpus and does not exist in the all-drives one, so that chip could only ever come back empty | each query runs against the corpus that can answer it — this alone brought back 75 items on the test account |
| The client **never asked for page two** | one page and no way to get more | a **Load more** button, in the Workspace screen and the canvas file picker |

The page size also went from 60 to 100.

### Already connected but panels are empty?

The sidebar chip will read **Google · reconnect** and the Workspace screen
shows a banner. A token minted before the scopes were widened still
authenticates perfectly — it just cannot read anything. Click **Reconnect** and
accept all permissions. Each panel also names its own failure and links
straight to the console page that fixes it, so "API not enabled" and "scope not
granted" are never a blank list again.

> `data/pm/tokens/` holds live OAuth refresh tokens. Keep it out of version
> control.

---

## ⌨️ Keyboard shortcuts

### Tools
`V` select · `H` pan · `N` sticky note · `T` text · `R` shape · `C` connector · `P` pen ·
`K` highlighter · `E` eraser · `F` flowchart · `M` mind map · `A` algorithm · `G` chart ·
`I` image · `L` laser

### Canvas
| Shortcut | Action |
|---|---|
| Drag empty canvas | Rubber-band select |
| `Space` + drag, middle-drag, `Ctrl` + drag | Pan |
| Wheel / `Shift` + wheel | Scroll / scroll sideways |
| `Ctrl` + wheel, pinch | Zoom |
| `Ctrl` + `0` / `1` / `2` | 100% / fit / fit selection |
| `F11` | Focus mode |

### Editing
| Shortcut | Action |
|---|---|
| `Shift` / `Ctrl` + click | Add or remove from selection — works on connections too |
| Double-click, `Enter` | Edit text |
| `Tab` / `Enter` on a mind-map node | Add child / sibling |
| `Alt` + drag | Duplicate while dragging |
| `Ctrl` held during a drag | Suspend snapping |
| `Shift` + drag / resize / rotate | Lock axis / keep ratio / snap 15° |
| Arrows, `Shift` + arrows | Nudge 1px / 10px |
| `[` `]` | Send backward / bring forward |

### Power tools
| Shortcut | Action |
|---|---|
| `Ctrl` + `K` | Universal search — commands, board objects, tasks, projects, Keep, calendar |
| `Ctrl` + `Shift` + `U` | Tidy up into a grid |
| `Ctrl` + `Shift` + `L` | Auto-layout the connected flow |
| `Ctrl` + `Shift` + `H` | Version history |
| `Ctrl` + `G` / `Ctrl` + `Shift` + `G` | Group / ungroup |
| `?` | This list |

### General
`Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` undo·redo · `Ctrl`+`C`/`V`/`X` · `Ctrl`+`D` duplicate ·
`Ctrl`+`A` select all · `Ctrl`+`S` save · `Ctrl`+`E` export · `Ctrl`+`F` find ·
`Delete` · `Esc` deselect / cancel

> `Ctrl`+`Shift`+`T` is deliberately **not** bound — Chrome reserves it for "reopen closed tab"
> and never delivers it to the page.

---

## 🧩 Canvas templates

42 templates across nine categories, searchable in the gallery (**Templates**, or `Ctrl`+`K`).
These draw *shapes*; the project templates above create *tracked tasks*.

- **Get started** — blank, brainstorm mind map, sticky wall
- **Agile & delivery** — Kanban, sprint retro, sailboat retro, sprint planning, user story map, daily stand-up
- **Strategy** — SWOT, Business Model Canvas, Lean Canvas, impact/effort matrix
- **Diagrams** — flowchart, system architecture, ERD, org chart, fishbone, decision tree, swimlanes
- **Algorithms** — binary search, BFS, Dijkstra, dynamic programming, complexity cheat sheet
- **Planning** — roadmap, Gantt-style plan, weekly planner, OKRs, Eisenhower matrix, risk matrix, RACI
- **Design & research** — user journey, empathy map, 5 Whys, moodboard
- **Data** — dashboard, comparison table
- **Study & notes** — meeting notes, Cornell notes, lesson plan, revision mind map

---

## 🔑 Google Keep

There are two routes, and **which one you can use is decided by your account
type, not by anything you can switch on**.

### The Keep API does not work on personal accounts

`keep.googleapis.com` is a Google **Workspace enterprise** service. It
authorises against a managed Workspace domain and returns
`403 PERMISSION_DENIED` for a consumer `@gmail.com` address no matter what is
enabled in the Cloud console. Enabling the Keep API there is necessary but not
sufficient, and there is no setting that makes a personal account eligible.

Because of that the Keep scope is **off by default**. Requesting a scope the
account cannot be granted risks the whole consent screen — which would take
Drive, Docs, Gmail and Calendar down with it, trading a working connection for
one that cannot work.

On a Workspace account, switch it on:

```ini
GOOGLE_ENABLE_KEEP=1
```

then restart and reconnect Google, accepting the Keep permission.
`GET /api/google/keep/notes` serves the notes.

### On a personal account: the App Password route no longer works

The **Keep** section of the Workspace panel accepts three credentials, and only
two of them still function. This is the single most confusing thing about the
feature, so it is worth being exact:

| Credential | Status |
|---|---|
| **App Password** | ❌ Google closed this route into Keep. A *correct* App Password is now rejected exactly like a wrong one. Still tried first — it costs one request and works on a few older accounts. |
| **Master token** (`aas_et/…`) | ✅ Works. This is what the other two routes are trying to obtain. |
| **Browser token** (`oauth2_4/…`) | ✅ Works. Exchanged server-side for a master token. |

If "I used an App Password and it still says login failed" sounds familiar,
that is why — it was not a mistake on your part.

**The route that works**, once:

1. Open <https://accounts.google.com/EmbeddedSetup> and sign in.
2. At the screen asking you to accept, press <kbd>F12</kbd> → **Application**
   → **Cookies** → `google.com`.
3. Copy the value of the `oauth_token` cookie — it starts with `oauth2_4/`.
4. Paste it into the Keep dialog and press **Connect**. It is single-use and
   expires within minutes, so do it straight away.

The server trades it for a long-lived master token and hands that back; the
browser stores it, so the steps are never repeated. The dialog routes a pasted
value by its own prefix, so it does not matter which box it goes in, and it
opens these instructions by itself the moment an App Password is refused.

The device id the token is bound to is persisted in `data/.keep_device_id` —
a master token is tied to one device, so a fresh id on every call would
invalidate the token you saved last time.

`/api/google/keep/notes` returns this distinction as a `fix` line rather than
an empty list, so a personal account is told which button to press instead of
being shown "no notes".

---

## 🛠 Tech & architecture

Vanilla ES6+, no bundler. Flask + Flask-CORS on the backend, JSON files on disk plus `localStorage`.

```
app.py                     Flask backend (boards, uploads, Keep, PM API,
                           email automation, Google OAuth broker)
firestore.rules            Security rules — publish before inviting anyone
data/                      Saved boards (JSON)
  pm/projects/             Signed-out project records
  pm/tasks/                Signed-out task records, one file per project
  pm/tokens/               Google OAuth refresh tokens — do not commit
static/
  css/
    style.css              Shell, canvas, overlay, panels, modals, responsive rules
    pro-features.css       Per-element-type styling
    themes.css             12 themes, canvas patterns, studio UI
ios.css                iOS Light / iOS Dark tokens + Apple surface treatment
workspace.css          the Google Workspace screen
    pm.css                 Project workspace
    blocks.css             The three live blocks, and the Keep sign-in help
    fluid.css              One motion/surface pass over everything — loads
                           last, adds no components, honours reduced-motion
  js/
    core.js                Util, Emitter, Store (single source of truth + history)
    themes.js              ThemeManager, theme registry, light/dark pairing
    viewport.js            Camera, infinite ink layer, minimap
    render.js              Element DOM renderer + screen-space selection overlay
    connections.js         Universal connector engine (routing, ports, arrowheads)
    pro.js                 Modal, AlgorithmManager, ChartManager
    mindmap.js             Balanced tidy-tree mind mapping
    interaction.js         One unified pointer-event state machine
    extras.js              Exporters (PNG/SVG/JSON/Markdown/CSV/PDF), board library
    templates.js           The template library
    studio.js              Palette, shape recognition, arranger, versions,
                           live sync, workshop, converter, insights, quick bar
    keep.js                Google Keep import — App Password, master token
                           or browser token, and it remembers the result
    blocks/
      kernels.js           The two engines a live cell runs on: Pyodide
                           (real CPython, lazy) and a persistent JS scope
      code-cell.js         Notebook cell as a board object
      logic-lab.js         Logic gates that actually evaluate, plus the
                           fixed-point solver and truth-table generator
      sheet-dash.js        Live Google Sheets dashboard: typed columns,
                           inline SVG charts, auto-refresh
      gcal-block.js        Google Calendar on the board — agenda and week
                           views, events editable both ways, etag-guarded
      keep-sync.js         Two-way Keep sync: pull, debounced push, and a
                           conflict view that refuses to pick a winner
    attachments.js         Files and documents on board objects — the Drive
                           picker, local upload, the badge and its popover
    frames.js              Frames as areas of responsibility: assign an area
                           to teammates, and turn one into tracked tasks
    google-account.js      Makes the Firebase login and the server-side
                           Workspace connection one account with one status
    firebase-sync.js       Auth, board cloud sync, and the window.FB bridge
                           (the one ES module — it publishes Firestore to the
                           classic scripts and fires `firebase-ready`)
    app.js                 Application shell: tools, panels, shortcuts, persistence
    pm/
      schema.js            Task/project model, ordering, filters, rollups. Pure.
      workstore.js         Single source of truth for work items + undo
      adapters.js          LocalAdapter (Flask/localStorage) · FirestoreAdapter
      ui.js                Avatars, chips, popovers, pickers, drag kit
      views.js             Board · List · Calendar · Timeline · Workload
      task-panel.js        The task detail drawer
      templates.js         Project templates that create real tasks
      hub.js               Workspace shell: nav, filters, members, modals
      boot.js              Adapter selection, auth swap, automation dispatch
templates/index.html
```

**Design rule:** the `Store` owns all board data and the `WorkStore` owns all
task data. Nothing mutates either outside `commit()` / `transact()`. That one
rule is what makes undo/redo, autosave, realtime sync, the activity feed and
the email automations work without being written five times. A view that
reaches in and sets `task.title = x` will appear to work and will silently
break all five.

Everything in `studio.js` is additive and constructed inside a `try`, so a
failure in a feature can never stop the canvas from booting. The PM layer boots
on the local adapter first and upgrades to Firestore only once Firebase reports
a signed-in user, so the workspace is usable before the network is.

---

## 📡 API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | The app |
| `GET` | `/api/boards` | List saved boards |
| `GET` | `/api/board/<id>` | Get a board |
| `POST` | `/api/board/save` | Create / update (atomic write) |
| `POST` | `/api/board/<id>/duplicate` | Server-side copy |
| `POST` | `/api/board/export` | Stream a board as a download |
| `DELETE` | `/api/board/<id>` | Delete a board |
| `POST` | `/api/upload/image` | Upload an image (10 MB max) |
| `POST` | `/api/upload/file` | Upload an attachment — documents, data, media, archives (50 MB max) |
| `POST` | `/api/keep/login` | Google Keep sign-in. Takes `password` (App Password — closed by Google), `master_token`, or `oauth_token`; returns a reusable master token |
| `GET` | `/api/keep/notes` · `POST /api/keep/import` · `POST /api/keep/logout` | Read and import Keep notes, resuming from that token |
| `GET` | `/api/keep/state` | Every live note with its `updated` stamp — the poll live sync runs |
| `POST` | `/api/keep/push` | Write board edits back. Refuses a change whose `baseUpdated` is stale and returns the conflict instead; `force` overrides. Also creates new notes |

`/api/upload/file` takes a strict allow-list of extensions rather than a deny
list, because uploads are served straight back out of `/static`. Nothing the
browser or the OS would execute is on it — `svg` is excluded even though the
image endpoint accepts it, since an attachment is opened in a tab where its
scripts would run same-origin.

### Projects (signed-out fallback — Firestore is used when signed in)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/pm/projects` | Every project and its tasks, in one round trip |
| `POST` | `/api/pm/sync` | Batched upsert from the client's write-behind queue |
| `DELETE` | `/api/pm/project/<id>` | Delete a project and its tasks |
| `POST` | `/api/pm/invite` | Send invitation emails |
| `POST` | `/api/pm/notify` | Assignment / mention / completion emails |
| `GET` | `/api/pm/email/status` | Which route mail actually takes — Gmail API, SMTP, or none — plus the last few sends |
| `POST` | `/api/pm/email/test` | Send one real message and report the result |

### Google Workspace (dormant until credentials are set)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/google/status` | Configured? Connected? Whose account? Which scopes are missing? |
| `GET` | `/api/google/auth` · `/api/google/callback` | OAuth 2.0 flow (PKCE) |
| `POST` | `/api/google/disconnect` | Drop the stored token |
| `GET` | `/api/google/drive/list` | Browse or search all of Drive (`q`, `filter`, `folder`, `page`) |
| `GET` | `/api/google/keep/notes` | Keep notes — Workspace accounts only, off unless `GOOGLE_ENABLE_KEEP=1` |
| `GET` | `/api/google/drive/about` | Storage usage |
| `GET` | `/api/google/docs/list` | Docs, Sheets or Slides (`type`, `q`) |
| `POST` | `/api/google/docs/create` | Create a Doc seeded from a task |
| `GET` | `/api/google/gmail/list` | Message headers for a mailbox (`label`, `q`, `limit`) |
| `GET` | `/api/google/gmail/message/<id>` | One message as plain text |
| `GET` | `/api/google/gmail/labels` | Labels with unread counts |
| `GET` | `/api/google/calendar/events` | Events for a date range |
| `GET` | `/api/google/calendar/calendars` | The calendar list |
| `POST` | `/api/google/calendar/push` · `/delete` | Mirror a task's due date as an event |
| `POST` | `/api/google/calendar/event` | Create or update any event. Sends the caller's `etag` as `If-Match`, so a concurrent change comes back as 409 rather than being overwritten |
| `GET` | `/api/google/tasks/list` | Task lists and their open tasks |
| `POST` | `/api/google/tasks/create` | Push a project task into Google Tasks |
| `GET` | `/api/google/sheets/list` | Spreadsheets in Drive, most recently edited first |
| `GET` | `/api/google/sheets/meta` | Tab names and grid sizes. Accepts a bare id or any spreadsheet URL |
| `GET` | `/api/google/sheets/values` | Cell values for a range, padded to a rectangle |
| `PUT` | `/api/google/sheets/values` | Write a block back |

Every one of these reports *why* it failed, not just *that* it failed: a
disabled Cloud API, a scope that was never granted and an expired token each
come back with a `fix` line the interface renders verbatim — with the console
link live.

Gmail's list-then-fetch-each pattern is fanned out over a small thread pool, so
a 25-message mailbox is roughly one round trip rather than twenty-six.

Board ids are validated against `^[A-Za-z0-9_-]{1,80}$` before ever touching the filesystem, so a
crafted id cannot escape the data directory.

---

## 📄 License

MIT — free for personal and commercial use.
