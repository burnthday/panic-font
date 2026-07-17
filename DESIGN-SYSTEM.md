# Burnthday Design System

Burnthday pairs a quiet, modern website with Gary Vereen's laminated Widespread Panic Song List. The website may become cleaner over time; the Song List should continue to look and behave like the working document the band used.

## Principles

1. Preserve the document. Do not redesign the Song List, marker strokes, numbered corners, counts, or handwritten additions into generic web UI.
2. Keep the website quiet. Navigation, data summaries, setlists, and explanatory copy should be easy to scan and should not compete with the sheets.
3. Let data define the layout. Long titles should fit before they are shortened, and dynamic content must not move or overlap neighboring elements.
4. Use one role per typeface. A font is chosen for meaning, not decoration.

## Typography

| Role | Typeface | Desktop | Mobile | Weight |
| --- | --- | ---: | ---: | ---: |
| Website display title | Geist | 48px | 30px | 700 |
| Archive or preserved page title | MilkRun | 48px | 34px | 400 |
| Section heading | Geist | 26px | 24px | 700 |
| Worksheet subheading | MilkRun | 18-22px | 18-20px | 400 |
| Editorial body | Geist | 18px | 16px | 400 |
| Standard body | Geist | 16px | 16px | 400 |
| Dense data and setlists | Geist | 15px | 14px | 400-700 |
| Small label | Geist | 13px | 13px | 600-700 |
| Micro label | Geist | 11-12px | 11-12px | 400-700 |
| Song List row | MilkRun | 21px | 18px | 400 |

### Typeface Roles

- **Geist** is the website font: navigation, controls, setlists, statistics, explanatory copy, footer, and current data features.
- **MilkRun** is the worksheet font: Song List rows, sheet labels, tiny tour counts, preserved archive titles, and sheet-adjacent headings.
- **PanicHand** is handwritten marker ink only: the board location and songs or dates visibly written onto a sheet. It is not a general heading font.

Letter spacing is always `0`. Never use negative letter spacing to force a fit. Do not mix font sizes within a setlist; only bold the date and the `1:`, `2:`, and `E:` labels.

## Song List Rules

- A tiny superscript beside a Song List title is the number of shows in the current tour in which the song was played. A sandwich counts once per show.
- A tiny superscript in a setlist denotes a special guest and maps to a numbered guest note below the setlist.
- Shelf and Purgatory entries retain lifetime count and the relevant prior last-played date.
- Marker color identifies the most recent tour dates according to the sheet key. Marker art must match the text height rather than stretching across the row.
- Full song titles are preferred. The row fitter may reduce type down to its documented minimum before applying an approved short title or ellipsis. The count must always remain visible.
- Handwritten additions use PanicHand at a visually matched x-height, with MilkRun for their count and date.

## Layout

- Site content uses a maximum width of 1180px; the large laminated board may use the wider 1880px canvas.
- Spacing follows an 8px rhythm where practical. Standard section gaps are 32-36px.
- Laminated sheets use white paper, a subtle 9px laminate edge, and a maximum 6px radius.
- Setlist photography is landscape (`16:9`), unframed, and outside decorative cards.
- The latest completed setlist appears above the Song List. Older setlists move into the setlist section below the sheets.

## Responsive Behavior

- Primary breakpoints are 900px, 720px, and 560px.
- Desktop type does not continuously scale with viewport width. Sizes change deliberately at breakpoints.
- On mobile, the numbered corners and location remain on one line and share a balanced visual height.
- Song columns collapse from four to two to one. Titles remain one line and are fitted without hiding the tour count.
- Desktop navigation becomes the compact menu below 560px.
- No horizontal page overflow is acceptable at 320px or wider.

## Color

- Paper: `#fffdfa`
- Ink: `#111111`
- Muted copy: `#5f5a55`
- Marker red: `#d4514f`
- Marker green: `#2d7c52`
- Marker blue: `#286e9e`
- Rules use black at 12% opacity.

## Review Checklist

- Confirm Geist, MilkRun, and PanicHand are used only for their documented roles.
- Compare the board at desktop, tablet, and 390px mobile widths.
- Check long song titles, handwritten additions, superscript counts, and dates for clipping or overlap.
- Confirm marker strokes match the row height.
- Confirm all setlist text is one size and all show images are landscape.
- Confirm the nav, section headings, footer, Shelf page, and Tour in Review share the same website hierarchy.
- Run `npm run qa` before publishing.
