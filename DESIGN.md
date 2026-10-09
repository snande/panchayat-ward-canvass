# Design record

Every screen is built against this file. The tokens live in `:root` in
`styles.css`; components take every colour, space, radius and size from them
and never hard-code a value. `test/design.test.js` checks that this file and the
stylesheet agree.

The app is used outdoors, on low-end Android phones, by canvassers who read
Hindi. So: text is never below 16 px, every tap target is at least 48 px, there
is one obvious next step per surface, and every state a surface can be in has a
look of its own.

## Tokens

### Colour

| Token | Use |
| --- | --- |
| `--color-primary` | The brand teal: primary buttons, header, info notices' edge |
| `--color-primary-strong` | Pressed primary, secondary/quiet button text, big numerals |
| `--color-primary-tint` | Hover of secondary/quiet buttons, info notice and neutral badge background |
| `--color-on-primary` | Text on `--color-primary` |
| `--color-bg` | Page background, inset blocks (alert, turnout figures) |
| `--color-surface` | Cards, panels, fields |
| `--color-text` | Body text |
| `--color-text-muted` | Labels, subtitles, helper lines, disabled text |
| `--color-border` | Hairlines, card and field borders, disabled button fill |
| `--color-focus` | The 3 px focus ring on every control |
| `--color-success` | Text and edge of success notices and badges, checked choices |
| `--color-success-bg` | Background of success notices, badges and checked choices |
| `--color-danger` | Error notices, destructive actions |
| `--color-danger-strong` | Pressed danger button |
| `--color-danger-bg` | Background of error notices, alerts and danger hover |
| `--color-on-danger` | Text on `--color-danger` |

Each feedback text colour on its own background is at least 4.5:1. Body
text (`--color-text`) is at least 7:1 on `--color-bg` and `--color-surface`
in both themes, so it reads in direct sun.

### Space, radius, type, layout

- Space, 4 px grid: `--space-1` (4) `--space-2` (8) `--space-3` (12)
  `--space-4` (16) `--space-5` (24) `--space-6` (32).
- Radius: `--radius-sm` notices, `--radius-md` fields, choices and alerts,
  `--radius-lg` cards and panels, `--radius-pill` buttons and badges.
- Type: `--font-family-base` (self-hosted Noto Sans Devanagari),
  `--font-size-sm` (16 px, labels and helper text), `--font-size-body`,
  `--font-size-lg` (titles, phone numbers), `--font-size-xl` (app title);
  `--line-height-body`, `--line-height-heading`, `--tracking-digits` (the
  letter-spacing of phone numbers). Headings and numerals are weight 400: the
  Devanagari face ships one weight and a synthesised bold looks smeared.
  Symbols outside the font subset (ticks, crosses) are drawn in CSS, not typed.
- Layout: `--touch-target` (48 px), `--content-max-width`, `--shadow-card`,
  `--focus-ring-width` (3 px) and `--focus-ring-offset` (2 px).

Every colour, font size and space in a rule outside the token blocks is a
`var()` of one of these tokens, or a `calc()` of them. Only border widths
(hairlines, accent edges, drawn ticks) are literal.

### Font

The body face is `fonts/noto-sans-devanagari-subset.woff2`, committed to the
repo and loaded by the `@font-face` rule at the top of `styles.css`. Nothing
is fetched from another origin. `--font-family-base` lists the locally
installed fallbacks (Mangal, Nirmala UI, the system UI face, sans-serif),
which are used until the subset loads or for a glyph outside it.

### Themes and text size

`:root` is the light theme. The dark theme overrides only the colour tokens
and `--shadow-card`. It applies when `<html>` has `data-theme="dark"`, or when
the phone asks for `prefers-color-scheme: dark` and `<html>` is not pinned
with `data-theme="light"`. Components never branch on the theme. They read
the same tokens.

Body text is at least 16 px (`--font-size-sm` is the smallest size). Setting
`data-text-size="large"` on `<html>` raises the type scale: body 20 px,
titles 22 px, app title 28 px. Small text grows to 17 px, so a roll row's
three lines still fit its fixed height.

## Shared controls

| Control | Class | Rule |
| --- | --- | --- |
| Panel | `.panel` | The card every voter-level surface sits in (contact panel, voter card, seen-voting control, call list): surface, hairline border, `--radius-lg`, card shadow, `--space-5` padding. |
| Panel header | `.panel-header`, `.panel-title`, `.panel-subtitle` | Title (who or what), a muted subtitle line (relative · age · house), and the close action as a quiet button on the right, above a hairline. Built by `panelHeader()` in `src/ui/dom.js`. |
| Primary button | `.btn-primary` | The one main action of a surface. Full width, pill, filled teal. |
| Secondary button | `.btn-secondary` | Other actions (retry, add, keep). Outlined in `--color-primary`, `--color-primary-strong` text. |
| Quiet button | `.btn-quiet` | Text-only: close, dismiss. |
| Quiet danger button | `.btn-quiet-danger` | Starts a destructive flow (revoke consent) without competing with the primary action; red text under a hairline. Never deletes on its own: it opens an alert. |
| Danger button | `.btn-danger` | The filled red "yes, delete" inside an alert. The only filled red. |
| Text input | `.field-input` | Label above, 48 px input on the surface, `--radius-md`; dashed border when disabled. Phone numbers add `.field-phone`: larger, tabular, spaced digits. |
| Select | `.field-select` | The text input's look with a CSS-drawn chevron (the native one is removed). |
| Field (older names) | `.picker-field`, `.picker-label`, `.picker-select` | The label wrapper, the label and the input/select the existing screens use. `.picker-select` looks like `.field-input` (plus the chevron on a `<select>`). New screens use `.field-input` and `.field-select`. |
| Checkbox / toggle | `.choice`, `.choice-input` | A tappable 48 px row holding a checkbox and its sentence; turns green when checked. The checkbox is itself 48 px; its 24 px box and tick are drawn in CSS. |
| List row | `.list-row` | One tappable line of a list: at least 48 px, a hairline below, tint on hover, the focus ring drawn inside the row. |
| Navigation bar | `.nav-bar`, `.nav-item` | The frame's bottom bar, fixed to the foot of the screen on the surface above a hairline: one `.nav-item` per screen (ward roll, search, call list, polling day, SMS tally), equal widths, `--font-size-sm` muted labels; the current one (`aria-current="page"`) has a teal top edge and `--color-primary-strong` text. The frame's other slots are the seat header, `<main>` and the SEC footer. Built by `mountAppFrame()` in `src/ui/appFrame.js`. |
| Progress bar | `.progress`, `.progress-bar` | A `--space-1` high track in `--color-border` with a sliding teal bar, above the loading notice while a roll is opened, downloaded or decoded; the bar stands still under reduced motion. Built by `createWardRollScreen()` in `src/ui/wardRollScreen.js`. |
| Card | `.card` | The panel's surface for anything that is not voter-level, e.g. a summary or a settings group. |
| Badge | `.badge` (+ `data-tone`) | A short state label, e.g. "consent on record" or "marked" in place of the seen-voting button; the success tone draws a tick; the error tone marks a voter struck off the roll ("हटाया गया"). |
| Voter card fields | `.voter-roll-fields`, `.voter-roll-field`, `.voter-roll-label`, `.voter-roll-value` | The read-only roll line inside a `.panel`: one row per field, a muted `--font-size-sm` label and the value in body text; a field the entry lacks reads "—". A struck-off voter's name is struck through (`<del>`) under the error badge. No control. Built by `renderVoterCard()` in `src/card/voterCard.js`. |
| Count line | `.seen-voting-count` | A muted label with a `--font-size-lg` numeral on the right, above a hairline: context under the action, never a second action. Shows a muted placeholder while counting or when the count cannot be read. |
| Status banner (notice) | `.notice` (+ `data-tone="info"`, `"success"` or `"error"`) | The one feedback line of a surface, set with `setNotice()` in `src/ui/dom.js`. A 48 px banner with a toned left edge and tint. |
| Seat header | `.seat-header`, `.seat-header-text`, `.seat-header-link` | One 48 px strip under the app header, above every screen, naming the seat whose roll is on screen in body text on the surface: "पंचायत: <name> · वार्ड: <n>", or "· सभी वार्ड" for a sarpanch. While the stored seat is read it is the same strip, blank (`data-state="pending"`). With no seat it is the empty state: on the info tint, an underlined link with a teal edge that fills the strip and leads to the ward picker. Built by `renderSeatHeader()` in `src/ui/seatHeader.js`. |
| SEC footer | `.sec-footer`, `.sec-footer-text` | Three static lines below every screen, on the surface above a hairline, in body text (`--color-text`, `--font-size-sm`, never muted): the data source, "not an official SEC app" and "the printed roll prevails". No control, no party or candidate branding, no network; the same in every state. Built by `renderSecFooter()` in `src/ui/secFooter.js`. |
| Search screen | `.search-screen`, `.search-filters`, `.search-row` | The query box (`.field-input`) over every loaded ward, shown in every state and disabled until a roll is loaded; then a grid of `.field-select`/`.field-input` filters (ward or booth, gender, age range, tag, visit status, sort) and two `.choice` rows (has a number, not called yet). Each result is a `.list-row`: ward/serial and name, then relative · age · gender · house in muted `--font-size-sm`; the matched text is a `<mark>` on `--color-success-bg`, and the row a ward/serial jump ("3/145") lands on is selected (`aria-selected`) with a teal edge on the tint. At most 100 rows. Built by `createVoterSearchScreen()` in `src/ui/voterSearchScreen.js`. |
| Household card | `.household-card`, `.household-members` | Every voter at one house number in a `.panel`: the panel header names the house number, with the member count as its subtitle. Each member is a `<button>` `.list-row` (at least 48 px) built from the search row's lines: "क्रम" serial and name, then relative · age · gender in muted `--font-size-sm`, then the phone number and the tag and visit status as neutral `.badge`s in body text; a value that is missing reads "—". A tap only hands the member's ward and serial to the caller (`onOpenMember`). No store write, no destructive action, no network. Built by `renderHouseholdCard()` in `src/households/householdCard.js`. |
| Alert | `.alert` (+ `data-tone="error"`) | A block that asks before something is deleted: the consequence in body text, then the danger button and a secondary "no". |

The controls `.btn-primary`, `.btn-secondary`, `.btn-quiet`,
`.btn-quiet-danger`, `.btn-danger`, `.field-input`, `.field-select`,
`.picker-select`, `.choice`, `.choice-input`, `.list-row`, `.card`,
`.nav-item` and `.notice` each set an explicit `appearance: none`, draw the focus ring on
`:focus-visible`, and are at least `--touch-target` (48 px) high and wide.
`test/design.test.js` checks all three.

## States every surface carries

A surface shows one state at a time.

| State | Look |
| --- | --- |
| Loading | Info notice (teal edge, tint), actions hidden until the stored state is known. |
| Empty | Info notice saying there is nothing yet and what brings something. |
| Success | Success notice (green) saying what happened and where it went (this phone, then the team). |
| Error | Error notice (red) saying what failed and what to do; the typed input stays. A retry is a secondary button. |
| Busy | `aria-busy="true"` on the panel: its buttons dim and cannot be tapped twice. |
| Disabled | Field with dashed border; primary button in `--color-border` with muted text. |
| Destructive confirm | Alert in the danger tone; nothing is deleted until its danger button is tapped. |
| Focus | 3 px `--color-focus` ring, 2 px offset, on every control. |

An empty notice takes no space.

The ward-roll screen (`src/ui/wardRollScreen.js`), the frame's default screen,
carries these as one `state` field: empty (info notice: pick a ward), loading
(progress bar and info notice), filled (the roll's `.list-row` lines) and
error (error notice saying what to do, a line saying whom to call, and a
secondary retry).

The search screen (`src/ui/voterSearchScreen.js`) carries the same field:
empty (info notice: load a ward's roll first), loading (progress bar and
info notice, while a roll opens or a ticked has-number/not-called box waits
for its lookup), filled (result rows), no results (info notice: change the
spelling or clear a filter) and error (error notice saying what to do and a
line saying whom to call: a ward/serial jump to a voter who is not loaded or
is hidden by a filter, or a minimum age above the maximum). If the number
and call lookups cannot be read, those two boxes are disabled under a line
saying what to do and whom to call.

The household card (`src/households/householdCard.js`) carries the same
field: loading (info notice while every member's number, tag and visit
status are read; the panel is `aria-busy`), empty (info notice: no house with
that number in the loaded ward; check the number or load the right ward),
success (the member rows) and error (error notice saying what to do, a line
saying whom to call, and a secondary retry).
