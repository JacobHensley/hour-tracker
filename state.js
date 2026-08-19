// state.js — in-memory UI state plus the bits that persist on this device
// (running timer, status filter, AS BILLED preview toggle).

import { TASK_STATUSES } from './billing.js';

const TIMER_STORAGE_KEY = 'hour-tracker-active-timer';
const FILTER_STORAGE_KEY = 'hour-tracker-status-filter';
const BILLABLE_STORAGE_KEY = 'hour-tracker-show-billable';

/** Popup visibility flags — at most one popup is open at a time. */
const POPUP_FLAGS = ['filterOpen', 'trackMenuOpen', 'stateMenuOpen', 'addMenuOpen', 'editTaskMenu'];

export const ui = {
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
  // Popups
  filterOpen: false,
  trackMenuOpen: false,
  stateMenuOpen: false,
  addMenuOpen: false,
  editTaskMenu: false,
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
