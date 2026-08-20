# Hour Tracker

A time-tracking and invoicing PWA for one person's billable work. Track time
against tasks with a timer or a manual entry, apply your rate and min/max
billing rules, then package finished tasks onto invoices. Data lives in
Firebase Firestore and syncs across devices; there is no server to run and no
build step to wait for.

Sign in with Google to sync, or skip it entirely — the app works signed out on
a per-device anonymous identity, and linking Google later keeps the data.

---

## Architecture at a glance

The whole app is plain ES modules served as static files. `index.html` loads
`src/app.js`; every import between modules is a relative path. Nothing is
bundled, transpiled, or minified — what you edit is what the browser runs.

```
                 ┌──────────────────────────────────────────┐
   Firestore ───▶│ firebase.js   all I/O: auth, snapshots,   │
   (snapshots)   │               writes, backup, sync state  │
                 └───────────────┬──────────────────────────┘
                                 │ onData({tasks, sessions, invoices, settings})
                                 ▼
                 ┌──────────────────────────────────────────┐
   DOM clicks ──▶│ app.js        the only stateful layer:    │
   (delegated)   │               `data`, `phase`, actions    │
                 └───────────────┬──────────────────────────┘
                                 │ render(data, ui, timer)
                                 ▼
                 ┌──────────────────────────────────────────┐
                 │ render.js  +  settings.js                 │
                 │            pure HTML strings, no listeners│
                 └───────────────┬──────────────────────────┘
                                 │ uses
                                 ▼
                 ┌──────────────────────────────────────────┐
                 │ billing.js    pure functions: dates,      │
                 │               formatting, billing math    │
                 └──────────────────────────────────────────┘

   state.js  ── the `ui` object + the handful of things that persist
                on this device (running timer, filters, signed-out flag)
```

Dependencies only point downward. `billing.js` imports nothing.
`render.js` and `settings.js` never touch Firebase or attach a listener.
`firebase.js` never touches the DOM.

### The rendering model

There is no framework and no virtual DOM. `render()` rebuilds `innerHTML` for
four slots (`account-slot`, `chip-rail`, `scroll-body`, `bottom-slot`) plus the
settings surface, from `data` and `ui`. Three conventions make that safe:

- **Events are delegated.** Every interactive element carries a
  `data-action="…"` attribute (plus `data-id`, `data-status`, etc). One click
  handler on `#app` looks the action up in the `actions` map in `app.js`. No
  code holds a reference into DOM that render is about to discard.
- **Focus is preserved.** `captureFocus()` snapshots the focused input's value
  and caret before the rebuild and `restoreFocus()` puts them back, so a
  snapshot arriving mid-edit doesn't wipe what you're typing. Settings inputs
  commit on `change` (blur/Enter), not per keystroke, for the same reason.
- **The clock doesn't re-render.** A 200ms interval rewrites only
  `[data-clock]` text nodes, so a running timer never closes an open popup.

### State, split three ways

| Where | What | Lifetime |
|---|---|---|
| `data` in `app.js` | tasks, sessions, invoices, settings, account, sync — mirrors of Firestore | replaced by every snapshot |
| `ui` in `state.js` | screen, selected bucket, open popups, which row is being edited, toast | in memory only |
| `localStorage` | running timer, status filter, AS BILLED toggle, explicit signed-out flag | survives reloads, stays on this device |

`phase` in `app.js` (`connecting` → `signin` → `ready`) picks which top-level
surface is visible. `ui.screen` is finer-grained: the Settings screen is a
full-frame layer *over* the app, so the app keeps its scroll position,
selection, and running timer underneath.

The running timer is deliberately device-local. Sessions sync; a live ticking
clock does not. It's stored as `{ taskId, startedAt, pausedAt, pausedTotal }`,
so elapsed time is always derived, never accumulated by an interval.

### Money is always derived

Nothing denormalized is stored. A task's hours come from summing its sessions;
its billable minutes come from applying `minHours`/`maxHours` to that sum; its
amount comes from multiplying by `rate`. All of it happens at read time in
`billing.js`, so changing your rate immediately and correctly restates every
unbilled figure.

The one exception is `taskName` on a session — a snapshot kept so history stays
readable, refreshed whenever the task is renamed.

### Two views, one rail

Navigation is a single value: `ui.bucket`, either `'unbilled'` or an invoice id.
The chip rail across the top switches it.

- **Unbilled** — timer card, manual log row, rate/rules summary, the filtered
  task list, and the session log. Tick tasks and the bottom bar becomes
  "Bill N tasks · $X", which creates an invoice and moves them onto it in one
  batch.
- **Invoice** — its tasks, totals, effective rate, and a DRAFT / SENT / PAID
  state. Deleting an invoice returns its tasks to unbilled rather than
  destroying them.

A task is `Billed` exactly when it carries an `invoiceId`; that isn't a status
you can set by hand. The other four (`Not started`, `In Progress`, `Paused`,
`Complete`) are yours to pick.

---

## Files

```
index.html          static shell (stays at the root — GitHub Pages serves it)
sw.js               service worker (stays at the root to claim the whole origin)
manifest.json       PWA install metadata
firestore.rules     security rules (paste into the Firebase console)
styles/
  styles.css        all styling; design tokens in `:root`
assets/
  icon-192.png      PWA icons
  icon-512.png
src/
  app.js            entry module: delegated events, actions, Firebase wiring
  render.js         builds the app's HTML from state
  settings.js       account menu, Settings screen, sign-in screen HTML
  state.js          the `ui` object + device-local persistence
  billing.js        pure calculations and formatting (no DOM, no Firebase)
  firebase.js       config, auth, subscriptions, writes, backup/restore
```

Export and import live on the Settings screen; see **Backups** under Behavior
worth knowing.

---

## Data model

```
users/{uid}/tasks/{taskId}          { name, status, invoiceId, createdAt }
users/{uid}/sessions/{sessionId}    { taskId, taskName, date: "YYYY-MM-DD", minutes, createdAt }
users/{uid}/invoices/{invoiceId}    { number, issued: "YYYY-MM-DD"|null, paid, createdAt }
users/{uid}/settings/billing        { rate, minHours, maxHours }
```

Everything hangs off `users/{uid}`, which is the entire security model — the
rule in `firestore.rules` allows a user to read and write under their own uid
and nothing else. Settings is a document in a subcollection (rather than a
field on the user doc) so that one rule covers it too.

Document ids are generated client-side (`createId()`), so the UI can navigate
to a new invoice before the write round-trips. Batched writes are chunked at
450 operations to stay under Firestore's 500-per-batch cap, which is what lets
a task with years of history delete cleanly.

Legacy data is normalized on read: tasks written before `status` existed read as
`Not started`, and a pre-invoice `Billed` status reads as `Complete`.

---

## Accounts and sync

The app has three identity states, and moves between them without losing data:

1. **Anonymous** (default). Firebase signs you in automatically on first load.
   Real data, real sync, but the identity lives only in this browser.
2. **Google-linked.** Signing in *links* Google to the existing anonymous
   account, so the uid is preserved and nothing has to be migrated. This is why
   "Sign in" never signs you out first.
3. **Collision.** If that Google account already owns its own data, linking
   fails with `auth/credential-already-in-use`. Rather than silently discarding
   either side, the app holds the credential and offers to export this device's
   data before switching.

An explicit **Sign out** sets a flag in `localStorage`; without it the app would
sign you straight back in anonymously on reload and the sign-in screen would be
unreachable.

**Sync status** comes from Firestore snapshot metadata, not from guessing:
a document with `hasPendingWrites` is a local edit the server hasn't
acknowledged. Counting them per collection produces the queued-changes number
and the "synced 4m ago" line in the account menu.

**Offline works.** Firestore's persistent cache keeps the app fully usable with
no connection and flushes queued writes when you're back.

**Backups** are one JSON file containing every task, session, invoice, and your
settings. Import restores original document ids, so the links between tasks,
sessions, and invoices survive — which also makes an export the supported way
to move data between accounts.

---

## Caching

`sw.js` is **network-first** for same-origin GETs: it fetches, stores a copy,
and falls back to cache only when the request fails. Cache-first was the
obvious choice for a static shell and it was wrong — edited files kept being
served stale until the cache name was bumped by hand.

The fetch uses `cache: 'reload'` to skip the browser's own HTTP cache, since a
plain static host sends no `Cache-Control` and a heuristically cached file
would otherwise get stored here as if it were fresh.

Firebase auth and Firestore traffic passes through untouched. Firestore's own
persistent cache is what handles offline data; the service worker only handles
the shell.

---

## Running it locally

Serve the folder over HTTP. Don't open `index.html` as a `file://` URL — module
scripts, the manifest, and the service worker are all blocked there, because
each `file://` document is a unique opaque origin.

```
python3 -m http.server 8000
```

Then open http://localhost:8000. There is nothing to install and nothing to
build.

---

## Setup from scratch (~10 minutes)

The committed `firebaseConfig` points at an existing project. To run your own:

**1. Create the Firebase project.** https://console.firebase.google.com → **Add
project**. Analytics off. Stay on the free **Spark** plan — no billing account,
and it never pauses.

**2. Enable auth.** **Build → Authentication → Get started**, then enable both
**Anonymous** and **Google** under Sign-in method.

**3. Create Firestore.** **Build → Firestore Database → Create database**, a
region near you, **production mode** (locked down — the next step opens exactly
what's needed).

**4. Deploy the rules.** Firestore → **Rules** tab → replace with the contents
of `firestore.rules` → **Publish**.

**5. Paste your config.** Project settings → **General** → **Your apps** → web
icon (`</>`) → register the app. Copy the `firebaseConfig` object into the
marked block in `src/firebase.js`. It's safe to commit — access control comes
from the security rules, not from hiding the config.

**6. Host it.** Push to a repo, then **Settings → Pages** → Deploy from a branch
→ `main`, folder `/ (root)`. The app lands at
`https://<username>.github.io/<repo>/`.

**7. Install it.** Open that URL on your phone: iOS Safari → Share → **Add to
Home Screen**; Android Chrome → Menu → **Install app**.

---

## Things worth knowing

- **Signed out, your data is tied to one browser.** Anonymous auth mints a
  separate uid per device, so your phone and laptop start out with different
  data. Sign in with Google, or move data across with an export/import.
- **Don't clear site data** while signed out — that discards the anonymous
  credential and orphans everything tied to it.
- **Destructive actions arm before they fire.** Delete task and Delete all data
  both prime on the first tap and commit on the second; any other tap disarms
  them.
- **Deleting a task deletes its sessions.** Sessions go first, so a failure
  part-way through never leaves sessions stranded behind a missing task.
- **Timer sessions under a minute are discarded** on stop, rather than logged
  as zero.
