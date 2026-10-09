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
| Card | `.card` | The panel's surface for anything that is not voter-level, e.g. a summary or a settings group. |
| Badge | `.badge` (+ `data-tone`) | A short state label, e.g. "consent on record" or "marked" in place of the seen-voting button; the success tone draws a tick. |
| Count line | `.seen-voting-count` | A muted label with a `--font-size-lg` numeral on the right, above a hairline: context under the action, never a second action. Shows a muted placeholder while counting or when the count cannot be read. |
| Status banner (notice) | `.notice` (+ `data-tone="info"`, `"success"` or `"error"`) | The one feedback line of a surface, set with `setNotice()` in `src/ui/dom.js`. A 48 px banner with a toned left edge and tint. |
| Seat header | `.seat-header`, `.seat-header-text`, `.seat-header-link` | One strip under the app header, above every screen, naming the loaded seat in body text on the surface: "पंचायत: <name> · वार्ड: <n>", or "· सभी वार्ड" for a sarpanch. With no seat it is the empty state: on the info tint, a 48 px underlined link with a teal edge that leads to the ward picker. Built by `renderSeatHeader()` in `src/ui/seatHeader.js`. |
| Alert | `.alert` (+ `data-tone="error"`) | A block that asks before something is deleted: the consequence in body text, then the danger button and a secondary "no". |

The controls `.btn-primary`, `.btn-secondary`, `.btn-quiet`,
`.btn-quiet-danger`, `.btn-danger`, `.field-input`, `.field-select`,
`.picker-select`, `.choice`, `.choice-input`, `.list-row`, `.card` and
`.notice` each set an explicit `appearance: none`, draw the focus ring on
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
