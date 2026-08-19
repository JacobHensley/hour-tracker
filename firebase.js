// firebase.js — Firebase init, anonymous auth, live subscriptions, and every
// Firestore write the app performs. All money/hour figures are derived at
// read time from sessions + settings; nothing is stored denormalized.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
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
  getDoc,
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
 *  of 0 mean "no rules" so existing data bills exactly as logged. */
export const DEFAULT_SETTINGS = { rate: 85, minHours: 0, maxHours: 0 };

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

  saveSettings: (patch) => setDoc(settingsRef(), patch, { merge: true })
};

// ---------- Backup / restore ----------

/** Current backup format. Bump if the shape ever changes incompatibly. */
export const BACKUP_VERSION = 1;

/** Connects using this browser's existing automatic anonymous identity and
 *  resolves with its id. No credentials and no user-facing login: it is the
 *  same silent connection the app itself makes on every load. */
export function connect() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(
      auth,
      (user) => {
        if (!user) return;
        userId = user.uid;
        resolve(user.uid);
      },
      reject
    );
    signInAnonymously(auth).catch(reject);
  });
}

/** Reads every document belonging to this browser's data into a plain object. */
export async function exportAll() {
  const [tasks, sessions, invoices, settings] = await Promise.all([
    getDocs(tasksCol()),
    getDocs(sessionsCol()),
    getDocs(invoicesCol()),
    getDoc(settingsRef())
  ]);
  const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return {
    app: 'hour-tracker',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    dataId: userId,
    data: {
      tasks: rows(tasks),
      sessions: rows(sessions),
      invoices: rows(invoices),
      settings: settings.exists() ? settings.data() : null
    }
  };
}

/** Throws unless `backup` looks like a snapshot this app wrote. */
function validateBackup(backup) {
  const data = backup && backup.data;
  const lists = data && [data.tasks, data.sessions, data.invoices];
  if (!data || !lists.every(Array.isArray)) {
    throw new Error('That file is not an Hour Tracker backup.');
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

/** Counts what's currently stored, for the backup page's summary. */
export async function currentCounts() {
  const [tasks, sessions, invoices] = await Promise.all([
    getDocs(tasksCol()),
    getDocs(sessionsCol()),
    getDocs(invoicesCol())
  ]);
  return { tasks: tasks.size, sessions: sessions.size, invoices: invoices.size };
}

/**
 * Signs in anonymously and live-syncs the user's data. `onData` receives
 * partial updates like `{ tasks }` / `{ sessions }` / `{ invoices }` /
 * `{ settings }` as each snapshot arrives.
 */
export function startFirebase({ onData, onError, onReady, onAuthFailed }) {
  onAuthStateChanged(auth, (user) => {
    if (!user) return;
    userId = user.uid;

    onSnapshot(
      tasksCol(),
      (snap) => {
        const tasks = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        onData({ tasks });
      },
      (error) => onError('Task sync error', error)
    );

    onSnapshot(
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
      (error) => onError('Session sync error', error)
    );

    onSnapshot(
      invoicesCol(),
      (snap) => {
        const invoices = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        onData({ invoices });
      },
      (error) => onError('Invoice sync error', error)
    );

    onSnapshot(
      settingsRef(),
      (snap) => onData({ settings: { ...DEFAULT_SETTINGS, ...(snap.data() || {}) } }),
      (error) => onError('Settings sync error', error)
    );

    onReady();
  });

  signInAnonymously(auth).catch((error) => onAuthFailed(error));
}
