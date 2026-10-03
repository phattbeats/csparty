# CS Party, GoldSrc party-menu direction

Open `index.html` to explore the join-screen design. `cs-party-preview.html` is the same design with all assets embedded, suitable for opening as one file. No installation, remote fonts, or network calls are required.

The pack contains the eight-character transparent portrait atlas, a primary transparent PNG logo, a simplified editable SVG utility wordmark, an SVG crosshair-die icon, a favicon, and HTML/CSS/JavaScript source. The raster images are original generated reinterpretations of the classic roster, not extracted game models or exact model renders.

## Visual direction

GoldSrc supplies the frame: olive panels, sharp bevels, inset fields, amber UI type, chunky low-poly busts and painted textures. Party games supply the scale and movement: colorful badge coins, a cream-outlined block-letter logo, raised selection frames, and prominent six-face dice. Keep the game menu in the first viewport. A promotional hero would bury the actual join flow.

Use the primary logo on the main join screen. Use `logo-compact.svg` for compact headers and `logo-icon.svg` for avatars. `favicon.svg` is deliberately simpler at 16–32px. The SVG utility wordmark is a complementary flat design, not a vector trace of the generated primary logo. Its letters are outlined paths and do not require a font.

Suggested next step for final portraits: render the mod's actual character models with this framing and replace the atlas. That makes the selected portrait match the in-game model precisely. The included portraits work as concept/prototype assets now.

## Portrait atlas

`assets/character-atlas.png` is 1774 × 887, RGBA. The logical grid is four columns by two rows; the generated image has equal fractional cell widths. CSS `background-size: 400% 200%` displays the cells without cutting or resampling the source. Column positions are 0%, 33.333333%, 66.666667%, and 100%; row positions are 0% and 100%.

| Row | Column | Character | Badge color | Die faces |
| --- | --- | --- | --- | --- |
| T | 1 | Phoenix Connexion | #e6603f | 1, 2, 3, 4, 5, 6 |
| T | 2 | Elite Crew | #e3b52b | 0, 0, 3, 5, 6, 7 |
| T | 3 | Arctic Avengers | #a7d5e4 | 2, 2, 3, 3, 5, 6 |
| T | 4 | Guerilla Warfare | #9bad54 | 1, 1, 1, 6, 6, 6 |
| CT | 1 | SEAL Team 6 | #6b9fd4 | 3, 3, 3, 4, 4, 4 |
| CT | 2 | GSG-9 | #b5b9c1 | 0, 2, 2, 5, 5, 7 |
| CT | 3 | SAS | #b98ad9 | 1, 3, 3, 3, 5, 6 |
| CT | 4 | GIGN | #e2e2d4 | 2, 2, 2, 2, 6, 7 |

Roster order, die faces, descriptions, and first-visit download guidance were read from https://csparty.example.com/ on 2026-10-02. `0` is shown as a zero and announced as a blank, matching the current die data. Random keeps the existing behavior: the server assigns whoever is left when the match starts. The UI never simulates this assignment locally.

## Integrating with the existing homepage

This is a design prototype, not a replacement game client. Preserve the existing canvas, game initialization, asset download, connection logic, error handling, and fullscreen control.

The form keeps recognizable `name`, `chars`, and `go` IDs. Prototype selection uses the `character` radio name and emits `csparty:join` with `{ name, character }`; character values are human-readable prototype IDs, so map them to the game's existing model identifiers or indices before connecting. Remove the demo submit handler and its preview-only status when integrating. Use the existing server join handler and download status/progress element.

The default preview selection is Phoenix so the artwork and dice are visible immediately. Restore the live page's Random default if that remains the desired product behavior.

Selection works with native radio-button keyboard behavior and touch. Color is paired with names, initials, and a P1 stamp. The selected die is announced to screen readers; reduced-motion settings disable movement.

## Palette and type

| Role | Color |
| --- | --- |
| Page background | #101410 |
| Raised panels | #292e22 |
| Inset panels | #191e17 |
| Amber / selected state | #f4a331 |
| Cream / primary text | #efe5ca |
| Secondary text | #c0c4ac |
| Bevel light | #737863 |
| Bevel dark | #0c100a |

Use Tahoma for body/control labels, Impact or a narrow display fallback for large game headings, and Courier New for small HUD labels. The prototype uses system fonts only.

## Generation notes

Portrait atlas and primary logo were created with the built-in image generation tool. Complete prompts are in `art-prompts.txt`. SVG icon/wordmark, badges, bevels, and dice UI use exact vector/code geometry. Keep portrait texture localized; do not apply a global grain or noise layer over text and controls.

## Verification

The final prototype rendered on desktop and mobile. No horizontal overflow was found at viewport widths 320, 768, 900, and 1440 pixels. All eight selections showed the expected live die faces. Random hid the character portrait and dice. The join event carried the entered name and selected character. No JavaScript page errors were observed. The existing game client was not changed or deployed.
