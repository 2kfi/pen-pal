# PenPal — Design Direction

> **This file defines intent.** `docs/DESIGN.md` defines the design-system specification: tokens, type scale, motion timings, and accessibility thresholds. Keep implementation values in the spec, not here. Keep the reasons behind the design here, not buried in components.
>
> Read this direction first, then the spec, then build. If they disagree, preserve the intent described here and use the spec for implementation values. Record and resolve the disagreement in writing; do not quietly invent a third answer in a component.

## The product in one sentence

**PenPal is private correspondence for people who want to write letters, not another chat stream.**

The experience is quiet, personal, and deliberately paced. A letter may take time to arrive or become available, but that wait must be understandable and trustworthy—not simulated, confusing, or used to disguise ordinary loading.

The design should make the wait feel meaningful without making the interface feel inconvenient.

## The identity

**Paper. Ink. One sealed letter.**

The product's signature is the feeling of sending and receiving correspondence: something written with care, sealed, carried, and read. The interface should support that idea without pretending to be a physical desk or an antique stationery shop.

Intimacy means personal, not automatically romantic. Warmth should come from material, typography, language, and pacing—not hearts, mascots, forced sentiment, or cute decoration.

## Core principles

### 1. Correspondence comes before the interface

The words people write and read are the main content. Give them room, legible type, and a comfortable reading measure. Navigation and metadata should help people understand where a letter is and what they can do with it; they should never compete with the letter itself.

### 2. The wax seal is the signature gesture

The seal is the one distinctive visual moment: a tangible expression of sending, not a decoration to repeat across the interface. Use it where the act of sealing matters. Do not turn every screen, card, and button into another version of the seal.

A clear primary action is still necessary. It should be visually calm enough that it supports the seal instead of competing with it.

### 3. Slow does not mean unclear

Waiting is part of the product, so show the real state of a letter in plain language. Make clear whether it is a draft, sent, travelling, or ready to open. Never invent activity, imply progress that is not happening, or leave someone guessing whether an action worked.

Do not add delay for atmosphere. The product's actual correspondence rules create the wait; the interface explains it honestly.

### 4. Quiet is not empty

Use restraint to create focus, not to remove useful guidance. Hierarchy should come from spacing, type, contrast, alignment, and a small number of meaningful surfaces—not from decorating every section.

Each screen should have one clear purpose and a layout suited to that purpose. Do not force the whole product into the same card template.

### 5. Warm, physical, and contemporary

Paper and ink are the material references, not a command to imitate real stationery literally. Subtle surface differences, fine rules, and considered typography can suggest physicality. Avoid fake desks, elaborate envelope effects, heavy textures, and shadows without a clear purpose.

### 6. Trust is part of the visual design

Privacy, delivery, and availability must be communicated plainly. Status must never depend on colour alone. Do not use guilt to drive engagement, fabricate metrics, or make a control look usable when it is not.

## Colour and surfaces

Use a small, semantic palette. The dark and light themes are both deliberately designed; neither should be a simple inversion of the other.

- **Ink** establishes the page ground and the strongest dark/light contrast.
- **Paper and raised paper** distinguish the page, writing wells, and genuinely separate surfaces.
- **Wax** is the primary accent. Reserve it for the seal and the most important action or state that needs emphasis. It is a material cue, not a licence to decorate.
- **Text and muted text** provide readable hierarchy. Muted text is still content and must remain legible.
- **In-transit colour** means exactly that a letter is travelling. Pair it with an explicit label; never use it as a general accent.
- **Danger colour** is for errors and destructive actions only.

Colour should clarify hierarchy and state. If a colour has no semantic job, remove it. Use borders and surface differences before adding shadows. A shadow is justified only when a surface needs to feel physically elevated.

The spec defines the actual values and contrast requirements. Do not put raw colour values in this file or introduce one-off values in components.

## Typography

Three type families, each with a distinct role:

| Role | Family | Use |
|---|---|---|
| Display | `Syne` | The PenPal name and a small number of large, deliberate display moments. Never use it as a default label font. |
| Reading | `Literata` | Letter content and other long-form reading. The writing itself deserves the strongest typographic treatment. |
| Postmark | `Space Mono` | Short factual metadata such as dates, distance, and delivery state—the machine-marked details in a paper world. Never use it for letter prose. |

Keep the hierarchy purposeful and the number of weights controlled. Do not introduce another family or use typography as decoration when spacing and composition solve the problem. Fonts are self-hosted; reading the product should not depend on a third-party font request.

## Layout and composition

Use one consistent application shell, but let each screen's job determine its composition:

- **Archive:** a continuous spine, with letters arranged as points along a line rather than unrelated cards in a grid. The spine is a core part of PenPal's visual identity.
- **Letter reading:** one measured column that keeps attention on the words and gives the text room to breathe.
- **Calendar:** a grid when the task is understanding dates and timing.
- **Board:** a square or spatial composition when the task genuinely benefits from one.

These are patterns, not excuses to add screens or complexity. Keep navigation predictable across the app, and introduce a distinct layout only when it better serves the task.

## Motion and feedback

Motion is scarce and purposeful. It should explain an action or reveal a real state, never decorate an idle screen.

- The sealing-and-sending sequence is the signature interaction. It should feel considered, brief, and connected to the action the person just took.
- A travelling letter may drift slowly while it is genuinely in transit. This is the one permitted continuous motion because it represents an ongoing state. Stop it as soon as that state ends.
- Other movement should respond directly to a user action. No decorative loops, automatic entrance choreography, scroll-triggered reveals, or celebration the user did not initiate.
- With reduced-motion preferences enabled, remove nonessential animation and preserve the meaning of the state through a clear static presentation.

The spec owns durations, easing, and implementation tokens. Components should consume those definitions rather than quietly maintaining their own competing timings.

## Language and interface behaviour

The interface speaks plainly and calmly. It does not apologise for being deliberate, dramatise routine events, or pressure people to return.

- Label actions with words that say what will happen: **“Seal and send”**, not an ambiguous icon or an arrow appended to a label.
- Use uppercase postmark styling only for concise, factual metadata—not as a label above every heading.
- Use separators only when they distinguish real information. Decorative dots and ornamental punctuation add noise.
- Explain states in words as well as colour. A status indicator should answer the user's question, not make them decode the palette.
- Keep error messages specific and pair them with a useful next step whenever one exists.
- Do not add streaks, guilt-driven unread counts, fake activity, invented numbers, or decorative charts. Show counts and metrics only when they help someone make a decision.

## Interaction and accessibility commitments

These are product-quality requirements, not optional polish:

- Every visible interactive element works and has a clear purpose. Do not ship dead controls or links to pages that do not exist.
- A full letter round trip can be completed with a keyboard. Dragging may supplement an interaction, but must not be the only way to complete it.
- Every data-bearing surface has a considered empty state, loading state, and error state. Errors should explain the problem and the next useful action where possible.
- Status is never conveyed by colour alone.
- Reading and controls remain usable in both themes, at supported text sizes, and with reduced motion enabled.
- Design-system galleries and debugging tools belong in development tooling, not in the production experience.

The specification defines measurable contrast and other accessibility thresholds. Verify the real combinations in which tokens are used, not just isolated swatches.

## Before adding an element

Ask these questions in order:

1. **What job does it do on this screen?** If the only answer is “it looks designed,” leave it out.
2. **Why this treatment?** Be able to explain the choice in one sentence. A gradient, texture, shadow, or animation needs a specific reason; repeated decoration is not a reason.
3. **Does it help someone write, read, understand a letter's state, or move through the app?** If not, it needs a strong justification.
4. **Would the screen still feel like PenPal without the logo?** The archive spine, the restrained use of wax, the reading typography, and the honest treatment of waiting should make the experience recognisable.

When in doubt, remove the decoration—not the information the person needs.
