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

Each feedback text colour on its own background is at least 4.5:1.

### Space, radius, type, layout

- Space, 4 px grid: `--space-1` (4) `--space-2` (8) `--space-3` (12)
  `--space-4` (16) `--space-5` (24) `--space-6` (32).
- Radius: `--radius-sm` notices, `--radius-md` fields, choices and alerts,
  `--radius-lg` cards and panels, `--radius-pill` buttons and badges.
- Type: `--font-family-base` (self-hosted Noto Sans Devanagari),
  `--font-size-sm` (16 px, labels and helper text), `--font-size-body`,
  `--font-size-lg` (titles, phone numbers), `--font-size-xl` (app title);
  `--line-height-body`, `--line-height-heading`. Headings are weight 400: the
  Devanagari face ships one weight and a synthesised bold looks smeared.
- Layout: `--touch-target` (48 px), `--content-max-width`, `--shadow-card`.

## Shared controls

| Control | Class | Rule |
| --- | --- | --- |
| Panel | `.panel` | The card every voter-level surface sits in (contact panel, voter card, seen-voting control, call list): surface, hairline border, `--radius-lg`, card shadow, `--space-5` padding. |
| Panel header | `.panel-header`, `.panel-title`, `.panel-subtitle` | Title (who or what), a muted subtitle line (relative · age · house), and the close action as a quiet button on the right, above a hairline. Built by `panelHeader()` in `src/ui/dom.js`. |
| Primary button | `.btn-primary` | The one main action of a surface. Full width, pill, filled teal. |
| Secondary button | `.btn-secondary` | Other actions (retry, add, keep). Outlined. |
| Quiet button | `.btn-quiet` | Text-only: close, dismiss. |
| Quiet danger button | `.btn-quiet-danger` | Starts a destructive flow (revoke consent) without competing with the primary action; red text under a hairline. Never deletes on its own: it opens an alert. |
| Danger button | `.btn-danger` | The filled red "yes, delete" inside an alert. The only filled red. |
| Field | `.picker-field`, `.picker-label`, `.picker-select` | Label above, 48 px input. Phone numbers add `.field-phone`: larger, tabular, spaced digits. |
| Choice | `.choice`, `.choice-input` | A tappable row holding a checkbox and its sentence; turns green when checked. |
| Badge | `.badge` (+ `data-tone`) | A short state label, e.g. "consent on record". |
| Notice | `.notice` (+ `data-tone`) | The one feedback line of a surface, set with `setNotice()` in `src/ui/dom.js`. |
| Alert | `.alert` (+ `data-tone="error"`) | A block that asks before something is deleted: the consequence in body text, then the danger button and a secondary "no". |

## States every surface carries

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
