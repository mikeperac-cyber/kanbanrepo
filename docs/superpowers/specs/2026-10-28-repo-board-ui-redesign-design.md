# Repo Board UI redesign — design spec

Date: 2026-10-28
Status: approved by the user, ready for implementation

## Problem

The current board (v3 app, v2-era CSS) has four structural problems:

1. A 2×2 grid with `height: 100%` cards separates the repo list from the pinned
   add-form and account note with a large dead gap, and forces the repo list to
   scroll inside a small box.
2. Every repo receives a random auto-colour, so N repos produce N hues that
   fight the four account accents. Tag chips take their colour from the host
   repo, so the same tag changes colour per row.
3. Repo rows expand everything at once — title, URL, tags, badges, checklist,
   add-task input, notes disclosure, notes editor — around 200px per repo.
4. Iconography mixes a braille `⠿` drag handle, `★`/`☆` pins, `↥`/`↧`
   archive arrows, `×` deletes and inline SVG pencil/link icons. Section labels
   bottom out at 9px.

## Decisions

| Decision | Choice |
| --- | --- |
| Board layout | 4 columns, one per account |
| Repo row density | Compact row; checklist and full notes on demand |
| Colour | Neutral rows; colour carries meaning |
| Left of window | Account sidebar (dashboard) + 4 columns |
| Pin / unpin | Header "Pinned only" filter + per-repo star |
| Repo notes | Always-visible one-line note field in every row |
| Repo details | Expand in place (accordion), one open per column |
| Sidebar click | Open that account as a full-width single-column view |

## Layout

```
grid-template-areas:
  "header  header"
  "sidebar tags"
  "sidebar board"
  "footer  footer";
grid-template-columns: 210px 1fr;
grid-template-rows: auto auto minmax(0, 1fr) auto;
```

- **Header** — brand + subtitle (short enough not to truncate), search, sort
  select with a custom chevron, "Pinned only" toggle, repo counter, theme
  toggle. Store badge appears only in Store builds.
- **Sidebar (210px)** — a `ACCOUNTS` label over an `All accounts` tile followed
  by one tile per account. A tile shows the account accent dot, the name, the
  repo count and a secondary line (`3 pinned · 1 overdue`). Counts exclude
  archived repos.
- **Two board views** — the sidebar is the navigation between them:
  - `All accounts` (the default, and the state the tile is marked in) shows the
    four columns side by side, exactly as the board looked before.
  - Clicking an account tile opens that account alone: the board collapses to a
    single grid track, the other three columns are removed from the flow, and
    the opened account's column fills the whole board area. The tile is marked
    as pressed; `All accounts` yields.
  - Clicking the open account again, or clicking `All accounts`, returns to the
    four-column view.
- **Tag bar** — spans the board area only. Neutral chips with counts; the
  active chip is filled with the accent colour.
- **Board** — four equal columns.
- **Footer** — save status, version, hint.

### Column anatomy

Fixed header (dot, name, count, Import, palette) → fixed add-URL composer at
the *top* → scrolling repo list → fixed account note. Only the repo list
scrolls.

## Repo row

Collapsed, three lines, ~62px:

```
⠿ ★ Repo Name                        ▾ ✎ ⤓ 🗑
 github.com/owner/repo #work #editor   [High][2/3][Nov 4]
 capture the API contract here…      ← one-line note input
```

- The grip, star, chevron and action buttons are 16–20px inline SVGs drawn in
  one consistent style (1.7px stroke, `currentColor`).
- Action buttons reveal on row hover and on `:focus-within`.
- The note input is borderless until hovered or focused.
- Badges: priority (`High` danger, `Medium` amber, `Low` neutral), checklist
  count, due date, overdue, archived.

### Expansion

Clicking anywhere on the row outside a control toggles an accordion panel
below it containing:

- `CHECKLIST n/m` — task rows with checkbox and delete, plus an add-task input.
- `NOTES` — a multi-line textarea.

One row per column is open at a time. Expansion state is in-memory only and
resets on reload.

### Note editing

The one-line field edits the **first line** of the note and preserves any
remaining lines; the expanded textarea edits the whole note. Both autosave.

## Colour system

- Repo rows are neutral: surface, hairline border, hover tint.
- Account accents (indigo / violet / sky / teal) identify accounts only —
  column dot, sidebar dot, focus ring, active tag chip.
- Colour otherwise carries meaning only: high priority and overdue are danger,
  medium priority is amber, a pinned star is amber.
- A repo colour set explicitly in the dialog renders as a 2px left rule on the
  row. **Behaviour change:** repos no longer receive a random auto-colour on
  creation.

## Type scale

Nothing below 10.5px. Section labels 10.5px uppercase with `.08em` tracking,
badges 10.5px, tags 11px, URL 11px, repo name 13px, note input 12px.

## Iconography

One inline SVG set: grip, star, pencil, archive, archive-restore, trash,
link, chevron, search, sun, moon, and a two-panel board glyph for the
`All accounts` tile. The braille handle, `★`/`☆`, `↥`/`↧` and `×` glyphs are
removed.

## Responsive

| Width | Layout |
| --- | --- |
| ≥1281px | Sidebar 196px + 4 columns |
| 1121–1280px | Sidebar 196px + 4 columns, tighter gutters |
| 1081–1120px | Sidebar collapses to a 58px dot-and-count rail, 4 columns |
| ≤1080px | 2 columns per row, vertical scrolling |
| <700px | Single column |

No band is allowed to cut a lane in half: every column stays fully on screen
down to the 2-column breakpoint. The single-account view overrides the board
track count at every width, so the opened account always fills the board area
edge to edge.

## Defects fixed in the same change

1. `updateTotals()` printed "12 of 11 repos" whenever *Show archived* was on.
2. The GitHub username was interpolated into the API URL without validation.
3. Every mutation re-rendered the whole board, resetting column scroll
   position and focus.
4. Account notes had no length cap.
5. The smoke suite asserted the v2 contract against a v3 app (41/67 passing).

## Not in scope

No new features, no account management, no change to the on-disk storage
format, no new dependencies.

## Test contract

`tools/smoke-test.js` is rewritten against the v3 state key and the new DOM:
sidebar tiles and counts, four columns, compact row anatomy, the one-line note
field, accordion expansion, the pinned-only filter, the all-accounts and
single-account board views, drag and drop, external link drop, tag filtering,
dialog and colour popover behaviour, reload persistence, v2/v1/prototype
migration, console cleanliness, and a screenshot of the real board.
