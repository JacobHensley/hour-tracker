// app.js — entry point: wires Firebase data and delegated DOM events to the
// ui state and render(). Rendered elements carry data-action attributes;
// nothing here holds references into the rebuilt DOM.

import { todayIso, formatMinutes, timerElapsedMs, formatClock, STATUS_ORDER } from './billing.js';
import {
  ops,
  createId,
  startFirebase,
  DEFAULT_SETTINGS,
  makeBackup,
  importAll,
  signInWithGoogle,
  useCredential,
  signInAnonymous,
  signOutUser
} from './firebase.js';
import {
  ui,
  closePopups,
  getTimer,
  setTimer,
  saveStatusFilter,
  saveShowBillable,
  isSignedOut,
  setSignedOut,
  clearLocalState
} from './state.js';
import { render } from './render.js';
import { docSlug } from './invoice-doc.js';
import { signInScreen } from './settings.js';

const $ = (id) => document.getElementById(id);

/** Timer sessions shorter than this are discarded on stop. */
const MIN_LOGGABLE_MS = 60000;

/** The clock repaints every 200ms (not 1s) so pausing freezes on the true
 *  value with no visible jump. Only [data-clock] text nodes are touched. */
const CLOCK_TICK_MS = 200;

const TOAST_MS = 2600;

// ---------- Data + render ----------

const data = {
  tasks: [],
  sessions: [],
  invoices: [],
  settings: { ...DEFAULT_SETTINGS },
  account: null, // { uid, email, photoURL, anonymous } or null when signed out
  sync: null // { online, pending, lastSyncedAt }
};

/** Which full-frame surface is live. `ui.screen` layers Settings on top of
 *  'ready'; this is the coarser question of whether there is an app at all. */
let phase = 'connecting'; // 'connecting' | 'signin' | 'ready'

/** Set when a signed-in user asks for the sign-in screen anyway — an
 *  anonymous user linking a Google account, who must not be signed out first
 *  or the link (and their data) is lost. */
let wantSignIn = false;

/** The Google credential held back by an `auth/credential-already-in-use`
 *  collision, until the user decides whether to abandon the local data. */
let pendingCredential = null;

/** The chosen backup File. Kept out of `ui` because render() rebuilds the
 *  file input on every pass, which would drop it. */
let importFile = null;

function rerender() {
  if (phase === 'signin') $('signin-screen').innerHTML = signInScreen(ui);
  if (phase === 'ready') render(data, ui, getTimer());
}

/** Switches which surface is on screen and repaints it. */
function paint() {
  $('loading').hidden = phase !== 'connecting';
  $('signin-screen').hidden = phase !== 'signin';
  $('app').hidden = phase !== 'ready';
  rerender();
}

let toastTimer = null;

/** Shows a transient message (in the timer card, or floating on invoices). */
function flash(message) {
  ui.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast = '';
    rerender();
  }, TOAST_MS);
  rerender();
}

/** Surfaces a failed write as a toast instead of failing silently. */
function guard(promise, what) {
  Promise.resolve(promise).catch((error) => flash(`${what}: ${error.message}`));
}

// ---------- Lookups ----------

function taskName(id) {
  const task = data.tasks.find((t) => t.id === id);
  return task ? task.name : 'Unknown task';
}

function firstUnbilledId() {
  const task = data.tasks.find((t) => !t.invoiceId);
  return task ? task.id : '';
}

function currentInvoice() {
  return data.invoices.find((i) => i.id === ui.bucket) || null;
}

function nextInvoiceNumber() {
  return 'INV-' + String(data.invoices.length + 1).padStart(4, '0');
}

/** Opens one popup, closing any other; toggles it shut if already open. */
function togglePopup(flag) {
  const wasOpen = ui[flag];
  closePopups();
  ui[flag] = !wasOpen;
}

// ---------- Actions (delegated via data-action) ----------

function logSession(taskId, minutes) {
  guard(
    ops.addSession({ id: createId(), taskId, taskName: taskName(taskId), date: todayIso(), minutes }),
    'Could not log session'
  );
  flash(`${formatMinutes(minutes)} logged to ${taskName(taskId)}.`);
}

function createTask() {
  const input = $('new-task-name');
  const name = input ? input.value.trim() : '';
  if (!name) return;
  if (data.tasks.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    flash(`Task "${name}" already exists.`);
    return;
  }
  ui.newTaskOpen = false;
  guard(ops.addTask(createId(), name), 'Could not add task');
  rerender();
}

function saveTask(id) {
  const input = $('edit-task-name');
  const name = input ? input.value.trim() : '';
  if (!name) return flash('Task needs a name.');

  if (data.tasks.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) {
    return flash(`Task "${name}" already exists.`);
  }
  ui.editTask = null;
  ui.confirmDeleteTask = null;

  if (name !== taskName(id)) {
    const sessionIds = data.sessions.filter((s) => s.taskId === id).map((s) => s.id);
    guard(ops.renameTask(id, name, sessionIds), 'Could not rename task');
    flash(`Renamed to ${name}.`);
  } else {
    rerender();
  }
}

const actions = {
  // --- Navigation ---
  bucket(el) {
    ui.bucket = el.dataset.id;
    ui.selected = [];
    ui.invEditOpen = false;
    closePopups();
    rerender();
  },
  'new-invoice'() {
    const id = createId();
    const number = nextInvoiceNumber();
    guard(ops.createInvoice(id, number), 'Could not create invoice');
    // Mirror the write locally so navigating to the new bucket doesn't race
    // the snapshot; the next invoices snapshot replaces the array wholesale.
    data.invoices.unshift({ id, number, issued: null, paid: false, createdAt: Date.now() });
    ui.bucket = id;
    ui.selected = [];
    closePopups();
    rerender();
  },

  // --- Timer ---
  'timer-btn'() {
    const timer = getTimer();
    if (!timer) {
      const taskId = ui.trackTaskId || firstUnbilledId();
      if (!taskId) return flash('Add a task first.');
      setTimer({ taskId, startedAt: Date.now(), pausedAt: null, pausedTotal: 0 });
      closePopups();
      rerender();
      return;
    }
    // Stop & log always logs, even from a paused state.
    const elapsed = timerElapsedMs(timer, Date.now());
    setTimer(null);
    if (elapsed < MIN_LOGGABLE_MS) return flash('Under 1 minute — session discarded.');
    logSession(timer.taskId, Math.round(elapsed / 60000));
  },
  'pause-btn'() {
    const timer = getTimer();
    if (!timer) return;
    setTimer(
      timer.pausedAt
        ? { ...timer, pausedAt: null, pausedTotal: timer.pausedTotal + (Date.now() - timer.pausedAt) }
        : { ...timer, pausedAt: Date.now() }
    );
    rerender();
  },
  'toggle-track-menu'() {
    if (!getTimer()) togglePopup('trackMenuOpen');
    rerender();
  },
  'pick-track'(el) {
    ui.trackTaskId = el.dataset.id;
    ui.trackMenuOpen = false;
    rerender();
  },
  'log-manual'() {
    const input = $('manual-minutes');
    const minutes = parseInt(input.value, 10);
    if (!minutes || minutes < 1) return flash('Enter at least 1 minute.');
    const taskId = ui.trackTaskId || firstUnbilledId();
    if (!taskId) return flash('Add a task first.');
    input.value = '';
    logSession(taskId, minutes);
  },

  // --- Billing rules preview ---
  'toggle-billable'() {
    ui.showBillable = !ui.showBillable;
    saveShowBillable(ui.showBillable);
    rerender();
  },

  // --- Task list ---
  'toggle-filter'() {
    togglePopup('filterOpen');
    rerender();
  },
  'toggle-status-filter'(el) {
    const status = el.dataset.status;
    ui.statusFilter = ui.statusFilter.includes(status)
      ? ui.statusFilter.filter((s) => s !== status)
      : [...ui.statusFilter, status];
    saveStatusFilter(ui.statusFilter);
    rerender();
  },
  'all-statuses'() {
    ui.statusFilter = [...STATUS_ORDER];
    saveStatusFilter(ui.statusFilter);
    rerender();
  },
  'select-task'(el) {
    const id = el.dataset.id;
    ui.selected = ui.selected.includes(id)
      ? ui.selected.filter((s) => s !== id)
      : [...ui.selected, id];
    rerender();
  },
  'open-status-menu'(el) {
    const wasOpen = ui.statusMenuFor;
    closePopups();
    ui.statusMenuFor = wasOpen === el.dataset.id ? null : el.dataset.id;
    rerender();
  },
  'set-status'(el) {
    ui.statusMenuFor = null;
    guard(ops.updateTask(el.dataset.id, { status: el.dataset.status }), 'Could not update status');
    rerender();
  },
  'toggle-new-task'() {
    ui.newTaskOpen = !ui.newTaskOpen;
    rerender();
    if (ui.newTaskOpen) $('new-task-name')?.focus();
  },
  'create-task'() {
    createTask();
  },
  'open-task-editor'(el) {
    closePopups();
    ui.editTask = ui.editTask === el.dataset.id ? null : el.dataset.id;
    ui.confirmDeleteTask = null;
    rerender();
    $('edit-task-name')?.focus();
  },
  'save-task'(el) {
    saveTask(el.dataset.id);
  },
  'delete-task'(el) {
    const id = el.dataset.id;
    const timer = getTimer();
    if (timer && timer.taskId === id) return flash('Stop the timer before deleting its task.');

    // Deleting a task destroys its logged sessions and can't be undone, so
    // the button arms on the first tap and commits on the second.
    if (ui.confirmDeleteTask !== id) {
      ui.confirmDeleteTask = id;
      return rerender();
    }

    const sessionIds = data.sessions.filter((s) => s.taskId === id).map((s) => s.id);
    const name = taskName(id);
    ui.editTask = null;
    ui.confirmDeleteTask = null;
    ui.selected = ui.selected.filter((s) => s !== id);
    guard(ops.deleteTask(id, sessionIds), 'Could not delete task');
    flash(`${name} deleted.`);
  },

  // --- Session log ---
  'open-session'(el) {
    closePopups();
    ui.editSession = ui.editSession === el.dataset.id ? null : el.dataset.id;
    rerender();
  },
  'toggle-session-task-menu'() {
    togglePopup('editTaskMenu');
    rerender();
  },
  'move-session'(el) {
    ui.editTaskMenu = false;
    guard(
      ops.updateSession(el.dataset.id, { taskId: el.dataset.task, taskName: taskName(el.dataset.task) }),
      'Could not move session'
    );
    rerender();
  },
  'save-session'(el) {
    const minutes = parseInt($('edit-minutes').value, 10);
    if (!minutes || minutes < 1) return flash('Enter at least 1 minute.');
    ui.editSession = null;
    ui.editTaskMenu = false;
    guard(ops.updateSession(el.dataset.id, { minutes }), 'Could not update session');
    flash(`Session updated to ${formatMinutes(minutes)}.`);
  },
  'delete-session'(el) {
    ui.editSession = null;
    ui.editTaskMenu = false;
    guard(ops.deleteSession(el.dataset.id), 'Could not delete session');
    flash('Session deleted.');
  },

  // --- Billing ---
  'bill-selected'() {
    if (!ui.selected.length) return;
    const id = createId();
    const number = nextInvoiceNumber();
    guard(ops.billToNewInvoice(id, number, ui.selected), 'Could not bill tasks');
    // Mirror the batch locally so the jump to the new invoice doesn't race
    // the snapshots (either could land first); both replace this soon after.
    data.invoices.unshift({ id, number, issued: null, paid: false, createdAt: Date.now() });
    for (const task of data.tasks) {
      if (ui.selected.includes(task.id)) {
        task.invoiceId = id;
        task.status = 'Billed';
      }
    }
    ui.bucket = id;
    ui.selected = [];
    rerender();
  },

  // --- Invoice view ---
  'toggle-inv-edit'() {
    ui.invEditOpen = !ui.invEditOpen;
    rerender();
  },
  'save-invoice'() {
    const number = $('inv-number-input').value.trim();
    if (!number) return flash('Invoice needs a number.');
    ui.invEditOpen = false;
    guard(ops.updateInvoice(ui.bucket, { number }), 'Could not rename invoice');
    flash(`Invoice renamed to ${number}.`);
  },
  'delete-invoice'() {
    const invoice = currentInvoice();
    if (!invoice) return;
    const taskIds = data.tasks.filter((t) => t.invoiceId === invoice.id).map((t) => t.id);
    ui.bucket = 'unbilled';
    ui.invEditOpen = false;
    guard(ops.deleteInvoice(invoice.id, taskIds), 'Could not delete invoice');
    flash(`${invoice.number} deleted — its tasks returned to unbilled.`);
  },
  'open-state-menu'() {
    togglePopup('stateMenuOpen');
    rerender();
  },
  'set-inv-state'(el) {
    ui.stateMenuOpen = false;
    const invoice = currentInvoice();
    if (!invoice) return;
    const state = el.dataset.state;
    const patch =
      state === 'DRAFT'
        ? { issued: null, paid: false }
        : state === 'SENT'
          ? { issued: invoice.issued || todayIso(), paid: false }
          : { issued: invoice.issued || todayIso(), paid: true };
    guard(ops.updateInvoice(invoice.id, patch), 'Could not update invoice');
    rerender();
  },
  'remove-inv-task'(el) {
    guard(
      ops.updateTask(el.dataset.id, { invoiceId: null, status: 'Complete' }),
      'Could not remove task'
    );
  },
  'toggle-add-menu'() {
    togglePopup('addMenuOpen');
    rerender();
  },
  'add-task-to-invoice'(el) {
    ui.addMenuOpen = false;
    guard(
      ops.updateTask(el.dataset.id, { invoiceId: ui.bucket, status: 'Billed' }),
      'Could not add task'
    );
    rerender();
  },
  'toggle-sessions'() {
    ui.sessionsOpen = !ui.sessionsOpen;
    rerender();
  },

  // --- Account menu ---
  'toggle-account-menu'() {
    togglePopup('accountMenuOpen');
    rerender();
  },
  'open-settings'() {
    closePopups();
    ui.screen = 'settings';
    resetSettingsUi();
    rerender();
  },
  'close-settings'() {
    ui.screen = 'app';
    resetSettingsUi();
    rerender();
  },

  // --- Invoice document ---
  'open-doc'() {
    const invoice = currentInvoice();
    if (!invoice) return;
    // Order matters: the client name is the setting the user has to go and
    // fix, so it is worth reporting before the emptier invoice problem.
    if (!(data.settings.clientName || '').trim()) {
      return flash('Set a Bill to name in Account & data first.');
    }
    if (!data.tasks.some((t) => t.invoiceId === invoice.id)) {
      return flash('Add a task to this invoice first.');
    }
    closePopups();
    ui.screen = 'doc';
    rerender();
  },
  'close-doc'() {
    ui.screen = 'app';
    rerender();
  },
  // No PDF library and no build step: the print stylesheet reduces the page
  // to the sheets themselves and the browser's own "Save as PDF" writes the
  // file. The document title is what it offers as the filename.
  'download-doc'() {
    const invoice = currentInvoice();
    if (!invoice) return;
    const title = document.title;
    document.title = docSlug(invoice.number);
    // Restored on afterprint, not straight after print(): print() returns
    // before the dialog closes in some browsers, and the title is what the
    // filename is read from while it is open.
    window.addEventListener(
      'afterprint',
      () => {
        document.title = title;
      },
      { once: true }
    );
    window.print();
  },

  // --- Sign in / out ---
  'go-signin'() {
    // Deliberately does not sign out: an anonymous user's data is preserved
    // by *linking* Google to the account they already have.
    closePopups();
    wantSignIn = true;
    ui.screen = 'app';
    phase = 'signin';
    paint();
  },
  'cancel-signin'() {
    pendingCredential = null;
    ui.signInConflict = '';
    if (data.account) {
      wantSignIn = false;
      phase = 'ready';
    }
    paint();
  },
  'continue-local'() {
    setSignedOut(false);
    wantSignIn = false;
    ui.signInConflict = '';
    pendingCredential = null;
    if (data.account) {
      phase = 'ready';
      return paint();
    }
    phase = 'connecting';
    paint();
    signInAnonymous().catch((error) => {
      phase = 'signin';
      paint();
      flash('Could not connect: ' + error.message);
    });
  },
  async 'sign-in-google'() {
    ui.busy = 'signin';
    rerender();
    // Cleared up front for the same reason as confirm-signin: a fresh popup
    // sign-in fires onAuthStateChanged before this function resumes.
    const wasWanted = wantSignIn;
    wantSignIn = false;
    try {
      const result = await signInWithGoogle();
      ui.busy = '';
      if (result.status === 'conflict') {
        // That Google account owns its own users/{uid} tree. Switching to it
        // strands the anonymous data, so offer Export before committing.
        wantSignIn = wasWanted;
        pendingCredential = result.credential;
        ui.signInConflict = result.email || 'That Google account';
        return rerender();
      }
      setSignedOut(false);
      // A link keeps the same uid, so onAuthStateChanged never fires for it —
      // the account has to be applied here. A fresh sign-in fires too, and
      // sets the same values again harmlessly.
      data.account = result.account;
      phase = 'ready';
      paint();
    } catch (error) {
      ui.busy = '';
      wantSignIn = wasWanted;
      if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
        return rerender();
      }
      flash('Sign-in failed: ' + error.message);
    }
  },
  async 'confirm-signin'() {
    if (!pendingCredential) return;
    const credential = pendingCredential;
    ui.busy = 'signin';
    rerender();
    // These are cleared *before* the await: onAuthStateChanged can fire while
    // it is in flight, and onReady() bails out while wantSignIn is still set,
    // which would strand the app on the sign-in screen.
    pendingCredential = null;
    ui.signInConflict = '';
    setSignedOut(false);
    wantSignIn = false;
    try {
      // onAuthStateChanged resubscribes under the new uid and calls onReady.
      await useCredential(credential);
      ui.busy = '';
    } catch (error) {
      pendingCredential = credential;
      wantSignIn = true;
      ui.busy = '';
      flash('Sign-in failed: ' + error.message);
      rerender();
    }
  },
  async 'sign-out'() {
    closePopups();
    ui.screen = 'app';
    resetSettingsUi();
    setSignedOut(true);
    try {
      await signOutUser();
    } catch (error) {
      setSignedOut(false);
      flash('Could not sign out: ' + error.message);
    }
  },

  // --- Backups ---
  'export-backup'() {
    try {
      const name = `hours-backup-${todayIso()}.json`;
      downloadJson(makeBackup(data), name);
      flash(`Saved ${name}`);
    } catch (error) {
      flash('Export failed: ' + error.message);
    }
  },
  'pick-import-file'() {
    $('import-file-input')?.click();
  },
  'cancel-import'() {
    clearImport();
    rerender();
  },
  async 'confirm-import'() {
    if (!importFile) return;
    ui.busy = 'import';
    rerender();
    try {
      // Import replaces rather than merges — that is what this gate protects.
      const written = await importAll(JSON.parse(await importFile.text()), { replace: true });
      clearImport();
      ui.busy = '';
      rerender();
      const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      flash(
        `Backup restored — ${count(written.tasks, 'task')}, ${count(written.sessions, 'session')}, ` +
          `${count(written.invoices, 'invoice')}.`
      );
    } catch (error) {
      ui.busy = '';
      rerender();
      flash('Import failed: ' + error.message);
    }
  },
  async 'delete-all'() {
    // Same arming pattern as the task delete: first tap primes, second commits.
    if (!ui.confirmDeleteAll) {
      ui.confirmDeleteAll = true;
      return rerender();
    }
    ui.confirmDeleteAll = false;
    ui.busy = 'delete';
    rerender();
    try {
      await ops.deleteAllData();
      setTimer(null);
      clearLocalState();
      ui.busy = '';
      rerender();
      flash('All data deleted.');
    } catch (error) {
      ui.busy = '';
      rerender();
      flash('Delete failed: ' + error.message);
    }
  }
};

// ---------- Settings helpers ----------

/** Drops anything half-finished on the settings screen. */
function resetSettingsUi() {
  ui.confirmDeleteAll = false;
  clearImport();
}

function clearImport() {
  importFile = null;
  ui.importFileName = '';
  ui.importFileSize = 0;
}

/** Hands the backup to the browser as a download. */
function downloadJson(backup, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- Event wiring ----------

/** One delegated click handler for every surface. */
function onActionClick(event) {
  // The task card as a whole opens its editor, so a tap into the rename field
  // would close it. Inputs are driven by change/keydown, so nothing regresses.
  if (event.target.tagName === 'INPUT') return;

  const el = event.target.closest('[data-action]');
  if (!el) return;
  // Any other tap disarms a primed delete, so it can't fire later by accident.
  if (ui.confirmDeleteTask && el.dataset.action !== 'delete-task') {
    ui.confirmDeleteTask = null;
  }
  if (ui.confirmDeleteAll && el.dataset.action !== 'delete-all') {
    ui.confirmDeleteAll = false;
  }
  const action = actions[el.dataset.action];
  if (action) action(el);
}

$('app').addEventListener('click', onActionClick);
$('signin-screen').addEventListener('click', onActionClick);

// Billing settings commit on change (blur/Enter), not per keystroke, so
// re-renders never steal focus mid-typing.
$('app').addEventListener('change', (event) => {
  if (event.target.id === 'import-file-input') {
    const file = event.target.files[0];
    if (!file) return;
    importFile = file;
    ui.importFileName = file.name;
    ui.importFileSize = file.size;
    return rerender();
  }

  const key = event.target.dataset.setting;
  if (!key) return;
  // The billing rules are numbers; the Bill to name is the one text setting.
  if (key === 'clientName') {
    data.settings[key] = event.target.value.trim();
  } else {
    const value = Number(event.target.value);
    data.settings[key] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  guard(ops.saveSettings({ [key]: data.settings[key] }), 'Could not save settings');
  rerender();
});

// A click anywhere outside a popup, or Escape, dismisses it.
document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-popup]') && closePopups()) rerender();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (closePopups()) return rerender();
    // With no popup open, Escape backs out of whichever surface is on top.
    if (ui.screen === 'doc') return actions['close-doc']();
    if (ui.screen === 'settings') return actions['close-settings']();
  }
  if (event.key !== 'Enter') return;
  if (event.target.id === 'new-task-name') createTask();
  if (event.target.id === 'edit-task-name') saveTask(ui.editTask);
  if (event.target.id === 'manual-minutes') actions['log-manual']();
});

// ---------- Clock tick ----------

setInterval(() => {
  const timer = getTimer();
  if (!timer || timer.pausedAt) return;
  const clock = formatClock(Math.round(timerElapsedMs(timer, Date.now()) / 1000));
  document.querySelectorAll('[data-clock]').forEach((el) => {
    el.textContent = clock;
  });
}, CLOCK_TICK_MS);

// ---------- Startup ----------

/** Empties the in-memory data so one account's rows never show under another. */
function resetData() {
  Object.assign(data, {
    tasks: [],
    sessions: [],
    invoices: [],
    settings: { ...DEFAULT_SETTINGS }
  });
}

startFirebase({
  onData(patch) {
    Object.assign(data, patch);
    rerender();
  },
  onError(what, error) {
    flash(`${what}: ${error.message}`);
  },
  onReady() {
    if (wantSignIn) return; // the user asked for the sign-in screen; stay on it
    phase = 'ready';
    paint();
  },
  onAccount(account) {
    if (account && data.account && account.uid !== data.account.uid) resetData();
    data.account = account;

    if (!account) {
      // Signed out for real: drop the previous account's rows and offer the
      // sign-in screen. Anything else means auto-anonymous sign-in is coming.
      resetData();
      if (isSignedOut()) {
        setTimer(null);
        ui.screen = 'app';
        phase = 'signin';
        paint();
      }
      return;
    }
    rerender();
  },
  onSync(sync) {
    data.sync = sync;
    rerender();
  },
  onAuthFailed(error) {
    $('loading').textContent =
      'Could not connect: ' +
      error.message +
      ' — check that Anonymous auth is enabled in the Firebase console.';
  },
  autoSignIn: () => !isSignedOut()
});

// A signed-out reload has no auth callback to wait for.
if (isSignedOut()) {
  phase = 'signin';
  paint();
}

// The account menu's sync line ages ("just now" → "4m ago"), so it needs a
// repaint even when nothing else changes. Only while the menu is open.
setInterval(() => {
  if (ui.accountMenuOpen || ui.screen === 'settings') rerender();
}, 30000);

// `sw.js` resolves against the *document* (index.html at the root), not this
// module — so it stays a bare filename even though app.js lives in src/. The
// worker has to be served from the root to claim the whole origin as its scope.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
