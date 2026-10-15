# PenPal: Design Direction

> This file is the **soul**. `docs/DESIGN.md` is the **spec**: tokens, type scale, motion table, accessibility floor. Never put an implementation value here. Never put a feeling there.
>
> Read direction here, then spec, then write code. If the two ever disagree, the spec wins for values and this file wins for intent, and the disagreement gets fixed in writing, not in a component.

## Design Read

Reading this as: **a private correspondence app for two adults writing to each other at night on a phone**, in a **paper-and-ink language that is quiet everywhere except one moment**, dials **ENERGY 2 / RHYTHM 2 / MOTION 2**.

## Identity

**Two people. One sealed channel. Slow on purpose.**

In every other app you use, latency is a defect to be engineered away. Here it is the product. A letter cannot be opened early. It cannot be edited after it is sent. It travels. That constraint is not a limitation we apologise for, it is the reason anybody opens this instead of a chat app.

Every design decision below descends from one sentence: **make the wait feel worth it.**

If a change makes the product faster but makes someone feel less anticipation, it is the wrong change.

## The one memorable thing

**The wax seal.**

A sent letter physically folds, presses, and leaves. It is the only ornament in the entire product. Everything else is paper, ink, and restraint.

We get one bold gesture. Spending it twice would make it noise. When a screen has a seal and a primary button, one of them loses.

## Personality

Each pair names what we are and what we refuse, because a word alone does not constrain anything.

| We are | We are not |
|---|---|
| **Quiet** | Shy. Quiet is a volume setting. Shy is an apology. |
| **Deliberate** | Slow-witted. Deliberate is a choice. Slow-witted is a defect. |
| **Physical** | Skeuomorphic. Paper texture and a wax press, never a fake desk or a fake envelope flap that curls wrong. |
| **Intimate** | Cute. Two adults, not a couple of cartoon animals. No mascots, no hearts, no exclamation marks. |
| **Honest** | Austere. Honest admits what the product cannot do. Austere hides it. |
| **Warm** | Cosy. Warm is a palette. Cosy is a genre. |

## Palette

Per WCAG and good sense: **two neutrals plus one accent**, with two reserved status colours that are not decoration and never compete with the accent.

| Token | Role | Why this and not another |
|---|---|---|
| `--ink` | The ground | Genuinely dark in the dark theme, genuinely light in the light theme. v0.0.2 faked paper with tinted near-black `#0c0d0f`. Paper has a colour. Paper is warm. |
| `--paper` / `--paper-2` | Raised surfaces | Two levels, because an input well needs to read as a well and a card needs to read as a card. |
| `--wax` | **The one accent.** The seal, or the primary action | Amber because sealing wax has been amber for as long as there has been sealing wax to colour. Not a brand colour, a material colour. Anything else is decoration pretending to be meaning. |
| `--text` / `--muted` | Words | `--muted` is the **lowest** value permitted. If a design needs something dimmer, the design is wrong, not the token. |
| `--in-transit` | **Means one thing: travelling** | Teal is not decorative. If teal appears anywhere that is not a letter in motion, it is a bug. |
| `--danger` | Destructive and error only | Nothing else may use it. |

Both themes are **authored**, not derived by inverting the other. A computed light theme always lands in the wrong place on the contrast scale.

**Contract, verified in CI:** body text at or above 4.5:1, non-text UI at or above 3:1, on every surface a token is actually painted on. `--paper-2` is the lightest dark surface, so it is the worst case for every foreground, and it is checked explicitly. A token that passes on the page and fails in a field is a failure.

**Status is never colour alone.** Every state carries a word. Teal plus the word "travelling", never teal on its own.

## Typography

Three families, three jobs, two weights each, self-hosted, no CDN. A letter-writing app that phones a font server on every read has missed the point.

| Role | Family | Why |
|---|---|---|
| **Display** | `Syne` | A geometric display face with slightly awkward, deliberate letterforms. The app's name should not be set in the same neutral grotesque as every dashboard. Large sizes only, never a label. |
| **Reading** | `Literata` | Drawn for long-form on screen. **The letter body is the product.** Every word a person writes or reads is set here, at a comfortable measure and generous leading. A tool that renders love letters in 12px UI sans has told you what it thinks of them. |
| **Postmark** | `Space Mono` | This is the one that usually gets called out as an AI default. Here it earns its place: **a postmark is the single machine-made object in a paper world.** It stamps facts, never prose. Uppercase and tracked, and it is allowed to be, because it is imitating rubber type. |

No fourth family. No variable-weight tricks. Body copy never in mono, ever.

## Mood

**A desk at night, or a letter on a table at morning.** Warm ground, low light, nothing glowing, nothing urgent. The interface should feel like it is waiting for you, and not like it is waiting on a server.

Dark is the default and that is a decision, not a trend. This product is used at night, by two people, alone. The dark theme is authored first and the light theme is the alternative, not the other way around. Both must be good enough to ship on their own.

## Dials

| Dial | Value | What that commits us to |
|---|---|---|
| **ENERGY** | **2** | We say hello exactly once per screen, in the seal. Everything else holds its voice down. |
| **RHYTHM** | **2** | One consistent shell, and screen compositions that genuinely differ by job: a spine for the archive, a single measured column for reading, a grid for the calendar, a square for the board. Not one template stretched four ways. |
| **MOTION** | **2** | One orchestrated moment and nothing decorative. |

**The one permitted loop.** A letter in transit drifts, slowly, for as long as it is travelling. This is the single exception to "nothing loops forever", and the reason is written down: the drift *is* the state, not an indicator for it. It stops the moment the letter is opened. If it were a spinner it would be noise; because it is the product's central concept made visible, it is the interface.

Everything else answers an action the person took. Nothing animates on page load. No scroll reveals.

With `prefers-reduced-motion`, motion does not shorten. It does not happen.

## The swap test

> If the logo and the name were swapped for another product's, would this still feel like itself?

The spine would not survive. Neither would the fact that the accent is amber because wax is amber, that the reading face is chosen because the product is prose, or that the app is willing to be slow. That is the test, and it is why we can be confident the direction is real rather than decoration on a template.

## What we refuse

Binding. These are not preferences, they are the shape of the product.

| We refuse | Because |
|---|---|
| A card grid where letters belong | Letters are objects on a **spine**, a continuous line with each letter as a node. This is the one idea that makes the product recognisable. It came from a stylesheet v0.0.2 abandoned, rebuilt rather than copied. |
| Shadows on everything | Depth comes from paper edges and ink weight. Only something that physically lifts earns a shadow. |
| An uppercase label above every heading | **Postmarks are the only uppercase**, and they carry real data: a date, a distance, a state. |
| Middle dots as decoration | Dots separate real facts ("sent 14 Mar, 2,140 km"). A dot with nothing between it is a bullet point in disguise. |
| Arrows on buttons | Buttons say the action. "Seal and send", not "Send →". |
| Motion on load, scroll reveals, confetti | A sent letter should arrive, not appear. Same logic: nothing celebrates that the person did not cause. |
| Streak pressure, unread badges as guilt | The product is slow on purpose. A counter that punishes absence is the exact opposite of the thesis. |
| Fake activity, invented numbers, decorative charts | There are no users yet. Invented metrics are lies with a percentage sign. |
| Stock illustration, 3D blobs, an AI sparkle | The wax is the illustration. One is enough. |
| A design-system playground in production | The gallery is a development tool. Shipping internals is how tools become attack surface. |

## Before you add anything

Three questions, in order. If the first one has no answer, stop.

1. **What job does this element do on this screen?** Not what it is, what it is *for*. If the answer is "the design needs it there", it does not go in.
2. **What is the reason for this technique?** One line, written down. A gradient that separates two levels of hierarchy is craft. The same gradient on every surface is wallpaper. No reason means no technique.
3. **What does it look like with the logo removed?** If the screen would suit any other product, it is generic, and generic is the failure this document exists to prevent.

Then, non-negotiable and not up for discussion:

- Colour is never the only carrier of state.
- Every interactive element works, or it does not exist. No dead controls, no links to unwritten pages.
- Every surface that shows data has an empty state, a loading state, and an error state that names the cause and the next action.
- Keyboard completes a full letter round trip. Drag is an addition, never the requirement.
- Raw hex does not appear outside `tokens.css`. If a value is not a token, it does not exist.

## Known drift

The spec and the build have diverged in four known places. Listed so they get fixed rather than inherited: light-theme wax is `#a8490a` in code and still documented as `#b45309`; dark `--rule`, `--rule-strong` and `--muted` changed during contrast repair; three motion tokens are declared and referenced by nothing; `SealAnimation` hardcodes its timings in JavaScript, so the declared 700ms and the running 700ms are unrelated numbers that happen to agree.
