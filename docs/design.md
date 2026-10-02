# Design

Fireround has one house look and one brand rule; this page states both so a contribution lands in the same visual language. Back to the [README](../README.md).

## The house look

Paper ground, Graphite ink, solid hairline borders, Inter for text and Geist Mono for numbers, one orange moment per screen. Tokens live in `app/globals.css` and map onto shadcn's variables, light and dark. The brand is the Firecrawl flame: the sidebar carries the lit mark on its own beside the name (never boxed, never recolored), the page header carries the "Built on Firecrawl" lockup with the flame alive, and the favicon and the Open Graph card carry the same geometry. Below the desktop breakpoint the sidebar becomes a top bar with a drawer, and every table becomes cards.

## Contrast

Data meets WCAG AA; decoration may be fainter. Anything a reader reads or acts on (names, amounts, dates, descriptions, excerpts, hosts) is full ink or `muted-foreground`, and `muted-foreground` clears 4.5:1 in both themes: 5.9:1 on Paper, 6.0:1 on the card and 5.6:1 on a 4% pill in light, 6.2:1 on the popover and 6.8:1 on the page in dark. Small labels (section eyebrows, axis ticks, relative dates, "not stated", bracket tags) sit on `black-alpha-32`, which also clears AA: 4.8:1 on Paper and 4.7:1 on a pill in light, 5.0:1 on the popover and 4.9:1 on a pill in dark. They stay quieter than the data through size and case, not through failing contrast. `black-alpha-16` and `-24` are decoration only: separators, the brackets around a code, empty-bar tracks. Nothing a reader needs goes there.

The `black-alpha-*` names are Firecrawl's steps, but each resolves through an `--ink-*` variable in `app/globals.css`: Graphite in light, white in dark. A bare `text-black-alpha-32` works in both themes, so a contribution does not add a `dark:` twin for these. From `-32` up the steps sit darker than their names (32 is 66 percent Graphite, 56 matches `muted-foreground`); the ratios above are measured, so recompute them if you move a step.

An accent used as text goes through its ink token, never the swatch: `text-heat-ink`, `text-forest-ink`, `text-honey-ink`, `text-crimson-ink`. Each clears 4.5:1 on Paper and the card in both themes (Heat is 3.2:1 as text on white, Forest 2.3:1). The swatches (`bg-heat-100`, `bg-accent-forest`) stay for dots, bars and fills. A control a reader acts on (a sort header, a Report button, a "show more" toggle) is never label ink, even when it sits in a row of labels. A link inside a sentence of muted text is underlined (a faint `decoration-black-alpha-32` that goes solid on hover), so it reads as a link without leaning on colour alone.

The primary button fill is `--primary`, the orange deepened to `#d23f00` so its white label clears AA (4.7:1; the bright `#ff4c00` managed 3.3:1). The bright Heat stays for the flame, dots, bars and the one orange moment that carries no text.

## Touch targets

On a touch screen every control has at least a 44px hit area; on desktop it keeps its drawn size, so rows stay compact. Small controls (icon buttons, chips, row toggles, pager steps, standalone text links) carry the `tap` utility from `app/globals.css` with `relative`: under `pointer: coarse` an invisible `::after`, at least 44px square and centred on the control, catches the tap. It cannot help an element that clips its own overflow (`truncate`) or already uses `::after`; give those real height instead, as the search box and the Slack channel select do with `pointer-coarse:h-11`.

## Type

Inter for words, Geist Mono for figures: amounts, counts, credits, dates, ids. Uppercase mono is for short status words only, in a bracket `Tag` (`[ LEAD ]`, `[ UPDATED ]`, `[ DEFAULT ]`) or a column header. Content keeps its own case even beside a tag: hostnames, provenance ("via Alexandria"), plan text, lane names. Day headings read as words ("Today", "Yesterday", "Mon 21 Sep"), not ISO dates.

## The brand rule

The flame is never boxed and never recolored. It sits on the ground on its own, at its own colors, beside the name or inside the lockup. The mark and the lockup live in `components/brand/`; use them rather than drawing a new one.

## Where things are

- Tokens and the two themes: `app/globals.css`.
- shadcn-owned primitives: `components/ui/`.
- The flame mark and the "Built on Firecrawl" lockup: `components/brand/`.
- The favicon and the Open Graph card: `app/icon.svg`, `app/opengraph-image.tsx`.
