// invoice-doc.js — the client-facing invoice document: an A4 sheet built from
// the tasks on one invoice. Same rules as render.js: HTML strings only, no
// listeners, every control carries a data-action.
//
// The sheet is a true A4 box (`aspect-ratio: 210/297`) and every length inside
// it is expressed in `cqw` — percent of the sheet's own width — so the phone
// preview and the printed page are the same layout at two sizes. Nothing
// scales to fit and nothing clips: a long invoice paginates onto more sheets.

import {
  minutesFor,
  billedMinutesFor,
  amountFor,
  decimalHours,
  docDate,
  money,
  todayIso
} from './billing.js';

/** Escapes text for safe interpolation into an innerHTML template. */
function esc(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

// ---------- Pagination ----------

/**
 * Block heights, in the design's own units: the px it drew on a 362px-wide
 * sheet. Because the sheet scales uniformly, a ratio measured here holds at
 * any width — so the page can be filled without measuring the live DOM
 * (which render() has no opportunity to do: it writes innerHTML and returns).
 */
const SHEET_H = 512; // 362 × 297/210
const PAD_TOP = 26;
const PAD_BOTTOM = 30;
/** One line of slack, so a name that wraps once more than estimated — or a
 *  substituted font running long — still has somewhere to go. */
const SAFETY = 14;
const CONTENT_H = SHEET_H - PAD_TOP - PAD_BOTTOM - SAFETY;

const HEADER_H = 65; // INVOICE + number + business name
const HEADER_NO_BIZ_H = 41; // …signed out, with no name to print
const CONT_HEADER_H = 13; // continuation sheets carry the number alone
const BILL_TO_H = 49;
const TABLE_HEAD_H = 39;
const ROW_BASE = 20; // padding + rule, without the name itself
const ROW_LINE = 13.4; // one wrapped line of a task name
const TOTAL_H = 29;

/** Characters of a task name that fit on one line of the Item column. */
const NAME_CHARS_PER_LINE = 28;

/** Lines a name wraps to. An estimate, deliberately generous: a sheet that
 *  ends early reads fine, one that clips a line does not. */
function nameLines(name) {
  return Math.max(1, Math.ceil(name.length / NAME_CHARS_PER_LINE));
}

function rowHeight(line) {
  return ROW_BASE + ROW_LINE * nameLines(line.name);
}

/**
 * Splits the line items across sheets. The first sheet carries the header and
 * Bill to; every sheet repeats the table head; the total row lands on the
 * last one — and pushes a line onto a new sheet rather than overflow.
 */
function paginate(lines, hasBusinessName) {
  const pages = [];
  let rows = [];
  let used = (hasBusinessName ? HEADER_H : HEADER_NO_BIZ_H) + BILL_TO_H + TABLE_HEAD_H;

  for (const line of lines) {
    const height = rowHeight(line);
    if (rows.length && used + height > CONTENT_H) {
      pages.push({ rows, used });
      rows = [];
      used = CONT_HEADER_H + TABLE_HEAD_H;
    }
    rows.push(line);
    used += height;
  }
  pages.push({ rows, used });

  const last = pages[pages.length - 1];
  if (last.used + TOTAL_H > CONTENT_H && last.rows.length > 1) {
    const moved = last.rows.pop();
    last.used -= rowHeight(moved);
    pages.push({ rows: [moved], used: CONT_HEADER_H + TABLE_HEAD_H + rowHeight(moved) });
  }
  return pages;
}

// ---------- Content ----------

/** The name the invoice is issued under: the signed-in user's display name,
 *  the email's local part when that is empty, nothing when signed out. */
function businessName(account) {
  if (!account || account.anonymous) return '';
  const name = (account.displayName || '').trim();
  if (name) return name;
  const email = account.email || '';
  return email.includes('@') ? email.split('@')[0] : '';
}

/** The filename a download takes: `INV-0002` → `inv-0002`. */
export function docSlug(number) {
  return (
    number
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'invoice'
  );
}

/** Every value the sheet shows, derived once and shared by all its pages. */
function docModel(data, ui, account) {
  const { tasks, sessions, settings, invoices } = data;
  const invoice = invoices.find((i) => i.id === ui.bucket);
  if (!invoice) return null;

  const rate = Number(settings.rate) || 0;
  const lines = tasks
    .filter((t) => t.invoiceId === invoice.id)
    .map((task) => {
      const raw = minutesFor(sessions, task.id);
      return {
        name: task.name,
        minutes: billedMinutesFor(task, raw, settings, ui.showBillable),
        amount: amountFor(task, raw, settings, ui.showBillable)
      };
    });

  return {
    number: invoice.number,
    // A draft has no issue date yet; it reads as today until it is sent.
    issued: docDate(invoice.issued || todayIso()),
    business: businessName(account),
    client: (settings.clientName || '').trim(),
    rate: money(rate),
    lines,
    // Balance due is the invoice total, PAID or not — the document states what
    // was billed, and the SENT/PAID state lives in the app, not on paper.
    total: money(lines.reduce((sum, l) => sum + l.amount, 0))
  };
}

// ---------- Markup ----------

function sheetHeader(doc, first) {
  if (!first) return `<div class="doc-cont-number">${esc(doc.number)}</div>`;
  return `
    <div class="doc-head">
      <div class="doc-head-left">
        <div class="doc-brand">INVOICE</div>
        <div class="doc-number">${esc(doc.number)}</div>
        ${doc.business ? `<div class="doc-biz">${esc(doc.business)}</div>` : ''}
      </div>
      <div class="doc-head-meta">
        <span class="doc-meta-label">Date</span>
        <span class="doc-meta-date">${esc(doc.issued)}</span>
        <span class="doc-meta-label">Balance due</span>
        <span class="doc-meta-total">${esc(doc.total)}</span>
      </div>
    </div>
    <div class="doc-bill-to">
      <div class="doc-bill-label">Bill to</div>
      <div class="doc-bill-name">${esc(doc.client)}</div>
    </div>`;
}

const TABLE_HEAD = `
  <div class="doc-thead">
    <span class="doc-col-item">Item</span>
    <span class="doc-col-hours">Hours</span>
    <span class="doc-col-rate">Rate</span>
    <span class="doc-col-amount">Amount</span>
  </div>`;

function lineRow(line, rate) {
  return `
    <div class="doc-row">
      <span class="doc-col-item doc-line-name">${esc(line.name)}</span>
      <span class="doc-col-hours doc-num">${esc(decimalHours(line.minutes))}</span>
      <span class="doc-col-rate doc-num">${esc(rate)}</span>
      <span class="doc-col-amount doc-line-amount">${esc(money(line.amount))}</span>
    </div>`;
}

function totalRow(doc) {
  return `
    <div class="doc-total">
      <span class="doc-col-item doc-total-label">Total</span>
      <span class="doc-col-hours"></span>
      <span class="doc-col-rate"></span>
      <span class="doc-col-amount doc-total-amount">${esc(doc.total)}</span>
    </div>`;
}

function sheet(doc, page, first, last) {
  return `
  <div class="doc-sheet">
    ${sheetHeader(doc, first)}
    ${TABLE_HEAD}
    ${page.rows.map((line) => lineRow(line, doc.rate)).join('')}
    ${last ? totalRow(doc) : ''}
  </div>`;
}

/** The full-frame document surface. Returns '' when the bucket is not an
 *  invoice, which render() treats as nothing to show. */
export function docScreen(data, ui, account) {
  const doc = docModel(data, ui, account);
  if (!doc) return '';

  const pages = paginate(doc.lines, Boolean(doc.business));
  const sheets = pages
    .map((page, i) => sheet(doc, page, i === 0, i === pages.length - 1))
    .join('');

  return `
    <div class="screen-top doc-top">
      <button class="back-btn" data-action="close-doc" aria-label="Back">‹</button>
      <span class="screen-title doc-title ellip">${esc(doc.number)}</span>
      <button class="btn-download" data-action="download-doc">Download PDF</button>
    </div>
    <div class="doc-scroll">${sheets}</div>`;
}
