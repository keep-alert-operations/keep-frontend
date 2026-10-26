---
version: 1
slug: "src-app-theme-css"
primary_target: "src/app/theme.css"
related_targets: ["src/app/globals.css","src/app/design.css","src/app/styles","keycloak/themes/appchi/login/resources/css/appchi.css"]
---

## Scope

Operate surface, whole application: shared shell (76px icon rail, page frame), every Appchi screen, the signed-out, sign-in and expired screens, and the Appchi Keycloak password form. Palette refinement of the incumbent design at `f58c7d0`, not a new world. Audience and constraints are in PRODUCT.md, including the user's standing preference for the current simple, easy-on-the-eye feel with a real colour palette. Light is the default with a remembered dark choice (`appchi-theme`, `data-theme` on `<html>`); every route, API call, permission, copy string, ARIA role/label, keyboard path, layout, radius, spacing and font stays as it is.

## Direction contract

THESIS: Today's calm Appchi workspace, unchanged in structure, recoloured with the user-chosen Ocean palette so the shell reads as a cool blue tint instead of warm grey, and primary actions are Ocean blue instead of black.

OWN-WORLD: Incumbent structure (76px icon rail, Geist / Geist Mono, 8px controls, 12px panels, existing components). Light: rail #EAF3FB with #D3E3F2 edge and #2B4865 nav ink; active rail tile, "A" mark, Run and primary buttons #0A6FB0 with white text; links #075E96; selected quick view a #DDEEFA pill; canvas #F7FAFD; white panels with #DCE6F0 borders; ink #0E1B2A; secondary #4E6176; live pill #DFF4EA / #1D6E45. Dark: rail #0E1C2B, ground #0B141E, panels #122030, blue #4FB3F0 with dark text on blue fills. Status and severity keep red / orange / amber / green meaning with Ocean's tuning. Navy-tinted shadows. Browser surfaces (selection, caret, scrollbars, focus, accent-color, placeholders) themed from the palette.

STORY: An operator returns to the same screens they know; nothing moved, the colour is calmer and the blue marks where to act and where they are.

FIRST VIEWPORT: Unchanged from the incumbent Feed: rail left with the blue active tile, crumb and 24px "Feed" title, live pill, CEL bar with blue Run, search, quick views with the selected one as a soft blue pill, white table panel.

FORM: User decision 2026-10-26 after the Ocean prototype (branch design/4-ocean): keep the current design, take only Ocean's colours. Not taken from Ocean: 228px labelled sidebar, Mulish / IBM Plex Mono, firing-dot halo, Ocean's spacing and size changes. No concept roll was run for this refinement (no seed): the world is the incumbent one and the palette was chosen by the user from built prototypes.

FINISH: contrast ≥4.5:1 for text and placeholders in both themes; detector run on changed files; finish review verdict; DESIGN.md and .impeccable/design.json describe the system as built.
