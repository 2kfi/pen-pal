# DESIGN.md — Pen-pal App UI

## 1. Product and visual direction

Build a warm, low-pressure pen-pal experience that makes letters feel like physical mail. The interface should feel like a tidy desktop web app rather than a generic social feed: quiet surfaces, clear navigation, personal avatars, collectible postage stamps, letter previews, and small postal details.

The visual references establish five primary surfaces:

1. **Global app shell** — a slim top bar with the wordmark, global actions, and account avatar.
2. **Friends rail** — a persistent left column showing the user's contacts and unread activity.
3. **Home dashboard** — a featured stamp/story, open-letter previews, and community stories.
4. **Pen-pal profile** — a profile header and a grid of sent/received letter cards.
5. **Stamp store** — a category sidebar, coin balance, featured/limited stamps, and country collections.

Support both light and dark themes. Keep the same structure, spacing, and hierarchy in both themes; change surface, border, and text tokens rather than redesigning each component separately.

### Design principles

- **Mail, not a chat app.** Letters are the primary content. Give previews room to breathe; avoid chat bubbles and dense social-feed chrome.
- **Personal and collectible.** Stamps, avatars, countries, language tags, weather, and letter dates provide character. Treat stamps as content, not decoration to be replaced with generic icons.
- **Calm surfaces, vivid accents.** Most UI is neutral. Use postal yellow for important actions and small highlights, not for large blocks of interface.
- **Dense navigation, generous content.** The friends list may be compact; letter cards and featured content should have readable line length and clear separation.
- **Predictable controls.** Buttons, links, tags, badges, and cards need consistent dimensions and states.
- **Accessible by default.** Preserve readable contrast, visible keyboard focus, scalable text, and non-color cues for statuses.

## 2. Design tokens

Treat these as the initial implementation values. Tune only when a real rendered screen demonstrates a consistent mismatch with the references.

### Color

| Token | Light theme | Dark theme | Usage |
|---|---|---|---|
| `--color-accent` | `#FFC400` | `#FFC400` | Primary CTA, coin labels, postal highlights |
| `--color-accent-hover` | `#E9AD00` | `#FFD33D` | Hover/focus accent treatment |
| `--color-accent-ink` | `#18243A` | `#18243A` | Text/icons on yellow buttons |
| `--color-page` | `#F8F8F8` | `#1D2028` | Main page background |
| `--color-surface` | `#FFFFFF` | `#292D37` | Cards, sidebar rows, menus |
| `--color-surface-raised` | `#FFFFFF` | `#303542` | Popovers, raised cards, selected panels |
| `--color-header` | `#FFFFFF` | `#292D37` | Global top bar |
| `--color-text` | `#17243A` | `#E7EAF0` | Main headings and primary copy |
| `--color-text-secondary` | `#686868` | `#B5BAC5` | Descriptions, dates, supporting labels |
| `--color-text-muted` | `#9A9A9A` | `#858B98` | Disabled or low-priority metadata |
| `--color-border` | `#DEDEDE` | `#3B404C` | Card outlines, dividers, separators |
| `--color-link` | `#0878F9` | `#69A8FF` | Inline links such as “See all” |
| `--color-danger` | `#F04444` | `#FF5B5B` | Unread/new indicators and destructive states |
| `--color-success` | `#248A57` | `#62C991` | Success feedback where needed |

Do not use accent yellow as a general background color. Large areas should remain neutral, except for artwork, stamp illustrations, and occasional featured-story media.

### Typography

Use a clean sans-serif stack: `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Avoid decorative display fonts; the illustration and stamp treatment supply the personality.

| Role | Desktop size | Weight | Notes |
|---|---:|---:|---|
| Page title | 28–30 px | 700 | Dashboard welcome, profile name |
| Section heading | 20–22 px | 700 | “Open Letters”, “Penpal Story”, store sections |
| Card title | 18–20 px | 650–700 | Stamp names, story titles |
| Body / letter preview | 15–16 px | 400 | Comfortable line height, around 1.45–1.6 |
| Sidebar name | 15–16 px | 650–700 | Contact names are easy to scan |
| Supporting text | 13–14 px | 400 | Country, category, excerpt description |
| Metadata / badge | 11–12 px | 500–600 | Dates, ownership, coins, status |

Use a consistent heading scale. Do not compensate for weak hierarchy by making every title oversized or bold. Letter previews should wrap naturally and truncate only at a deliberate card limit.

### Shape, elevation, and spacing

- Base spacing unit: **4 px**.
- Typical spacing steps: `4, 8, 12, 16, 20, 24, 32, 40, 48`.
- Standard card radius: **2–4 px**; the references are mostly square-cornered. Do not turn the whole app into pill-shaped cards.
- Buttons and filter chips may use **4–8 px** radius or pill styling where shown.
- Borders are subtle, usually `1px solid var(--color-border)`.
- Use little or no shadow by default. Reserve soft shadows for clearly floating or elevated content; avoid heavy neumorphism or glass effects.
- Main content padding: **20–24 px** on desktop; reduce to **12–16 px** on compact screens.
- Keep a visible gap between sections, around **24–32 px**. Inside cards, use **14–20 px** padding.

### Layout dimensions

These are starting targets based on the desktop references, not fixed pixel requirements:

- Global header: **48 px** high; remains at the top while main content scrolls.
- Friends rail: **320–340 px** wide on a large desktop. Allow it to collapse into a drawer on narrow screens.
- Stamp store category panel: **410–430 px** wide at the reference viewport, with a clear vertical divider from results. It may become a narrower rail or drawer at smaller widths.
- Main content: flexible width with a **20–24 px** inset.
- Featured content panel: roughly **40% artwork / 60% copy** at desktop.
- Letter grid: four columns at the reference width, with consistent gaps. Reduce to three, two, then one column as space decreases.
- Open-letter previews: horizontal carousel/row on wide screens, with clipped continuation and a visible next control. On touch screens, support swipe/overflow scrolling.

Avoid absolute positioning for primary layout. Use grid and flex layouts so content can grow without overlapping.

## 3. Global application shell

### Top bar

The global header spans the full viewport. Its contents are vertically centered and visually compact.

**Left:** circular postal-style mark followed by the spaced uppercase wordmark `SLOWLY` (or the project's own brand name).

**Right:** upgrade action, paper-plane/compose action, edit or write action, add-friend action, stamp/store action, and account avatar. Use icon buttons for compact actions; add tooltips and accessible names.

Rules:

- Keep the header close to 48 px high with a bottom border.
- Use a consistent icon size, approximately 20–22 px.
- The upgrade CTA is yellow with dark text and compact padding; it must not overpower the product's core actions.
- The avatar is the account entry point. A small notification count may sit outside its top-right corner.
- In dark mode, the header uses the dark surface token and the icons/text follow the theme.
- On smaller viewports, reduce action count or move secondary actions into a menu; never allow the header to wrap into two rows.

### Friends rail

Use a fixed-width left rail on desktop, full-height below the top bar. Its header includes the Friends title, contact count, hidden count, and a sort/filter icon. Below it, render a vertically scrollable contact list.

Each contact row contains:

- A circular avatar, around **38–42 px**.
- Display name with strong weight.
- Country/region or a small contextual status line beneath the name.
- Last activity/date aligned to the right.
- A small unread marker or “New!” badge when relevant.
- Optional inline status emoji/star/message indicator, kept visually secondary.

States:

- **Default:** neutral background and subtle bottom border.
- **Hover:** mildly tinted surface; no large animation.
- **Selected:** more pronounced surface tint or a narrow accent indicator; keep text legible in both themes.
- **Unread/new:** use the red indicator plus text/badge where appropriate. Do not rely only on color.
- **Empty/loading:** use a compact, consistent placeholder rather than a blank rail.

The list scrolls independently from the page content. Place app/version, legal links, and social links at the lower part of the rail when there is enough height. Let these footer links move naturally below the list on shorter viewports rather than covering contacts.

On mobile, the rail becomes a drawer or dedicated contacts screen. The selected contact should remain clear when the drawer closes.

## 4. Home dashboard

The dashboard is the default landing surface shown beside the Friends rail.

### Welcome / featured story

Start with a page heading such as `Welcome Back` and a friendly, small emoji. Under it, show a large bordered feature panel with two parts:

- **Artwork panel:** prominent featured stamp or story illustration, centered inside a solid pastel field. Use a contained image so the artwork retains its intended proportions.
- **Copy panel:** country/category label, story title, short descriptive text, optional “Learn more” action, and a subdued source/disclaimer note when generated or summarized content requires it.

The artwork panel is the main color area on the page. Keep the text panel white or the dark surface color, with comfortable padding and a clear title-to-description hierarchy. Show a subtle “Next destination” affordance when the feature can advance.

At desktop widths, align the split horizontally. At smaller widths, stack artwork above copy and avoid forcing the title or description into a cramped column.

### Open Letters section

The section header combines a small mail/letter icon, heading, and a right-aligned action such as **My Open Letters**.

Cards are compact letter previews arranged in a horizontal strip. Each card should include:

- A small unread dot near the top-left when needed.
- A stamp illustration and postal cancellation/wave motif near the top-right.
- A short text excerpt, retaining the source language and script.
- Language and topic tags near the bottom-left.
- Delivery/age metadata (for example, `23h`) near the bottom-right.

Cards should align to a shared height within a row. Keep excerpts to a consistent visual limit, with natural wrapping and an ellipsis when clipped. Cards must not look like chat bubbles.

The row can extend beyond the visible viewport on desktop; show a small next/scroll control at the edge. On touch devices, use native horizontal scrolling or a carousel with swipe support. If the strip is scrollable, it must be keyboard-accessible.

### Penpal Story section

Display larger editorial cards featuring an avatar/illustration, the author's name, a one- or two-sentence excerpt, and a **Read more** action.

- Artwork spans the card width and uses a stable aspect ratio.
- Text content sits on a neutral card surface below the artwork.
- Cards in the same row should align consistently.
- The artwork may use vivid pastel colors, but surrounding UI remains restrained.
- At narrow widths, cards become a single-column list or a horizontally scrollable row; do not shrink type below readable sizes.

### Dashboard rhythm

Maintain this order: page greeting, featured story, Open Letters, Penpal Story. Keep a consistent vertical gap between sections. Avoid inserting unrelated widgets between these primary sections without a product reason.

## 5. Pen-pal profile and letter archive

The profile screen combines contact information with a card grid of correspondence.

### Profile header

Place the display name and contextual details at the top-left of the main content. Show the avatar prominently at the upper-right.

Header content may include:

- Name and optional star/relationship marker.
- Country and a small location icon.
- Birthday or age text when that information is part of the product's privacy settings.
- Short profile introduction.
- Search control.
- Weather chip and interest/language tags.
- View/layout menu near the avatar.

Keep tags compact, with a thin accent outline and a neutral background. Weather uses a yellow fill when highlighted. Do not infer or reveal private profile fields that are not shared with the viewer.

### Letter grid

Use an adaptive CSS grid. On wide desktop screens, start at **four columns** with gaps around **20–24 px**. Each card has:

- A small read/delivery status at the top-left.
- A stamp illustration at the top-right, with postal waves/cancellation behind or beside it.
- A letter excerpt in the main body.
- Sender/recipient name and date/time at the bottom.

Cards need a predictable minimum height and internal spacing. The bottom metadata should sit near the lower edge without overlapping variable-length text. Use a flex column or grid rows rather than absolute positioning for the footer.

The archive can mix sent and received letters. Use a clear and accessible status treatment to distinguish them; small checkmarks may appear as in the references, but include a tooltip or text alternative for their meaning. Letter content must support right-to-left script such as Arabic as well as left-to-right text. Apply direction to the excerpt itself where appropriate; do not force the whole card into one direction when metadata uses another.

### Reply and new-friend actions

- The primary **Reply** action is a yellow floating or anchored button on the profile/letter detail view.
- When a new-friend request is awaiting a response, show **Decline** as a separate secondary/outlined action adjacent to **Reply**.
- Keep actions out of the reading text and away from important content.
- On smaller screens, make actions part of a sticky bottom action bar with enough room for touch targets.

## 6. Stamp store

The Stamp Store has its own prominent navigation/category rail and a wide results area.

### Store sidebar

At the top, use a decorative stamp-pattern banner followed by the **Stamp Store** title and a muted **Switch** action. Under it, render clearly separated navigation rows:

- Country collection (for example, Jordan)
- Time Machine
- World Explorer
- Best Sellers
- Single Stamp
- Stamp Set
- Coming Soon

Each row uses a small emoji or icon, a 14–16 px label, and a full-width hit area. Hover and selected states should be immediately distinguishable.

Below navigation, show a coin balance strip and a **Purchase Coins** button. A separate membership/promotional card may advertise the monthly coin allowance; its artwork should not make the core navigation hard to scan.

### Store results

The main area begins with a country greeting/collection panel: flag, clear heading (for example, `Hello, Jordan!`), brief explanatory copy, and two actions such as **Give Suggestions** and **Vote for Jordan**.

Then show grouped stamp rows:

- A limited-time section with a small clock/alarm icon and its heading.
- Country-specific or themed collection headings, flag/icon, and a **See All** link.
- Stamp entries in a two-column layout at large widths.

Each stamp entry contains the stamp illustration, a bold title, a muted one-line/short description, and a compact ownership or coin-price badge. Use **Owned** for stamps already owned and show a coin amount for purchasable items. Ownership must never be represented by price alone.

Keep the stamp image at its natural aspect ratio. Do not redraw, crop, or stretch the stamp illustration. Entries are selectable and have hover/focus states, but the entire entry should not look like a giant button if only a smaller detail action is available.

At narrower widths, reduce two columns to one and allow the category list to collapse into a drawer or horizontal category selector. Preserve coin balance visibility in the store context.

## 7. Reusable component inventory

Build the interface from shared components rather than screen-specific copies.

- `AppHeader`
- `IconButton` (tooltip, accessible name, focus state)
- `FriendsSidebar`
- `FriendListItem`
- `Avatar`
- `UnreadIndicator`
- `PageSectionHeader`
- `FeaturedStoryPanel`
- `OpenLetterCard`
- `LetterCard`
- `PenpalStoryCard`
- `ProfileHeader`
- `TagChip`
- `WeatherChip`
- `StampArtwork`
- `PostalCancellation` (waves/mark as a separate decorative layer)
- `CoinBalance`
- `StampCategoryNav`
- `StampStoreItem`
- `OwnershipBadge`
- `CoinPriceBadge`
- `PrimaryButton`, `SecondaryButton`, `TextLink`
- `EmptyState`, `LoadingSkeleton`, `Toast` / feedback notice

Use real semantic elements: buttons for actions, anchors for navigation, headings for hierarchy, lists for repeated contacts/items when appropriate. Decorative stamp waves and ornamental elements should be hidden from assistive technology.

## 8. Interaction and state behavior

Every visible interactive element must have a working, named behavior. Do not ship decorative controls that appear clickable but do nothing.

- **Header icons:** navigate or open the documented compose, friends, stamps, and account actions. Provide tooltips on hover/focus.
- **Friend item:** select the contact and show the corresponding profile or conversation context.
- **Open letter card:** open the letter detail or reader, keeping sender, date, and language context.
- **My Open Letters / See All:** open the relevant full list or store collection.
- **Next story / carousel control:** advance the feature/row by one appropriate item; disable or remove the control at the end if looping is not supported.
- **Tags and search:** tags should navigate/filter only if that behavior exists; otherwise present them as informational chips. Search must have a visible focus state and clear action.
- **Reply:** open the letter composer pre-addressed to the pen-pal. Preserve unsent content when the composer is closed if the product supports drafts.
- **Decline:** require a clear action confirmation when the choice is consequential; provide visible feedback after the result.
- **Stamp item:** open stamp details. Purchase/claim controls must show loading, success, and insufficient-coins/error states.
- **Theme:** persist the selected theme if persistence is implemented; do not let theme switching alter content layout.

### Required component states

For every interactive component, implement default, hover, focus-visible, pressed/active, disabled, and loading states as applicable. For async content, include loading and error handling. For lists, include an empty state. Respect `prefers-reduced-motion`; transitions should be short and subtle.

## 9. Responsive behavior

Desktop screenshots are the primary visual reference, but the layout must remain usable at smaller widths.

- **Large desktop (≥ 1440 px):** persistent friends rail, full global header, four-column profile archive, two-column store items, horizontal letter strips.
- **Desktop / small laptop (1024–1439 px):** preserve shell; reduce gutters and card gaps; use three columns for the profile archive when four cards become too narrow.
- **Tablet (768–1023 px):** collapse the friends rail to a drawer or narrow rail; main content uses two columns where appropriate; featured panel may remain split only if both sides have sufficient width.
- **Mobile (< 768 px):** single-column page content; sidebar becomes a drawer/screen; featured artwork stacks above copy; horizontal carousels remain swipeable; actions use comfortable touch targets (aim for at least 44 × 44 px).

Do not solve overflow by shrinking body text below 14 px or squeezing cards until excerpts are unreadable. Reflow content, hide secondary metadata when appropriate, or use horizontal scrolling for clearly horizontal collections.

## 10. Accessibility and internationalization

- Maintain WCAG-friendly contrast for body text and controls in both themes. Check yellow button text explicitly; use dark ink on yellow.
- All icon-only controls need accessible labels. All interactive elements must be keyboard reachable, with a visible `:focus-visible` indicator.
- Do not use color as the only signal for unread, owned, selected, or error states.
- Give avatar and stamp images appropriate alternative text when meaningful; mark purely ornamental artwork as decorative.
- Support Arabic and other RTL content. Apply `dir="auto"` to user-generated text when the language is not known; avoid breaking punctuation and metadata ordering. The overall application chrome should follow the user's selected interface language, not each individual letter's language.
- Allow user-generated content to wrap safely; long usernames, tags, and unbroken strings must not overlap adjacent controls.
- Respect browser zoom and larger system text settings.

## 11. Implementation guardrails

1. **Use tokens.** Theme values should be centralized as CSS custom properties or equivalent design-system variables. Avoid scattered one-off hex values.
2. **Keep layout structural.** Use grid/flex and min-width constraints. Avoid absolute positioning for text, card footers, or main controls.
3. **Preserve image proportions.** Stamp art and avatars must use `object-fit: contain` or `cover` intentionally, never stretch to fill.
4. **Separate art from decoration.** Postal cancellation waves, unread dots, badges, and stamp illustrations should be composable layers/components.
5. **Reuse components.** Home letter cards and profile archive cards may have different density, but should share base stamp, metadata, and card primitives.
6. **Don't over-style.** Avoid gradients, glassmorphism, excessive shadows, giant radii, and arbitrary animations; these are not part of the reference language.
7. **Keep content readable.** Use sensible excerpt limits and metadata placement, especially for Arabic/RTL and other long scripts.
8. **Build light and dark themes together.** Do not finish light mode first and bolt on dark mode later.
9. **Use real states.** Make empty, loading, error, selected, owned, and unread states explicit.
10. **Do not invent product rules.** Coin prices, delivery semantics, ownership, notifications, and request actions must come from application data/business logic rather than hard-coded visual assumptions.

## 12. Acceptance checklist

Before calling a screen done, verify the following:

- [ ] Header height and icon alignment are consistent across screens.
- [ ] Friends rail scrolls independently and does not cover its footer or main content.
- [ ] Main sections share a clear heading style and consistent vertical rhythm.
- [ ] Stamp illustrations retain their intended aspect ratios and remain visually prominent.
- [ ] Letter cards have aligned metadata and readable excerpts at the supported breakpoints.
- [ ] Open-letter rows can be navigated by mouse, keyboard, and touch where applicable.
- [ ] The store clearly distinguishes owned stamps from purchasable stamps.
- [ ] All buttons, icons, cards, tags, and links have correct behavior or are clearly non-interactive.
- [ ] Light and dark themes both have legible text, borders, badges, and focus states.
- [ ] Arabic/RTL letter content renders correctly without displacing card metadata.
- [ ] Narrow viewports do not produce horizontal page overflow.
- [ ] Loading, empty, disabled, error, and success states are present for async/data-driven UI.
- [ ] The finished UI feels calm and mail-oriented, not like a generic dashboard or messaging app.

## 13. Source of truth

Use the provided screenshots as the visual reference for hierarchy, layout, density, and tone. This document defines the reusable rules behind those screens; do not pixel-match a single screenshot at the expense of responsiveness, accessible behavior, localization, or consistency across the rest of the project.
