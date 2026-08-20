// state.js — in-memory UI state plus the bits that persist on this device
// (running timer, status filter, AS BILLED preview toggle).

import { TASK_STATUSES } from './billing.js';

const TIMER_STORAGE_KEY = 'hour-tracker-active-timer';
const FILTER_STORAGE_KEY = 'hour-tracker-status-filter';
const BILLABLE_STORAGE_KEY = 'hour-tracker-show-billable';
const SIGNED_OUT_KEY = 'hour-tracker-signed-out';

/** Popup visibility flags — at most one popup is open at a time. */
const POPUP_FLAGS = [
  'filterOpen',
  'trackMenuOpen',
  'stateMenuOpen',
  'addMenuOpen',
  'editTaskMenu',
  'accountMenuOpen'
];

export const ui = {
  screen: 'app', // 'app' | 'settings' | 'doc' — the full-frame surface over the app
  bucket: 'unbilled', // 'unbilled' or an invoice id — the only navigation state
  selected: [], // task ids ticked for billing
  statusFilter: loadStatusFilter(), // statuses visible in the task list
  showBillable: loadShowBillable(), // AS BILLED (true) / AS LOGGED preview
  trackTaskId: '', // task the timer / manual log targets
  sessionsOpen: true, // invoice sessions list expanded
  invEditOpen: false, // invoice rename/delete panel
  editSession: null, // session id being edited in the log
  editTask: null, // task id whose rename/delete editor is open
  confirmDeleteTask: null, // task id whose Delete button is armed
  newTaskOpen: false, // inline new-task creator
  toast: '',
  // Settings — Account & data
  importFileName: '', // chosen backup file, '' when none
  importFileSize: 0,
  confirmDeleteAll: false, // Delete-all armed, same pattern as task delete
  busy: '', // label of an in-flight backup/restore/delete, '' when idle
  signInConflict: '', // email whose Google account already holds its own data
  // Popups
  filterOpen: false,
  trackMenuOpen: false,
  stateMenuOpen: false,
  addMenuOpen: false,
  editTaskMenu: false,
  accountMenuOpen: false,
  statusMenuFor: null // task id whose status menu is open
};

/** Closes every open popup. Returns true if anything was open. */
export function closePopups() {
  let closed = false;
  for (const flag of POPUP_FLAGS) {
    if (ui[flag]) {
      ui[flag] = false;
      closed = true;
    }
  }
  if (ui.statusMenuFor) {
    ui.statusMenuFor = null;
    closed = true;
  }
  return closed;
}

// ---------- Timer persistence ----------

/**
 * The stored timer is `{ taskId, startedAt, pausedAt | null, pausedTotal }`.
 * elapsed = (pausedAt ?? now) - startedAt - pausedTotal. It stays
 * device-local on purpose: syncing a live clock across devices adds
 * complexity without value, and localStorage survives reloads.
 */

/** Reads the active timer, migrating the old app's `{ accumulatedMs }` shape. */
export function getTimer() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(TIMER_STORAGE_KEY));
  } catch {
    return null;
  }
  if (!stored || !stored.taskId) return null;

  if ('accumulatedMs' in stored) {
    const now = Date.now();
    const banked = stored.accumulatedMs || 0;
    const migrated = stored.startedAt
      ? { taskId: stored.taskId, startedAt: stored.startedAt - banked, pausedAt: null, pausedTotal: 0 }
      : { taskId: stored.taskId, startedAt: now - banked, pausedAt: now, pausedTotal: 0 };
    setTimer(migrated);
    return migrated;
  }
  return stored;
}

/** Saves the running timer, or clears it when passed null. */
export function setTimer(timer) {
  if (timer) {
    localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(timer));
  } else {
    localStorage.removeItem(TIMER_STORAGE_KEY);
  }
}

// ---------- Filter / preview persistence ----------

function loadStatusFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY));
    if (!Array.isArray(saved)) return [...TASK_STATUSES];
    const valid = saved.filter((status) => TASK_STATUSES.includes(status));
    return valid.length ? valid : [...TASK_STATUSES];
  } catch {
    return [...TASK_STATUSES];
  }
}

export function saveStatusFilter(filter) {
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filter));
}

function loadShowBillable() {
  return localStorage.getItem(BILLABLE_STORAGE_KEY) !== 'false';
}

export function saveShowBillable(on) {
  localStorage.setItem(BILLABLE_STORAGE_KEY, String(on));
}

// ---------- Sign-out persistence ----------

/**
 * Signing out is explicit and has to survive a reload: without this flag the
 * app would sign the user straight back in anonymously on the next load and
 * the sign-in screen would be unreachable.
 */
export function isSignedOut() {
  return localStorage.getItem(SIGNED_OUT_KEY) === 'true';
}

export function setSignedOut(on) {
  if (on) localStorage.setItem(SIGNED_OUT_KEY, 'true');
  else localStorage.removeItem(SIGNED_OUT_KEY);
}

/** Drops this device's local state. Used after Delete all data, so a wiped
 *  account doesn't come back with a timer running against a deleted task. */
export function clearLocalState() {
  for (const key of [TIMER_STORAGE_KEY, FILTER_STORAGE_KEY, BILLABLE_STORAGE_KEY]) {
    localStorage.removeItem(key);
  }
  ui.statusFilter = [...TASK_STATUSES];
  ui.showBillable = true;
  ui.selected = [];
  ui.bucket = 'unbilled';
}
