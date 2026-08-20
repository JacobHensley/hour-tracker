// firebase.js — Firebase init, anonymous auth, live subscriptions, and every
// Firestore write the app performs. All money/hour figures are derived at
// read time from sessions + settings; nothing is stored denormalized.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
  signInWithPopup,
  signInWithCredential,
  linkWithPopup,
  signOut,
  GoogleAuthProvider,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  writeBatch,
  getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ============================================================
// Firebase config (Project settings → General → Your apps).
// Safe to commit publicly — access control is enforced by
// Firestore security rules, not by hiding this.
// ============================================================
const firebaseConfig = {
  apiKey: 'AIzaSyDs-H4grv6Ti6UKTL0JHG_8FvP08vV-9bg',
  authDomain: 'hour-tracker-ce485.firebaseapp.com',
  projectId: 'hour-tracker-ce485',
  storageBucket: 'hour-tracker-ce485.firebasestorage.app',
  messagingSenderId: '388018522367',
  appId: '1:388018522367:web:2766da98af7809d3f6e4ca',
  measurementId: 'G-V5REBHBGPY'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Offline persistence: the app keeps working with no connection; Firestore
// queues writes and syncs when back online.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() })
});

/** Billing settings used until the user's settings doc first syncs. min/max
 *  of 0 mean "no rules" so existing data bills exactly as logged. `clientName`
 *  is the single name every generated invoice bills to. */
export const DEFAULT_SETTINGS = { rate: 85, minHours: 0, maxHours: 0, clientName: '' };

let userId = null;

const tasksCol = () => collection(db, 'users', userId, 'tasks');
const sessionsCol = () => collection(db, 'users', userId, 'sessions');
const invoicesCol = () => collection(db, 'users', userId, 'invoices');
// A subcollection doc (not a field on the user doc) so the existing
// `users/{uid}/{document=**}` security rule covers it.
const settingsRef = () => doc(db, 'users', userId, 'settings', 'billing');

/** Generates a unique id for a new Firestore document. Callers create ids
 *  up front so the UI can navigate before the write round-trips. */
export function createId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Firestore caps a batch at 500 writes. Splits `items` into batches of 450
 *  and commits them in order, so a task with a long history still deletes. */
async function commitChunked(items, apply) {
  for (let i = 0; i < items.length; i += 450) {
    const batch = writeBatch(db);
    for (const item of items.slice(i, i + 450)) apply(batch, item);
    await batch.commit();
  }
}

export const ops = {
  addTask: (id, name) =>
    setDoc(doc(tasksCol(), id), { name, status: 'Not started', invoiceId: null, createdAt: Date.now() }),

  updateTask: (id, patch) => updateDoc(doc(tasksCol(), id), patch),

  /** Renames a task and refreshes the taskName snapshot on its sessions. */
  async renameTask(id, name, sessionIds) {
    await updateDoc(doc(tasksCol(), id), { name });
    await commitChunked(sessionIds, (batch, sessionId) =>
      batch.update(doc(sessionsCol(), sessionId), { taskName: name })
    );
  },

  /** Deletes a task together with its sessions. Sessions go first so a
   *  failure part-way leaves no sessions stranded behind a missing task. */
  async deleteTask(id, sessionIds) {
    await commitChunked(sessionIds, (batch, sessionId) =>
      batch.delete(doc(sessionsCol(), sessionId))
    );
    await deleteDoc(doc(tasksCol(), id));
  },

  // taskName is a denormalized snapshot kept for debuggability and backward
  // compatibility with data written by the previous version of the app.
  addSession: ({ id, taskId, taskName, date, minutes }) =>
    setDoc(doc(sessionsCol(), id), { taskId, taskName, date, minutes, createdAt: Date.now() }),

  updateSession: (id, patch) => updateDoc(doc(sessionsCol(), id), patch),

  deleteSession: (id) => deleteDoc(doc(sessionsCol(), id)),

  createInvoice: (id, number) =>
    setDoc(doc(invoicesCol(), id), { number, issued: null, paid: false, createdAt: Date.now() }),

  updateInvoice: (id, patch) => updateDoc(doc(invoicesCol(), id), patch),

  /** Deletes an invoice and returns its tasks to unbilled, atomically. */
  deleteInvoice: (id, taskIds) => {
    const batch = writeBatch(db);
    batch.delete(doc(invoicesCol(), id));
    for (const taskId of taskIds) {
      batch.update(doc(tasksCol(), taskId), { invoiceId: null, status: 'Complete' });
    }
    return batch.commit();
  },

  /** Creates a draft invoice and puts the given tasks on it, atomically. */
  billToNewInvoice: (id, number, taskIds) => {
    const batch = writeBatch(db);
    batch.set(doc(invoicesCol(), id), { number, issued: null, paid: false, createdAt: Date.now() });
    for (const taskId of taskIds) {
      batch.update(doc(tasksCol(), taskId), { invoiceId: id, status: 'Billed' });
    }
    return batch.commit();
  },

  saveSettings: (patch) => setDoc(settingsRef(), patch, { merge: true }),

  /** Deletes every task, session and invoice and resets billing settings.
   *  Chunked so an account with thousands of sessions still clears. */
  async deleteAllData() {
    const snaps = await Promise.all([getDocs(tasksCol()), getDocs(sessionsCol()), getDocs(invoicesCol())]);
    const counts = { tasks: snaps[0].size, sessions: snaps[1].size, invoices: snaps[2].size };
    const refs = snaps.flatMap((snap) => snap.docs.map((d) => d.ref));
    await commitChunked(refs, (batch, ref) => batch.delete(ref));
    await setDoc(settingsRef(), { ...DEFAULT_SETTINGS });
    return counts;
  }
};

// ---------- Backup / restore ----------

/** Current backup format. Bump if the shape ever changes incompatibly. */
export const BACKUP_VERSION = 1;

/** Throws unless `backup` looks like a snapshot this app wrote. */
function validateBackup(backup) {
  const data = backup && backup.data;
  const lists = data && [data.tasks, data.sessions, data.invoices];
  if (!data || !lists.every(Array.isArray)) {
    throw new Error('That file is not an Hour Tracker backup.');
  }
  if (data.settings != null && typeof data.settings !== 'object') {
    throw new Error('That backup\u2019s settings are not readable.');
  }
  if (backup.version > BACKUP_VERSION) {
    throw new Error(`Backup is version ${backup.version}; this app reads up to ${BACKUP_VERSION}.`);
  }
  return data;
}

/**
 * Writes a backup back in, keeping original document ids so tasks, sessions
 * and invoices stay linked to each other.
 *
 * `replace: true` clears what's currently stored first (a true point-in-time
 * restore); otherwise the backup is merged over what's there. Restoring into
 * a different browser works — that's how you move data to a new device.
 */
export async function importAll(backup, { replace = false } = {}) {
  const data = validateBackup(backup);

  if (replace) {
    const existing = await Promise.all([getDocs(tasksCol()), getDocs(sessionsCol()), getDocs(invoicesCol())]);
    const refs = existing.flatMap((snap) => snap.docs.map((d) => d.ref));
    await commitChunked(refs, (batch, ref) => batch.delete(ref));
  }

  const writes = [
    ...data.tasks.map((row) => ({ col: tasksCol(), row })),
    ...data.sessions.map((row) => ({ col: sessionsCol(), row })),
    ...data.invoices.map((row) => ({ col: invoicesCol(), row }))
  ];
  await commitChunked(writes, (batch, { col, row }) => {
    const { id, ...fields } = row;
    batch.set(doc(col, id), fields);
  });

  if (data.settings) await setDoc(settingsRef(), data.settings);

  return {
    tasks: data.tasks.length,
    sessions: data.sessions.length,
    invoices: data.invoices.length
  };
}

/** Builds a backup from what the app already has in memory, so Export costs
 *  no extra reads. Same shape `importAll` reads. */
export function makeBackup({ tasks, sessions, invoices, settings }) {
  return {
    app: 'hour-tracker',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    dataId: userId,
    data: {
      tasks: tasks.map((row) => ({ ...row })),
      sessions: sessions.map((row) => ({ ...row })),
      invoices: invoices.map((row) => ({ ...row })),
      settings: { ...settings }
    }
  };
}

// ---------- Accounts ----------

/** The subset of the Firebase user the UI renders. */
function accountOf(user) {
  return {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || '',
    photoURL: user.photoURL || '',
    anonymous: user.isAnonymous
  };
}

/**
 * Attaches Google to the session. Existing users are anonymous and their data
 * lives under `users/{anonymous uid}`, so the first sign-in *links* rather
 * than signing in fresh: the uid is preserved and nothing has to move.
 *
 * Returns `{ status: 'conflict', credential, email }` when that Google account
 * already owns a `users/{uid}` tree of its own — the caller decides what to do
 * with the anonymous data before switching, rather than discarding it here.
 */
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const current = auth.currentUser;

  if (current && current.isAnonymous) {
    try {
      const result = await linkWithPopup(current, provider);
      return { status: 'linked', account: accountOf(result.user) };
    } catch (error) {
      if (error.code !== 'auth/credential-already-in-use') throw error;
      return {
        status: 'conflict',
        credential: GoogleAuthProvider.credentialFromError(error),
        email: (error.customData && error.customData.email) || ''
      };
    }
  }

  const result = await signInWithPopup(auth, provider);
  return { status: 'signed-in', account: accountOf(result.user) };
}

/** Completes the collision path: switches to the Google account's own data. */
export async function useCredential(credential) {
  const result = await signInWithCredential(auth, credential);
  return accountOf(result.user);
}

/** Signs in without an account — the state every existing user is already in. */
export function signInAnonymous() {
  return signInAnonymously(auth);
}

export function signOutUser() {
  return signOut(auth);
}

// ---------- Live subscriptions ----------

let unsubscribers = [];

function stopSubscriptions() {
  for (const off of unsubscribers) off();
  unsubscribers = [];
}

/**
 * Snapshot metadata is the only honest source for "is this saved yet": a doc
 * with `hasPendingWrites` is a local edit Firestore has not acknowledged.
 * Counting them per collection gives the account menu's queued-changes number.
 */
const pendingByName = new Map();
let lastSyncedAt = 0;

function syncState() {
  let pending = 0;
  for (const count of pendingByName.values()) pending += count;
  return { online: navigator.onLine, pending, lastSyncedAt };
}

/**
 * Signs the user in and live-syncs their data. `onData` receives partial
 * updates like `{ tasks }` as each snapshot arrives; `onAccount` fires on
 * every auth change (with null when signed out); `onSync` tracks whether
 * those writes have actually landed.
 *
 * `autoSignIn()` decides whether a signed-out session silently becomes an
 * anonymous one — it stays false after an explicit Sign out, which is what
 * keeps the sign-in screen reachable.
 */
export function startFirebase({ onData, onError, onReady, onAuthFailed, onAccount, onSync, autoSignIn }) {
  const emitSync = () => onSync(syncState());
  window.addEventListener('online', emitSync);
  window.addEventListener('offline', emitSync);

  /** Records one snapshot's pending-write count and freshness. */
  function note(name, snap) {
    pendingByName.set(name, snap.docs ? snap.docs.filter((d) => d.metadata.hasPendingWrites).length : 0);
    if (!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) lastSyncedAt = Date.now();
    emitSync();
  }

  function subscribe() {
    const watch = (name, ref, handler, label) =>
      unsubscribers.push(
        onSnapshot(
          ref,
          { includeMetadataChanges: true },
          (snap) => {
            note(name, snap);
            handler(snap);
          },
          (error) => onError(label, error)
        )
      );

    watch(
      'tasks',
      tasksCol(),
      (snap) => {
        // Newest first; the task list re-sorts by status and keeps this order
        // within each status group.
        const tasks = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        onData({ tasks });
      },
      'Task sync error'
    );

    watch(
      'sessions',
      sessionsCol(),
      (snap) => {
        // Newest day first; within a day, most recently created first.
        const sessions = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => {
            if (a.date !== b.date) return a.date < b.date ? 1 : -1;
            return (b.createdAt || 0) - (a.createdAt || 0);
          });
        onData({ sessions });
      },
      'Session sync error'
    );

    watch(
      'invoices',
      invoicesCol(),
      (snap) => {
        const invoices = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        onData({ invoices });
      },
      'Invoice sync error'
    );

    watch(
      'settings',
      settingsRef(),
      (snap) => onData({ settings: { ...DEFAULT_SETTINGS, ...(snap.data() || {}) } }),
      'Settings sync error'
    );
  }

  onAuthStateChanged(auth, (user) => {
    // Sign-out and account switches both land here; drop the old account's
    // listeners before touching userId so no snapshot arrives for the wrong uid.
    stopSubscriptions();
    pendingByName.clear();
    lastSyncedAt = 0;

    if (!user) {
      userId = null;
      onAccount(null);
      if (autoSignIn()) signInAnonymously(auth).catch(onAuthFailed);
      return;
    }

    userId = user.uid;
    onAccount(accountOf(user));
    subscribe();
    emitSync();
    onReady();
  });

  // No eager sign-in here. Firebase restores the persisted session from
  // IndexedDB asynchronously, so `auth.currentUser` is null on every load —
  // including a signed-in one. Calling signInAnonymously() here therefore
  // always ran, and it only short-circuits for a restored *anonymous* user:
  // for a Google account it minted a fresh anonymous user and dropped the
  // real session, logging the user out on every refresh. The callback above
  // covers both cases — it fires with the restored user, or with null, and
  // the null branch signs in anonymously.
}
