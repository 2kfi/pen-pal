# PenPal — Design Plan

> Ground truth for every visual decision in V2. Code must not invent values that live here.
> Method: plan → critique against brief → build → self-review. One bold move, everything else quiet.

---

## 1. Subject & thesis

**Subject:** a private, sealed correspondence between exactly two people.
**Audience:** two adults writing to each other deliberately, on a phone, at night.
**Primary job:** make writing feel worth the effort, and opening feel like an event.
**Anti-goal:** a social network, a feed, a dashboard, a media library.

### The one memorable thing

**The wax seal.** Every letter you send physically seals and travels. It is the only
ornament in the entire product. Everything else is paper, ink, and restraint.

If we only get one thing right, it is that a sent letter should *arrive* — not appear.

---

## 2. Anti-slop commitments

The current build fails these. They are binding.

| Rejected default | What we do instead |
|---|---|
| Every block in an identical rounded `.card` | Letters are **objects on a spine**, not a card grid. Only one card radius in the system. |
| One soft grey `rgba(0,0,0,.1)` shadow everywhere | Depth comes from **paper edges and ink weight**. Shadows only for things that physically lift. |
| Body text in monospace | **Letters are set in a reading serif.** Mono is for postmarks/data only. |
| ALL-CAPS eyebrow labels above every heading | Postmarks are the *only* uppercase, and they carry real data (date, distance). |
| `A · B · C` middle-dot meta strings | Real content: "sent 14 Mar · 2,140 km". Dots separate facts, not decorate. |
| "→" appended to every link and button | No arrow spam. Buttons say the action: **"Seal and send"**. |
| Tinted near-black `#0c0d0f`, which v0.0.2 shipped, standing in for black | Ink is genuinely dark; paper is genuinely light. We do not fake paper with dark grey. |
| Fade-and-slide-up on every section | One orchestrated moment. Motion answers *actions*, never decorates. |

---

## 3. Typography

Three families, three jobs. Self-hosted, no CDN.

| Role | Family | Use |
|---|---|---|
| **Display** | `Syne` 700/800 | App name, letter count, empty states. Used at large size only. |
| **Reading** | `Literata` 400/600, 1.7 line-height | **The letter body.** Everything the user writes or reads. |
| **Postmark** | `Space Mono` 400/700 | Dates, distances, PIDs, status chips, keyboard shortcuts. Uppercase, tracked. Never paragraphs. |

### Scale (1.200 minor third, anchored at 16px)

```
--type-xs    0.75rem   12px   postmark meta, chips
--type-sm    0.875rem  14px   secondary UI, timestamps
--type-base  1rem     16px   body minimum — never smaller
--type-md    1.2rem    19px   letter first line, card titles
--type-lg    1.44rem   23px   page titles
--type-xl    1.728rem  28px   display, empty states
--type-2xl   2.074rem  33px   single hero moment only
```

**Rules**
- Letter body: `--type-md` Literata, `line-height: 1.7`, `max-width: 62ch`.
- Measure cap: **62–68 characters.** Long lines are the fastest way to look amateur.
- Display type gets `letter-spacing: -0.02em`; postmark gets `+0.08em` uppercase.
- No third family. No variable-weight trickery. Two weights per family, ever.

---

## 4. Color

The 2026 direction (DESIGN-UPDATED.md §2) is a postal-yellow scheme applied to neutral surfaces. Reference values shipped AA failures exactly where the gate checks (§2 authorises tuning on demonstrated mismatch), so every value below is the *solved* version: same hue, checked contrast. Both themes are authored, not derived.

### Dark — reference "dark theme"
| Token | Value | Role |
|---|---|---|
| `--ink` | `#1d2028` | Page ground. |
| `--paper` | `#292d37` | Cards, sidebar rows. |
| `--paper-2` | `#303542` | Input wells. The lightest dark surface: the worst case for contrast. |
| `--rule` | `#3b404c` | Hairlines. Decorative only. |
| `--rule-strong` | `#7a8496` | Anything interactive. Clears WCAG 2.2 SC 1.4.11 at 3:1 on `--paper-2`. |
| `--accent` | `#ffc400` | Postal yellow. A **fill**, never text on the page: `#FFC400` as text on the light page would measure 1.50:1. |
| `--accent-hover` | `#ffd33d` | Hover/active on the fill. |
| `--accent-ink` | `#18243a` | The only colour allowed *on* yellow. 9.72:1. |
| `--in-transit` | `#17b3a4` | Teal — only ever means "travelling". |
| `--link` | `#7fb2ff` | Accent-coloured **text** that is not text-on-yellow. |
| `--link-hover` | `#9dbfff` | |
| `--danger` | `#ff7070` | |
| `--success` | `#62c991` | |
| `--text` | `#e7eaf0` | |
| `--text-secondary` | `#b5bac5` | |
| `--muted` | `#9aa0ac` | The lowest permitted **readable** token: 4.67:1 on `--paper-2`. The reference's `#858B98` measured 3.59:1 there and failed. |
| `--focus-ring` | `#ffc400` | Yellow works on this dark page ground (10.20:1). |

### Light — reference "light theme"
| Token | Value | Role |
|---|---|---|
| `--ink` | `#f8f8f8` | Page ground. |
| `--paper` | `#ffffff` | Cards. |
| `--paper-2` | `#ffffff` | Input wells. Same as `--paper` by the reference's own choice. |
| `--rule` | `#dedede` | Hairlines. Decorative only. |
| `--rule-strong` | `#8b8b8b` | Anything interactive. Clears SC 1.4.11 at 3:1. |
| `--accent` | `#ffc400` | Same fill as dark, per the reference. |
| `--accent-hover` | `#e9ad00` | |
| `--accent-ink` | `#18243a` | |
| `--in-transit` | `#0f766e` | |
| `--link` | `#0060cd` | **Not `#0878F9`** (the reference link measured 3.90:1 on the page and failed). |
| `--link-hover` | `#004fa8` | |
| `--danger` | `#d92d20` | |
| `--success` | `#248a57` | |
| `--text` | `#17243a` | |
| `--text-secondary` | `#686868` | |
| `--muted` | `#707070` | The reference's `#9A9A9A` measured 2.81:1 on white and failed. |
| `--focus-ring` | `#b45309` | **Not `#e9ad00`** — yellow on the near-white page is invisible; the focus indicator is re-solved per theme. |

**Contrast contract (blocking, verified in CI)**
- Body text ≥ **4.5:1**. Large text and non-text UI ≥ **3:1**.
- `--muted` is the *lowest* permitted readable token. If a design needs something dimmer, the design is wrong.
- Yellow is one of two things per screen: the primary action's fill, or the status marker *carrying* it. Never yellow text on a light surface.
- Status is never colour-only — every state chip carries a word.

### Rules
- **One radius:** `--radius: 3px`. Letters get 2px. Chips get 999px. Nothing in between.
- Accent yellow is used for **one thing per screen**: the primary action, or a single status. Never both.
- Teal means transit. Never decorative.

---

## 5. Structure

```
┌─────────────────────────────────────────────┐
│  PenPal            Letters  Rituals  You    │  ← 56px, hairline under, no shadow
├─────────────────────────────────────────────┤
│                                             │
│   ┌─ the archive ─────────────────────────┐ │
│   │                                        │ │
│   │   ● 14 Mar · 2,140 km · opened       │ │  ← postmark, mono, tracked
│   │   ┌────────────────────────────────┐   │ │
│   │   │  Dear Sam,                     │   │  ← Literata, 19px, 1.7
│   │   │                                │   │ │
│   │   │  the sea here is...            │   │
│   │   │                                │   │
│   │   │                        ◉ seal   │   │  ← wax, bottom-right
│   │   └────────────────────────────────┘   │ │
│   │                                        │ │
│   │   ● 2 Mar · 2,140 km · in transit     │ │  ← teal
│   │   ┌────────────────────────────────┐   │ │
│   │   │  still travelling…             │   │ │  ← sealed = opaque, blurred
│   │   └────────────────────────────────┘   │ │
│   │                                        │ │
│   └────────────────────────────────────────┘ │
│                                             │
│                     [ write something ]     │
└─────────────────────────────────────────────┘
```

**The spine.** A single continuous hairline runs the height of the archive. Each letter
is a node on it. This is the one idea that makes the product recognisable, and it is
recovered from the abandoned `public/style.css` — rebuilt properly, not copied.

**Letter states, as form:**
- `draft` — paper, live text, editable
- `sealed` — closed envelope glyph, content not rendered
- `in transit` — teal postmark, gentle drift animation, arrival time
- `opened` — full serif letter, wax seal bottom-right

---

## 6. Motion

One orchestrated moment; everything else answers an action.

| Moment | Motion | Duration |
|---|---|---|
| **Seal & send** | Envelope folds, wax presses down, travels off the right edge | 700ms |
| **Transit** | Slow 4px vertical drift on the in-transit node | 3s loop |
| **Letter opens** | Paper unfolds, seal cracks | 450ms |
| Everything else | 120–160ms opacity/transform on user action only | |

**Hard rules**
- `prefers-reduced-motion: reduce` → all motion collapses to a 1-frame state change. Not "shorter", *absent*.
- No scroll-triggered reveals. No entrance animations on page load.
- Nothing animates that the user did not cause.

---

## 7. Accessibility floor (blocking, not aspirational)

Target **WCAG 2.2 AA**. Non-negotiable before any step is called done.

- Every interactive element has a visible `:focus-visible` ring. **V0.0.2 has zero.**
- All targets ≥ 44×44px (WCAG 2.2 §2.5.8 Target Size, Minimum).
- Dragging (chess pieces, photo reorder) **always** has a single-pointer alternative (§2.5.7).
- `<dialog>` element for modals — native focus trap, no hand-rolled one.
- `aria-live="polite"` on the letters region and on chess turn changes.
- Full keyboard path: compose → send → read → reply → play a chess move. No mouse required.
- Skip link to the archive.
- Colour is never the sole carrier of state.
- Real landmarks: `header` / `nav` / `main` / `footer`, one `h1` per view.

---

## 8. Responsive

Mobile is the **primary** case. V0.0.2 shipped zero media queries.

| Breakpoint | Layout |
|---|---|
| `< 640px` | Single column. Bottom tab bar, 56px, safe-area padded. Archive is the whole screen. |
| `640–1024px` | Single column, wider measure, inline nav. |
| `> 1024px` | Two zones: archive rail (380px) + reading pane. Hairline divider. |

The chess board sizes to `min(100vw - 32px, 560px)` and must never scroll.

---

## 9. Components

Rebuilt from scratch. No card grid.

`Seal` · `Letter` (4 states) · `Spine` · `Postmark` · `Envelope` (compose) ·
`Chip` (status) · `Field` (label + input + error) · `RitualTile` ·
`Board` + `Piece` + `Square` (chess) · `MoveList` · `EmptyState` · `Sheet` (bottom sheet on mobile)

---

## 10. Cut from V0.0.2

- Frosted-glass sidebar (`public/style.css`)
- `NotifBell` as the literal text `Bell` + `Close` → real icon + labelled drawer
- 14 fake themes → the 2 authored themes above
- Jellyfin, MiniPlayer, `media` store → **replaced by encrypted keepsakes**
- Monospace letter body

---

## 11. Definition of design done

- [ ] Every token in §3–§4 exists in `tokens.css` and is the only source of colour.
- [ ] CI fails the build on a contrast regression.
- [ ] Zero `.card` components outside the archive.
- [ ] Archive renders correctly at 320px.
- [ ] Keyboard completes a full letter round-trip.
- [ ] `prefers-reduced-motion` verified in DevTools.