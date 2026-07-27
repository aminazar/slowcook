# Mock-UX doctrine (wire → mock)

*Origin: a full review pass over dash v4's ideation route. Lessons 1–5 and 8
are enforced by `checkMockUx` in packages/gates (money ranges, header-chips,
reading measure, prose inputs, orphan replies) plus the button-doctrine gate
(money inside acts). The rest ride in TELL_STEP_SYSTEM, the builder's prompt.*

## The evidence

**Method**: the same journey (`start-greenfield`: idea → shaping replies → PRD → menu)
was walked on mobile (390px) against the FIRST storyteller build of `/ideation`
(commit `76fd448`, pre-review) and against the current build (r104, after ~15
review pins), and both code versions were diffed. Screenshots:
`docs/lessons/ideation-before.png` · `docs/lessons/ideation-after.png`.
Every lesson below names its evidence — the pin that taught it and the code
that changed.

The headline: the BEFORE page was **data in rows wearing a theme**; the AFTER
page is **an app speaking in signs**. Almost every fix replaced words with a
convention the user already knows.

---

## 1 · Compact — density is a feature of respect (Amin's item)

The reviewer is on a phone. Every character owes rent.

- **Before**: `reply — or ask your own question…` as the composer placeholder;
  `est $4.10–$7.80` on every epic row; `reply est $0.12/turn` inside the button.
- **After**: placeholder `reply` (the field's shape says the rest); ONE number
  per epic at the chosen percentile (`$7.80`); the button says `reply`, the
  cost lives beside the thread (`$0.13` under the turn, `total $0.37` at foot).
- **Pins**: no.619 ("two numbers… we should have only one"), no.628
  ("the chat speaks for itself; placeholder and caption trimmed").

## 2 · Visual cues, not textual instructions (Amin's item)

If a behaviour needs a sentence, first ask whether a shape can say it.

- **Before**: the PRD's state was the word `drafting` in a chip; nothing
  suggested any interaction. Expanding didn't exist — no.634 literally had to
  ask *"how can I move on from drafting and see the final PRD?"*
- **After**: the chip **is** the toggle — dashed border while closed (the
  visual sign for "draft/openable"), solid + bold + chevron `▾/▴` when open;
  risk is a colour (red `high`, grey `low`, green `resolved`); the percentile
  chip is green/amber/red by p15/p50/p85. No sentence explains any of this.
- **Pins**: no.634 (both rounds), no.631 ("the toggle looks like one").

## 3 · Ride the user's sign literacy — honour existing visual contracts (Amin's item)

2026 users arrive trained. Breaking a learned contract costs more than any
caption can buy back.

- **Before**: the conversation was chip-labelled rows (`[you] text`,
  `[agent] text`) — a *table about* a chat. You had to read the chip to know
  the speaker.
- **After**: the AI-chat shape everyone knows — my words in brand-purple
  bubbles on the right, the agent's in green-tinted bubbles on the left;
  a growing composer with `↑` send; `📎` attaches; `✦` picks the model,
  `⚡` the effort; Enter makes a newline (the chat-app contract), the fab
  sends. None of it is explained anywhere, because none of it needs to be.
- **Pins**: no.625 ("the chat wears the familiar AI-chat shape"), no.637
  (three rounds — fabs in the box, same size as send), no.644 (monochrome
  SVG glyphs, not emoji — chrome wears the brand's line-weight).

## 4 · No redundant or useless bits (Amin's item)

- **Before**: `ep:` prefixed every epic row ("such a lazy format" — no.619);
  a `ready` chip repeated on every row saying nothing row-specific; the same
  estimate appeared as a range twice per screen.
- **After**: the deck is headed `EPICS` once; readiness collapsed to a single
  `roadmap ready` chip beside the one act it gates (`queue the roadmap`);
  each fact appears exactly once, where it is acted on.
- **Rule of thumb that emerged**: *a repeated chip is a header in disguise;
  a repeated caption is a component's missing default.*

## 5 · Money rides beside the act, never inside it (added)

The cost of an action is information *about* the act, not part of its name.
Putting it in the label makes a sentence-button and hides the verb.

- **Before**: `reply est $0.12/turn` — one button carrying verb + estimate.
- **After**: the button is the verb; the price is a `[data-price]` **sibling**.
  This became an OSS **gate** (button-doctrine, slowcook#331): money inside an
  interactive element fails the build, project-wide, forever.
- **Pin**: no.615.

## 6 · Every named state needs a door (added)

A status label with no way to see its evidence or change its value is a dead
noun — and dead nouns are what made v3 feel like a screenshot.

- **Before**: `PRD v1 [drafting]` — unopenable, unchangeable, unexplained.
- **After**: the chip opens the draft (the PRD is the session's own yield);
  `4 assumptions open` counts real rows below; each assumption resolves
  through an evidence field; the status *derives* — resolve everything and
  `draft` becomes `final` (no.634's follow-up fixed the very word).
- **Generic form**: state chips must either visibly derive from data on the
  page or open onto their evidence. Never paint a status.

## 7 · One number, one meaning — colour is the second channel (added)

Ranges force the reader to do statistics; a picked percentile with a colour
does it for them.

- **Before**: `est $4.10–$7.80` per row (which end do I trust?).
- **After**: one `p15/p50/p85` segmented toggle governs the whole deck; every
  chip shows the one number at that percentile, tinted green/amber/red so the
  optimism of the view is visible at a glance; `Σ $25.80` totals the same way.
- **Pin**: no.619 ("a toggle on top of deck… colour coded as a chip").

## 8 · Inputs shaped like their content (added)

The field's form teaches its use before any placeholder can.

- **Before**: a single-line `<input>` for a conversation.
- **After**: `RiChat` — a growing multi-line field (conversations are
  paragraphs), Enter = newline, tools riding inside the box; the evidence
  field is one line with a *content* hint (`a link, a doc, or what you
  observed`) rather than an instruction.
- **Pins**: no.622 (Enter must not send), no.616/no.637 (the field and its
  toolbelt), no.630 (the resolve field's placeholder names what evidence IS).

## 9 · Honest counters beat decorative fullness (added)

- **After** shows `0/10` orders born against promised — sparse truth, styled.
  The empty-first law means the mock earns its data by walking; a counter that
  admits "nothing born yet" is a feature, not a gap to paint over.
- **Pin lineage**: no.613/no.619 ("honestly empty while the roadmap waits" is
  itself walked copy).

## 10 · A ruling becomes a component or a gate, never a local patch (added)

Every one of the fixes above landed as a **shared thing**, so the next surface
obeys by construction: `ChatThread`, `RiChat`, `GrowText`, `EstChip`,
`BornCount`, `PctlToggle`, `EpicDeck` — and the gates (button-doctrine, voice,
wire-fidelity) hold the line mechanically. The BEFORE page was 111 lines all
inline; the AFTER page is mostly composition of rulings that other pages now
inherit for free. This is mistakes-to-safeguards applied to UX.

## 11 · The list applies to itself (standing debt)

Two grey caption sentences survive on the AFTER page — *"the founder supplies
upstream evidence…"* and *"the roadmap queues by value; the line starts on
your word."* By lessons 2 and 4 they are trim candidates: the first should
collapse into the resolve field's behaviour, the second into the `roadmap
ready` chip. Kept here deliberately as the proof that the distillation has
teeth against the current build too.
