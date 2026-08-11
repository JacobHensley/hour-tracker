# Hour Tracker

A single-user time tracker PWA. Tasks with CRUD, timed or manual sessions
(rounded to the nearest minute), and a date-filtered log with per-task totals.
Data syncs across devices through Firebase Firestore with anonymous auth —
no login screen, no server to maintain, and the free tier never pauses.

## Files

- `index.html` — markup
- `styles.css` — all styling
- `app.js` — all behavior (UI rendering + Firebase wiring)
- `firestore.rules` — security rules (paste into the Firebase console)
- `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png` — PWA install + offline shell

No build step — the files are served as-is.

## Running it locally

Serve the folder over HTTP; don't open `index.html` as a `file://` URL. Module
scripts, the manifest, and the service worker are all blocked on `file://`
because each such document is a unique opaque origin.

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Setup (one time, ~10 minutes)

### 1. Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project**. Name it anything
   (e.g. `hour-tracker`). Google Analytics: off, you don't need it.
2. Stay on the free **Spark** plan — no billing account required.

### 2. Enable anonymous auth

1. In the left sidebar: **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Anonymous**.

### 3. Create the Firestore database

1. **Build → Firestore Database → Create database**.
2. Pick a region close to you. Start in **production mode** (locked down —
   the rules in the next step open exactly what's needed).

### 4. Deploy the security rules

1. In Firestore, open the **Rules** tab.
2. Replace the contents with everything in `firestore.rules`, then **Publish**.

These rules mean: a user can only read/write documents under
`users/{their own uid}`. That's the entire security model — which is why
the config in the next step is safe to commit publicly.

### 5. Paste your config into app.js

1. Project settings (gear icon) → **General** → scroll to **Your apps** →
   click the web icon (`</>`) → register the app (no hosting needed).
2. Copy the `firebaseConfig` object it shows you.
3. In `app.js`, find the `firebaseConfig` block marked
   `PASTE YOUR FIREBASE CONFIG HERE` and replace the placeholder values.

### 6. Host on GitHub Pages

1. Create a repo and push these files to its root.
2. Repo **Settings → Pages** → Source: **Deploy from a branch** →
   branch `main`, folder `/ (root)` → Save.
3. Your app will be at `https://<username>.github.io/<repo>/`.

### 7. Install on your phone

Open that URL on your phone, then:
- **iOS Safari:** Share → **Add to Home Screen**
- **Android Chrome:** Menu → **Add to Home screen** / **Install app**

## Things worth knowing

- **Identity is per-device.** Anonymous auth creates a separate user ID on each
  device/browser, so your phone and laptop start out seeing *different* data.
  If cross-device sync matters, the cleanest upgrade is linking the anonymous
  account to a sign-in method (Firebase supports converting anonymous accounts
  without losing data) — a small future addition.
- **Don't clear site data** in the browser you use — that discards the anonymous
  credential, which orphans the data tied to it.
- **Offline works.** Firestore's persistent cache keeps the app functional with
  no connection and syncs queued changes when you're back online. The green dot
  in the header shows connection status.
- **The running timer is device-local** (deliberately). Sessions sync; a live
  ticking clock does not.

## Data model

```
users/{uid}/tasks/{taskId}       { name, status, createdAt }
users/{uid}/sessions/{sessionId} { taskId, taskName, date: "YYYY-MM-DD", minutes, createdAt }
```

Sessions snapshot `taskName` so deleting a task never breaks history;
renaming a task rewrites the snapshots to match.

`status` is one of `Not started`, `In Progress`, `Paused`, `Complete`, `Billed`.
Tasks created before the field existed have no `status` and read as `Not started`
until you change them.
