// billing.js — pure calculations and formatting. No DOM, no Firebase.

/** Editable workflow states for unbilled tasks. `Billed` is derived: a task
 *  is Billed exactly when it carries an invoiceId. */
export const TASK_STATUSES = ['Not started', 'In Progress', 'Paused', 'Complete'];

/** Fixed display order of the task list; filtering never changes it. */
export const STATUS_ORDER = ['In Progress', 'Paused', 'Not started', 'Complete'];

/** A task's effective status: locked to Billed while on an invoice, and legacy
 *  data (pre-invoice `Billed`, unknown values) mapped into today's states. */
export function normalizeStatus(task) {
  if (task.invoiceId) return 'Billed';
  if (TASK_STATUSES.includes(task.status)) return task.status;
  return task.status === 'Billed' ? 'Complete' : 'Not started';
}

// ---------- Dates ----------

/** Formats a Date as `YYYY-MM-DD` in local time (not UTC, unlike toISOString). */
export function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Returns today's date as `YYYY-MM-DD`. */
export function todayIso() {
  return toIsoDate(new Date());
}

/** `2026-08-06` → `Aug 6` */
export function shortDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}

/** `2026-08-12` → `Wed, Aug 12` */
export function longDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
}

/** `2026-08-01` → `Aug 1, 2026`. The generated invoice carries a year that
 *  `shortDate` and `longDate` both omit — a document outlives its week. */
export function docDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

// ---------- Formatting ----------

/** `95` → `1h 35m`; `120` → `2h`; `40` → `40m` */
export function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? (minutes ? `${hours}h ${minutes}m` : `${hours}h`) : `${minutes}m`;
}

/** `270` → `4.5`; `240` → `4`; `75` → `1.25`. Decimal hours for the invoice
 *  document, where `formatMinutes`' `4h 30m` would not multiply by a rate. */
export function decimalHours(totalMinutes) {
  return String(Math.round((totalMinutes / 60) * 100) / 100);
}

/** `3661` → `01:01:01` */
export function formatClock(totalSeconds) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    pad(Math.floor(totalSeconds / 3600)) +
    ':' +
    pad(Math.floor((totalSeconds % 3600) / 60)) +
    ':' +
    pad(totalSeconds % 60)
  );
}

/** `1234.5` → `$1,234.50` */
export function money(amount) {
  return '$' + amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ---------- Billing rules ----------

/** Applies the min/max billing rules to a raw minute count. Zero stays zero;
 *  `maxHours <= 0` means "no cap". */
export function clampMinutes(raw, settings) {
  const floor = (Number(settings.minHours) || 0) * 60;
  const cap = (Number(settings.maxHours) || 0) * 60;
  if (raw === 0) return 0;
  let out = Math.max(raw, floor);
  if (cap > 0) out = Math.min(out, cap);
  return Math.round(out);
}

/** Total minutes logged against one task. */
export function minutesFor(sessions, taskId) {
  return sessions.filter((s) => s.taskId === taskId).reduce((sum, s) => sum + s.minutes, 0);
}

/** Minutes a task bills for. Rules always apply on an invoice; for unbilled
 *  tasks they apply only while the AS BILLED preview is on. */
export function billedMinutesFor(task, rawMinutes, settings, showBillable) {
  if (!task.invoiceId && !showBillable) return rawMinutes;
  return clampMinutes(rawMinutes, settings);
}

/** Dollar amount a task bills for (respects the AS BILLED/AS LOGGED preview). */
export function amountFor(task, rawMinutes, settings, showBillable) {
  return (billedMinutesFor(task, rawMinutes, settings, showBillable) / 60) * (Number(settings.rate) || 0);
}

/** Dollar amount with billing rules always applied — what billing will charge,
 *  regardless of the preview toggle. */
export function ruleAmount(rawMinutes, settings) {
  return (clampMinutes(rawMinutes, settings) / 60) * (Number(settings.rate) || 0);
}

// ---------- Timer ----------

/** Elapsed milliseconds for a timer `{ startedAt, pausedAt, pausedTotal }`.
 *  While paused the clock freezes at pausedAt. */
export function timerElapsedMs(timer, now) {
  return Math.max(0, (timer.pausedAt || now) - timer.startedAt - timer.pausedTotal);
}

// ---------- Relative time ----------

/** `just now` / `4m ago` / `2h ago` / `3d ago`, for the account sync line. */
export function relativeTime(then, now = Date.now()) {
  if (!then) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** `20480` → `20 KB`. Sizes shown on the chosen backup file. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
