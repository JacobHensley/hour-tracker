# Handoff: Hour Tracker + Invoicing (mobile)

## Overview
A single-page mobile app for a solo contractor/freelancer: track time against tasks, apply billing rules, and package unbilled tasks onto invoices. Everything lives on one scrolling screen; a horizontal chip rail at the top switches which "bucket" you are viewing (Unbilled, or a specific invoice). There is no bottom tab bar.

## About the Design Files
`Hour Tracker Charcoal.dc.html` is a **design reference created in HTML** — a working prototype showing intended look and behavior, not production code to copy directly. It uses an in-house HTML component runtime (`support.js`) that will not exist in your codebase; ignore its conventions (`<sc-for>`, `<sc-if>`, `{{ }}` holes, `renderVals()`).

The task is to **recreate this design in the target codebase's existing environment**: plain HTML, CSS, and vanilla JS, with Firebase as the backend. No framework, no build step assumed. The prototype's logic class is readable JavaScript and is a good spec for behavior — port the rules, not the runtime.

Notes for a vanilla implementation:
- The prototype styles everything inline because its runtime requires it. **Do not copy that.** Lift the values below into CSS custom properties in one `:root` block and write normal classes.
- Structure as one `index.html`, a stylesheet, and a few JS modules (e.g. `state.js`, `render.js`, `billing.js`, `firebase.js`). Keep the pure calculations (`clampMinutes`, `billedMinutesFor`, `amountFor`, effective rate) in their own module — they are the part worth unit-testing.
- Rendering: a single `render()` that rebuilds the scroll body from state is simple and fast enough at this scale. Keep the timer's 200ms tick updating only the clock text nodes, not the whole tree, so open popups and input focus survive.
- Popups can be plain absolutely-positioned `<div>`s toggled with a class, or `<dialog>`/`popover` if you want native outside-click and Escape handling for free (the prototype implements neither).

To view the prototype: open the `.dc.html` file in a browser (keep `support.js` beside it). All state is in-memory; a reload resets to seed data.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and radii are final and exact. Recreate pixel-for-pixel where the target platform allows. All layout is inline-styled; there is no stylesheet or token file to import — the tables below are the source of truth.

Design canvas: 390 × 844 (iPhone-class). The prototype renders this frame centered on a dark page; in the real app the frame content **is** the app.

---

## Data model

```
Task     { id, name, status, invoiceId | null }
Session  { id, taskId, date (YYYY-MM-DD), minutes }
Invoice  { id, number, issued: date | null, paid: boolean }

Settings { rate: number ($/hr), minHours: number, maxHours: number }
```

- A task belongs to at most one invoice. `invoiceId === null` means unbilled.
- Sessions belong to tasks, never directly to invoices. An invoice's sessions are derived: all sessions of the tasks on it.
- `status` ∈ `Not started | In Progress | Paused | Complete` for unbilled tasks. When a task is billed its status is forced to `Billed` (a locked, non-editable state).

### Derived values
```
minutesFor(task)        = sum of session.minutes for that task
clampMinutes(raw)       = raw === 0 ? 0 : min(max(raw, minHours*60), maxHours*60), rounded
                          (maxHours <= 0 means "no cap")
billedMinutesFor(task)  = task.invoiceId ? clampMinutes(raw)
                          : showBillable ? clampMinutes(raw) : raw
amountFor(task)         = billedMinutesFor / 60 * rate
```
**Billing rules always apply to tasks on an invoice.** The AS BILLED / AS LOGGED toggle only affects the preview of *unbilled* tasks.

---

## Screens / Views

The page is one column, 390 wide, `background #151517`. Vertical structure:

1. **Header** (fixed, `padding 18px 18px 0`)
2. **Chip rail** (horizontal scroll, hidden scrollbar)
3. **Scroll body** (`flex:1`, `overflow-y:auto`, `padding 0 18px 18px`) — content depends on selected bucket
4. **Bottom slot** (`padding 0 18px`) — bill bar OR running-timer bar, or nothing
5. 22px bottom spacer

### Header
- Title `Hours` — 22px / 800 / -0.02em / `#f4f4f6`
- Right: today's date, e.g. `Wed, Aug 12` — 12px / 500 / `#85858f`
- Row is `display:flex; align-items:baseline; justify-content:space-between; margin-bottom:14px`

### Chip rail
`display:flex; gap:8px; overflow-x:auto; padding-bottom:14px`, scrollbar hidden.

Chips, in order: `Unbilled · <count>`, one per invoice (`INV-0002`, `INV-0001 ✓` — the ✓ suffix marks paid), then `+ New`.

| state | background | color | weight |
|---|---|---|---|
| active | `#a78bfa` | `#1b1b1f` | 800 |
| inactive | `#212124` | `#9d9da8` | 600 |
| `+ New` | `#212124` | `#a78bfa` | 600 |

All chips: `padding 9px 15px; border-radius 14px; font-size 12px; flex:none`.

`+ New` creates a draft invoice (`INV-000N`, N = invoices.length + 1) and selects it.

---

### View A — Unbilled (default bucket)

#### 1. Timer card
`padding 22px 20px; border-radius 24px; background #1c1c1f; margin-bottom 14px; text-align center`

- Caption: `TRACKING` (running) / `PAUSED` / `TIMER` (idle) — 11px / 700 / 0.12em. Color `#a78bfa` when running, else `#85858f`.
- Clock `HH:MM:SS` — 44px / 800 / -0.03em / tabular-nums. `#f4f4f6` running, `#85858f` otherwise. Margin `8px 0 12px`.
  - Ticks every **200ms** (not 1s) so pausing freezes on the true value with no visible jump.
  - Displayed seconds = `Math.round(elapsed / 1000)`.
- Task selector: full-width button, `padding 12px 34px; border-radius 14px; font-size 14px / 600`, label centered, caret `▾` absolutely positioned `right:14px`, 16px, opacity .6.
  - Enabled: bg `#26262b`, text `#f4f4f6`, cursor pointer. **Disabled while a timer exists**: bg `#212124`, text `#9d9da8`, cursor default.
  - Opens the standard popup (see Popup pattern) listing unbilled tasks; current one carries a lilac ✓.
- Toast slot (only when a message is set): `margin-top 12px; padding 9px 12px; border-radius 12px; background #26262b; color #c4b1ff; 12px / 600`. Auto-clears after 2600ms.
- Button row, `display:flex; gap:10px; margin-top:12px`:
  - **Pause / Resume** — only rendered when a timer exists. `flex:1; padding 14px; border-radius 16px; background #26262b; color #d5d5dd; 14px / 700`.
  - **Start / Stop & log** — `flex:2; padding 14px; border-radius 16px; 14px / 800`. Idle: bg `#a78bfa`, text `#1b1b1f`. Running: bg `#2f2f35`, text `#f4f4f6`.

**Timer semantics**
- Model: `{ taskId, startedAt, pausedAt | null, pausedTotal }`; `elapsed = (pausedAt ?? now) - startedAt - pausedTotal`.
- Resuming adds `now - pausedAt` to `pausedTotal` and **also refreshes the `now` sample in the same update** (otherwise the clock visibly dips).
- Stop & log always logs, even from a paused state (it never resumes).
- `elapsed < 60000` → discard, toast `Under 1 minute — session discarded.`
- Otherwise log `Math.round(elapsed / 60000)` minutes, toast `<duration> logged to <task name>.`

#### 2. Manual log row
`display:flex; align-items:center; gap:8px; padding 12px 14px; border-radius 18px; background #1c1c1f; margin-bottom 20px`
- Label `Log manually` — 12px / 600 / `#85858f`
- Number input, `flex:1; padding 10px 12px; border-radius 12px; background #26262b; color #f4f4f6; 14px / 600`
- **Log** button — `padding 10px 16px; border-radius 12px; background #2b2440; color #c4b1ff; 13px / 700`. Rejects < 1; toasts the same "logged to" confirmation.

#### 3. Unbilled summary card
`padding 20px; border-radius 24px; background #1c1c1f; margin-bottom 18px`
- Top row: `UNBILLED` (11px / 700 / 0.1em / `#85858f`) and the rate field on the right — `$` + number input (`width 44px; padding 3px 5px; border-radius 8px; background #26262b; color #c4b1ff; 11px / 700; text-align right`) + `/hr`.
- Total — 36px / 800 / -0.03em / `#f4f4f6`, `margin-top 6px`.
- Meta — 12px / 500 / `#85858f`: `3 tasks · 10h 55m logged → 16h billable @ $85.00/hr`. The `→ X billable` clause only appears when the clamped total differs.
- **Billing rules block** — `margin-top 14px; padding-top 14px; border-top 1px solid #26262b`, column, `gap 10px`:
  - Row 1: caption `BILLING RULES` (10px / 700 / 0.1em / `#6f6f79`) + right-aligned toggle button `AS BILLED` / `AS LOGGED` (`padding 4px 10px; border-radius 999px; 10px / 800`). Active (AS BILLED): bg `#a78bfa`, text `#1b1b1f`. Inactive: bg `#26262b`, text `#9d9da8`.
  - Row 2: `min [__]h` and `max [__]h`, `gap 14px`. Inputs identical to the rate input.
- **Status bar** — `margin-top 14px; height 8px; border-radius 999px; background #2a2a2e; overflow hidden; display flex`. Three segments by share of unbilled minutes: In Progress + Complete → `#a78bfa`; Paused → `#5f5b78`; remainder → `#33333a`.

#### 4. Tasks
Section header row: `TASKS` (11px / 700 / 0.1em / `#85858f`) on the left; on the right, the selection count (`tap to select` / `n selected`, 12px / 600, `#6f6f79` → `#c4b1ff` when non-zero) and a **Filter** chip.

**Filter chip + popup.** Chip: `padding 5px 11px; border-radius 999px; 11px / 700`. Unfiltered: `Filter`, bg `#212124`, text `#9d9da8`. Filtered: `Filter · n`, bg `#2b2440`, text `#c4b1ff`. Popup (196px, anchored `top:32px; right:0`) lists the four statuses with a checkbox (18px, `border-radius 5px`, 2px border `#3a3a42`; checked fills `#a78bfa` with a `#1b1b1f` ✓), the status name (13px / 600 / `#e6e6ec`), and the count of unbilled tasks in that status (12px / 600 / `#85858f`). Footer button **Show all** (`border-top 1px solid #2f2f35; color #c4b1ff; 12px / 700`) resets the filter.

**Sort order is fixed:** In Progress → Paused → Not started → Complete. Filtering hides statuses but never changes the order. Empty result: `No tasks match this filter.` (13px / `#85858f`).

**Task card.** `<li>`, `padding 15px; border-radius 20px`. Background `#1c1c1f`, or `#221f2e` when selected. No left accent bar.
- Row: `display:flex; align-items:flex-start; gap:12px`.
- Checkbox button — 22px square, `border-radius 7px`, 2px border `#3a3a42`, transparent. Selected: bg + border `#a78bfa`, `#1b1b1f` ✓, 12px / 800. Toggles selection.
- Right column (`flex:1; min-width:0`):
  - Name — 15px / 700 / line-height 1.3 / `#f4f4f6`, `margin-bottom 10px`.
  - Bottom row, space-between:
    - **Status pill** (opens the status popup) — `padding 5px 11px; border-radius 999px; 11px / 700`, label + 12px caret at opacity .7.
    - Hours + amount — `gap 8px`, 13px / 500 / `#85858f`. When clamped, the logged figure is `line-through` and a lilac (`#c4b1ff`, 12px / 700) `→ 4h` follows it. Amount is 13px / 700 / `#f4f4f6`.

**Status colors**

| status | pill bg | pill text |
|---|---|---|
| Not started | `#26262b` | `#9d9da8` |
| In Progress | `#2b2440` | `#c4b1ff` |
| Paused | `#26262b` | `#a5a0c0` |
| Complete | `#1b3330` | `#6fd9b9` |
| Billed (locked) | `#2b2440` | `#c4b1ff` |

**Status popup**: 172px, anchored `top:30px; left:0`. Rows = 8px dot in that status's text color, label (13px / 600; `#f4f4f6` if current else `#c6c6d0`), lilac ✓ on the current one. Picking sets the status and closes.

#### 5. Session log
Header `SESSION LOG` (11px / 700 / 0.1em / `#85858f`), `margin-top 22px`.

Grouped by date, newest first. **Only sessions belonging to unbilled tasks appear here** — billed sessions live on their invoice.

Per day: header row with `Wed, Aug 12` (12px / 700 / `#d5d5dd`) and the day total (12px / 600 / `#85858f`), `padding 0 2px 8px`. Rows in a `gap:8px` column.

**Session row.** `border-radius 16px`, bg `#1c1c1f` (`#221f2e` while being edited). Tap the row to expand its editor.
- Collapsed: task name (14px / 600, ellipsis) left, duration (13px / 600 / `#85858f`) right, `padding 12px 14px`.
- Expanded editor, `padding 0 14px 14px`:
  - **Move to task** trigger — full width, `padding 10px 12px; border-radius 12px; background #26262b; 12px / 600; color #c6c6d0`, with a 14px caret. Opens a popup (`top:44px`, full width) of unbilled tasks; picking reassigns the session.
  - Row (`gap 8px; margin-top 8px`): minutes number input (`flex:1`, styled like the manual-log input, 13px), the label `min` (11px / 600 / `#85858f`), **Delete** (`padding 10px 12px; border-radius 12px; background #332126; color #f0899a; 12px / 700`), **Save** (`padding 10px 14px; border-radius 12px; background #a78bfa; color #1b1b1f; 12px / 800`).
  - Save rejects < 1 with toast `Enter at least 1 minute.`; success toasts `Session updated to <duration>.` Delete toasts `Session deleted.`
  - Known gap: toasts render in the timer card at the top, so they are off-screen when editing a session far down the log. Consider a bottom-floating toast in the real implementation.

---

### View B — Invoice bucket

#### Invoice summary card
`padding 20px; border-radius 24px; background #1c1c1f; margin-bottom 18px`
- Row 1: invoice number (15px / 800 / `#f4f4f6`) + **Edit** chip (`padding 3px 9px; border-radius 999px; background #26262b; color #9d9da8; 11px / 700`); on the right the **state dropdown**.
- **State dropdown** — pill with a 13px caret, `padding 4px 10px; border-radius 999px; 10px / 800 / 0.08em`:

  | state | bg | text |
  |---|---|---|
  | DRAFT | `#2f2f35` | `#c6c6d0` |
  | SENT | `#2b2440` | `#c4b1ff` |
  | PAID | `#a78bfa` | `#1b1b1f` |

  Popup (150px, `right:0`) lists DRAFT / SENT / PAID. Picking writes: DRAFT → `issued=null, paid=false`; SENT → `issued=issued||today, paid=false`; PAID → `issued=issued||today, paid=true`.
- **Edit panel** (toggled by the Edit chip): `margin-top 12px; padding-top 12px; border-top 1px solid #26262b`. Text input for the invoice number (`flex:1`), **Delete** (coral, same style as the session Delete), **Save** (lilac). Helper line below: `Deleting returns its tasks to unbilled.` (11px / 500 / `#6f6f79`). Delete clears `invoiceId` on its tasks, sets them to `Complete`, and navigates back to Unbilled with a toast. Empty name is rejected (`Invoice needs a number.`).
- Total — 36px / 800 / -0.03em.
- Meta — 12px / 500 / `#85858f`: `2 tasks · 4h logged → 8h billable · issued Aug 6`.
- **Effective rate** row — `margin-top 12px; padding-top 12px; border-top 1px solid #26262b`, space-between. Caption `EFFECTIVE RATE` (10px / 700 / 0.1em / `#6f6f79`); value = invoice total ÷ hours *actually logged*, 14px / 800. `#6fd9b9` when ≥ the set rate, `#f0899a` when below. Hidden when the invoice has no logged minutes.

#### Tasks on this invoice
Header `TASKS ON THIS INVOICE`. Cards `padding 15px; border-radius 20px; background #1c1c1f`, name on its own line, then a row with the locked `Billed` pill, the hours (with the same struck-through → billable treatment), the amount, and an `✕` remove button (`color #6f6f79`, 13px) that returns the task to unbilled. Empty: `No tasks yet — add one below.`

**+ Add unbilled task** — full-width dashed button (`padding 13px; border 1px dashed #33333a; border-radius 18px; color #9d9da8; 13px / 600`). Opens a full-width popup listing unbilled tasks with their logged hours on the right (12px / 600 / `#85858f`). Empty: `Nothing unbilled left.`

#### Sessions on this invoice
Header row with a **Hide / Show** toggle chip (`padding 3px 9px; border-radius 999px; background #212124; color #9d9da8; 11px / 700`). Open by default. Rows: date (50px column, 11px / 600 / `#6f6f79`), task name (13px / 500), duration right (13px / 600 / `#85858f`), separated by `border-bottom 1px solid #232327`. These are read-only.

There are **no action buttons at the bottom** of the invoice view — state is changed via the dropdown.

---

### Bottom slot (both views)

Mutually exclusive, in priority order:
1. **Bill bar** — shown on Unbilled when ≥1 task is selected. Full-width button, `padding 14px; border-radius 20px; background #a78bfa; color #1b1b1f; 14px / 800`. Label: `Bill 2 tasks · $680.00` — the amount **always** has billing rules applied, regardless of the AS LOGGED toggle.
2. **Running-timer bar** — shown only when a timer exists. `padding 12px 14px; border-radius 20px; background #1c1c1f`, space-between: left = caption (`TRACKING`/`PAUSED`, 10px / 800 / 0.12em) over the task name (13px / 600, ellipsis); right = clock (18px / 700 / tabular-nums) + a 44px round stop button (bg `#a78bfa`, text `#1b1b1f`, `■`).
3. Nothing.

**Billing action.** Billing the selection assigns those tasks to the active invoice bucket. If the current bucket is Unbilled, or the active invoice is already issued or paid, a new draft invoice is created and selected instead. Billed tasks get `status = 'Billed'` and disappear from the unbilled list, taking their sessions out of the session log.

---

## Popup pattern (used by every dropdown)
```
position: absolute; z-index: 30;
padding: 8px; border-radius: 16px;
background: #24242a; box-shadow: 0 14px 34px rgba(0,0,0,.55);
```
Rows: `width:100%; display:flex; align-items:center; gap:9px; padding:8px–9px; border-radius:10px; background:transparent; text-align:left`. Selected row's label is `#f4f4f6`, others `#c6c6d0`; the current choice carries a lilac (`#a78bfa`) ✓ at 11px / 800.

Only one popup is open at a time in the prototype (each is its own state flag). In production, closing on outside-click / Escape is expected — the prototype does not implement it.

---

## State summary

| key | purpose |
|---|---|
| `bucket` | `'unbilled'` or an invoice id — the only navigation state |
| `tasks`, `sessions`, `invoices` | data (→ Firestore collections) |
| `rate`, `minHours`, `maxHours` | billing settings (→ a user settings doc) |
| `showBillable` | AS BILLED / AS LOGGED preview toggle |
| `selected[]` | task ids selected for billing |
| `statusFilter[]` | visible statuses |
| `timer` | `{taskId, startedAt, pausedAt, pausedTotal}` or null |
| `now` | clock sample, refreshed every 200ms while running |
| `trackTaskId` | task chosen for the next timer run |
| `manualMinutes`, `editSession`, `editMinutes`, `invNumberDraft` | form drafts |
| `filterOpen`, `statusMenuFor`, `trackMenuOpen`, `stateMenuOpen`, `addMenuOpen`, `invEditOpen`, `editTaskMenu` | popup visibility |
| `toast` | transient message, cleared after 2600ms |

### Firebase notes
- `tasks`, `sessions`, `invoices` map cleanly to collections; keep `invoiceId` on the task, not a subcollection, so unbilled queries stay a single `where('invoiceId', '==', null)`.
- Settings (rate, min, max) belong on the user doc — they are global and affect every calculation.
- **A running timer should be persisted** (start timestamp + accumulated pause), not held in memory, so closing the app doesn't lose it. The prototype loses it on reload.
- All money is derived at read time from sessions + settings; nothing is stored denormalized. If you want historical invoices to be immutable, snapshot `rate`/`minHours`/`maxHours` onto the invoice at billing time — the prototype does not, so editing the rate retroactively changes issued invoices.
- Use the Firebase JS SDK via the modular ESM CDN build (`import { getFirestore } from 'https://www.gstatic.com/firebasejs/<version>/firebase-firestore.js'`) so no bundler is needed. Subscribe with `onSnapshot` and let each snapshot drive `render()` — that keeps state one-directional without a framework.

---

## Design tokens

**Color**

| token | hex | use |
|---|---|---|
| page | `#151517` | app background |
| surface | `#1c1c1f` | cards, rows |
| surface raised | `#24242a` | popups |
| surface input | `#26262b` | inputs, secondary buttons |
| surface chip | `#212124` | inactive chips |
| divider | `#26262b` / `#232327` / `#2f2f35` | card rules / list rules / popup rules |
| text primary | `#f4f4f6` | |
| text secondary | `#c6c6d0` / `#d5d5dd` | popup rows, button labels |
| text muted | `#85858f` | meta |
| text faint | `#6f6f79` | captions |
| accent | `#a78bfa` | actions, active state |
| accent soft bg | `#2b2440` | lilac pill backgrounds |
| accent soft text | `#c4b1ff` | lilac pill text |
| accent muted | `#5f5b78` | paused bar segment |
| success | `#6fd9b9` on `#1b3330` | Complete, good effective rate |
| danger | `#f0899a` on `#332126` | destructive, poor effective rate |
| track empty | `#2a2a2e` / `#33333a` | progress bar |
| border subtle | `#3a3a42` / `#33333a` | checkbox, dashed button |

**Typography** — Plus Jakarta Sans (400/500/600/700/800), Google Fonts.

| role | size / weight |
|---|---|
| screen title | 22 / 800, -0.02em |
| clock | 44 / 800, -0.03em, tabular |
| money total | 36 / 800, -0.03em |
| card title | 15 / 700 |
| body / row | 13–14 / 500–600 |
| section caption | 11 / 700, 0.1em, uppercase |
| micro caption | 10 / 700, 0.1–0.12em, uppercase |

**Radius** — 24 cards · 20 task cards & bottom bars · 18 dashed/manual rows · 16 popups & session rows · 14 chips & primary inputs · 12 small inputs & buttons · 10 popup rows · 999 pills.

**Spacing** — page gutter 18; card padding 15–22; gaps 8 / 10 / 14; section top margin 20–22.

**Shadow** — popups only: `0 14px 34px rgba(0,0,0,.55)`.

**Motion** — none beyond the 200ms clock tick and the 2600ms toast lifetime. No transitions were designed; add restrained ones (120–160ms) if your system expects them.

## Assets
None. No images, no icon set — carets (`▾`), checks (`✓`), the stop glyph (`■`) and `✕` are text characters. Substitute your icon library's equivalents.

## Files
- `Hour Tracker Charcoal.dc.html` — the design, both views, all behavior
- `support.js` — runtime needed only to open the prototype in a browser; do not port
