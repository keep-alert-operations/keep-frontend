# UI design reference

The user requested full frontend adoption of their [Claude artifact](https://claude.ai/artifact/XMD6gScr8TVDnWvYtcvNWP) on 2026-09-24. Implementation uses the artifact's **Option B · full system**, containing 21 artboards at 1440 × 900. The reference was inspected in the browser, including its rendered frames and authored CSS. Its scripts were not incorporated into Keep.

## Reference mapping

| Reference screens                                                                                                                | Frontend implementation                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 01 Sign-in; shared rail and page frame (tenant breadcrumb, role chip, title, update notice, actions, admin tabs, status banners) | `workspace.tsx`, `page.tsx`, `icons.tsx`, `layout.tsx`                                            |
| 02 Alerts; 03 Alert detail                                                                                                       | `alerts.tsx`, `alert-table.tsx`, `cel-editor.tsx`, `alert-evidence.tsx`                           |
| 04 Presets; 05 Saved preset; 06 Preset editor; 07 History                                                                        | `presets-pages.tsx`, `definition-editor.tsx`, `configuration-history.tsx`, `alert-table.tsx`      |
| 08 Incidents; 09 Incident detail                                                                                                 | `incidents-pages.tsx`, `incident-list.tsx`, `incident-membership.tsx`, `incident-notes.tsx`       |
| 10 Correlation rules; 11 Rule editor                                                                                             | `rules-pages.tsx`, `correlation-tester.tsx`, `temporal-history.tsx`                               |
| 12 Maintenance; 13 Maintenance editor                                                                                            | `maintenance-pages.tsx`, `maintenance-editor.tsx`, `temporal-history.tsx`                         |
| 14 Dashboards; 15 Dashboard                                                                                                      | `dashboards-pages.tsx`, `definition-editor.tsx`, `dashboard-counts.tsx`                           |
| 16 Operators; 17 Operator detail                                                                                                 | `admin-pages.tsx`, `operations.tsx`                                                               |
| 18 Permissions; 19 Access audit; 20 Platform                                                                                     | `admin-pages.tsx`, `directory-picker.tsx`, `audit-browser.tsx`, `administration.tsx`              |
| Integrations (REV-65, REV-68; not in the reference; super admins only)                                                           | `integrations.tsx`, `lib/ticket-counts.ts`, `lib/grafana-panel.ts`, `styles/admin.css` (`.int-*`) |
| 21 Loading, empty, error, stale and confirmation states                                                                          | `page.tsx` (`useConfirm`), tenant health banners in `workspace.tsx`, shared styles                |
| Reports (REV-53, not in the reference; [incident reports mock](https://claude.ai/artifact/NxBWGUChKyvq1CnRJmxoky) option A)      | `reports-pages.tsx`, `styles/reports.css`; deep links seed `incident-list.tsx` filters            |

Component paths above are relative to `frontend/src/components`; `resources.tsx` only routes a tenant section to its area. Styles: `frontend/src/app/design.css` carries the reference's class vocabulary (reference `.card`/`.tabs` are named `.panel`/`.tabbar` there); per-area rules are in `frontend/src/app/styles/<area>.css`; `globals.css` keeps base element rules.

## Visual contract and adaptations

The user's reference selects a 76-pixel icon rail. Geist body text is 13.5 pixels; page titles are 24 pixels. Inputs/buttons use 8-pixel corners and panels use 12-pixel corners. Geist Mono distinguishes expressions, timestamps and counts. The fonts are served locally through Next's font loader from the pinned Next package; rendering does not depend on a Google Fonts request.

On 2026-10-26, after comparing five calmer palette prototypes, the user kept this design and replaced only its colors with the Ocean palette, in light and dark. Layout, type, components, copy and behavior are unchanged; the reference's warm grays and black primary actions are superseded. Light uses a `#f7fafd` canvas, white panels with `#dce6f0` borders, `#0e1b2a` text and `#4e6176` secondary text. The rail is `#eaf3fb` with a `#d3e3f2` edge and `#2b4865` labels. Ocean blue `#0a6fb0` with white text marks primary actions (including Run), the active rail tile, the brand mark and the selected tab underline. Links are `#075e96` and the selected quick view is a `#ddeefa` pill. Dark uses a `#0b141e` ground, a `#0e1c2b` rail, `#122030` panels and `#4fb3f0` blue with dark text on blue fills. Status and severity keep their red, orange, amber and green meanings, tuned with the palette. `src/app/theme.css` defines every color once per theme as a semantic role; feature styles use only those roles, and shadows are navy-tinted. Text roles, placeholders included, meet 4.5:1 on their surfaces. Selection, caret, scrollbars, focus rings and native control accents follow the palette. The palette governs Keep-owned screens; the identity provider's login portal (Authelia's stock portal) is not themed by Keep.

On 2026-10-26 the user also asked to quieten the alert, preset and dashboard screens, and approved the result in the [UI cleanup mock](https://claude.ai/artifact/7vm914Lhop6uEBDoTw37Sz) (REV-43 in the design register). The header no longer shows a standing Live pill. Nothing appears while live delivery is healthy or briefly connecting; a quiet notice with Refresh appears when delivery is degraded or unavailable, and "Catching up · counts may lag" while search lags behind. Revision numbers are gone from the saved-preset and dashboard subtitles (the whole subtitle line goes), the presets list, the dashboard list cards, the alert detail's Details panel and the dashboard's newer-version notice. Quick views use the lighter style the user chose, with a coloured dot for each severity and status view and no Active view. Feed and preset alert rows are one line: severity and status are coloured text without shape marks, the source sub-line and New chip are removed, and Last received reads relative to now. The row's ⋯ button opens Assign to me or Unassign and Resolve or Reopen instead of navigating; the message still opens the alert. Dates on these screens and the alert detail read relative to now ("30 seconds ago"), with the exact time and timezone in the tooltip, so the separate "Times in" labels are removed. The alert detail also drops its source sub-line. The Dashboards list remains its own page, reached from the rail.

The light palette remains the default. The user's later dark-mode request supersedes the earlier fixed-light direction: a user can select Light or Dark, and Keep remembers that choice on the device across pages and reloads. Assistant-selected behavior keeps the reference light appearance on first use regardless of OS preference. The dark palette covers Keep-owned sign-in and operational screens. The username-and-password form itself is rendered by the identity provider's own login portal (Authelia's stock portal, with a Keep logo) rather than a Keep-themed page, while OIDC authentication is unchanged (REV-23). Appearance is persisted by the application for its own screens; the identity portal keeps its own stock appearance. The user later requested an icon-based sun/moon switch for the appearance control (REV-24). Assistant-selected adaptations stack editors/detail panels on narrow viewports, retain horizontal scrolling inside wide tables, and keep keyboard focus and semantic controls. Live responses determine rows, counts, identities, available controls, references, errors and freshness. Prototype numbers and names are never hardcoded into production views.

The alerts quick views combine with the applied CEL expression and search text. Saving a preset starts from the expression draft and the Feed's grouping; transient quick views, text search and suppression toggles are not silently saved.

On 2026-10-26 the user approved grouping results by one field (REV-44, [alert grouping mock](https://claude.ai/artifact/FhJsfdk4VB7kAXkjBfx9Dm)). Group by in the quick-view row shows one table per value of Severity, Status, Application, Component, Node, Site, Assignee or Incident, each with an exact count, a severity (or status) summary, its own headings and select-all, five rows and Show 5 more, and no grouped column. Ten groups show first, then Show 10 more groups; more than 1,000 values keeps one table with an explanation. A saved preset stores its grouping, chosen in the editor's Group by tab; the results toolbar can change it for the view only, with Reset (shortened from Reset to saved by REV-45). Live updates refresh a grouped view only while it shows its first rows and groups. Existing authoritative revisions, CSRF, authorization, conflict handling and idempotent command recovery remain in use. Detail notes remain separately paginated and editable alongside activity.

On 2026-10-28 the user chose option D of the [preset editor options canvas](https://claude.ai/artifact/CkERUg32kLwT2AuWdzSJML) for the overloaded preset create/update screen (REV-47). The preview panel keeps the draft status line and now holds the quick views and Include suppressed above its table. A Preset settings panel beside it holds Name above Filter, Columns, Sort and Group by tabs, with the "changes apply to everyone" line at its foot. Tab labels summarise their settings (column count, sort levels, grouping field) and flag an invalid filter or a missing column while hidden; a save rejected for its definition opens Filter. The Filter tab keeps Validate CEL and Preview draft and opens Supported fields and functions as a popover in place of the Insert field chips and the reference line. Columns are a draggable ordered list with Move up and Move down revealed on hover and focus and an Add columns checklist; Group by is a radio list. Saved fields, defaults, validation and actions are unchanged.

On 2026-11-03 the user approved noisy presets (REV-58, [noisy preset design mock](https://claude.ai/artifact/9i9edScgrAKBYCxqrECxtF)) with a generated heavy action-trailer alarm (`src/assets/preset-alarm.wav`, made by `scripts/generate-preset-alarm.py`). The editor's Sound tab after Group by holds the Noisy preset switch, Play sample and three notes; the flag saves with the definition. The results page of a noisy preset loops the alarm while its exact total is above zero (a loading or failed total keeps the last state), shows the Noisy chip beside the title and an Alarm playing banner with Mute, and the preset list marks noisy presets. Mute lasts until the preset is reopened or the tab reloads. When the browser blocks sound until a click, the banner says so and the next click or key press on the page starts it. Editor previews, the Feed and dashboards never sound.

At the user's request, the entire available alert row opens its detail page in feeds, preset results/previews, incident links and maintenance summaries. The existing alert anchor covers the row, retaining keyboard and new-tab navigation and the unsaved-changes guard. Checkboxes, action buttons and incident links remain independent controls above that link.

Incident, correlation rule and maintenance window list rows use the same full-row title link as preset rows. Deleted rules and windows open their retained history from anywhere in the row.

Alert details opened from saved preset results show a Presets / preset breadcrumb and a Back to preset action (REV-25). Previous and Next follow the visible result page. The source is remembered for the opened alert in the browser tab, so a direct alert link without that context starts at Feed.

Alert details opened from an incident's linked alerts show an Incidents / incident breadcrumb and a Back to incident action the same way (REV-59). Previous and Next follow the visible page of linked alerts, skipping unavailable references.

The active and deleted preset-list rows open their existing primary destination when clicked anywhere in the row. Row-level Edit, History and action-menu controls stay independent; keyboard focus on the primary link outlines the row (REV-26).

Saved presets and editor previews render every configured field as its own column
in the selected order, including the initial default selection. The user's preset
creation report exposed that REV-14's default-selection shortcut replaced fields
with composite Alert/Ownership cells; REV-17 removes that exception. The ordinary
Feed uses its compact layout because it has no preset column selection.

The user's 2026-10-11 correction renames the Alerts page to Feed in the navigation,
page title and breadcrumbs. The alert-detail return breadcrumb also uses Feed.
Existing `/alerts` URLs, API paths and alert terminology for records remain.
Header arrows reflect the applied sort, wide tables scroll inside their panel,
and row navigation and suppression remain available when Message is omitted.

Loading placeholders appear before a request has a completed result. Confirmed
empty states and loaded content remain visible while the same query refreshes,
including list, notes and history views. Refresh text uses existing status areas;
ordinary refreshes do not insert warning rows. Actual failures still display
errors and identify retained results. Saved preset empty results are matched to
their completed query, so a changed filter waits for its own result (REV-18).

The incoming-alert dashboard correction (REV-21) also moves routine tenant indexing lag into the header's existing status pill and dashboard indexing, suppression and refresh progress into its stable status line. Refreshing keeps the last captured counts and their colors; only failed or invalidated results receive the stale treatment. The compact status has no animation, and its narrow layout retains enough space to read the update label.

The operational routes share `frontend/src/app/(workspace)/layout.tsx`, which owns
the client workspace and its session state. Changing pages preserves that mounted
workspace instead of returning to the initial session-check screen (REV-19).
Tenant content still resets on tenant/access changes, and foreground session
revalidation and expiry handling continue. The public expired-sign-in page remains
outside this layout.

On 2026-10-28 the user approved dismissing an alert for a time window (REV-49, [alert dismiss mock](https://claude.ai/artifact/Nvp1SJzsc29Y1HYSnfcK99)). A firing row's ⋯ menu and the alert page offer Dismiss, which opens a dialog with For a duration (15 minutes to 1 week presets, plus an always-visible Custom field of minutes, hours or days) or Until a date (date and time in the viewer's zone, with Tomorrow 09:00 and Monday 09:00), an optional reason added as a note and a summary of when the alert returns. A dismissed alert is suppressed: Include suppressed covers it, rows keep their status and show "Suppressed · until 12:30", and their menu offers Change dismissal and Undismiss. The alert page shows a band with the end time, who dismissed it, Change and Undismiss, and its history names Dismissed, Dismissal changed, Dismissal ended early and Suppression ended. Feeds and the alert page refresh by themselves when a dismissal ends (`next_change_at`).

On 2026-10-29 the user asked for plainer alert actions (REV-51): Dismiss, Link to incident and Assign lose their trailing ellipsis in the row menu and on the alert page, and every alert-page action (View alert, Resolve or Reopen alert, Dismiss, Assign, Link to incident, Open runbook, and the band's Change and Undismiss) shows an icon from `icons.tsx`. In the dismiss dialog an empty Custom field waits for a number without an error, and both modes plus the longest summary share fixed grid cells so the dialog keeps one size.

On 2026-10-29 the user asked to merge the panel dialog's search box and preset list (REV-52). Saved preset is one combobox with a chevron that shows it opens a list: typing searches shared presets by name and lists the loaded page below it, clicking a row or Enter on the highlighted row chooses it, and the field then shows its name. The list floats over the dialog, fixed below the field, so opening it never resizes or scrolls the dialog. It opens on click, the chevron, typing or the arrow keys; Escape closes only the list, and leaving the field without choosing restores the chosen name. First page, Next page, the loaded count and Retry loading presets sit at the bottom of the open list, so paging keeps it open.

On 2026-11-09 the user asked for a plainer panel dialog: count and alert table panels show Title (optional) first and the preset field second, the count title is labelled Title (optional) like the other panel types instead of Custom title (optional), and the preset combobox is labelled Preset instead of Saved preset.

On 2026-10-30 the user approved the incident report (REV-53, [incident reports mock](https://claude.ai/artifact/NxBWGUChKyvq1CnRJmxoky), option A, incidents only). Reports sits in the rail after Boards for every tenant reader. The page shows a period control (24 hours rolling; 7, 30 or 90 calendar days in the browser's zone including today; Custom From and To dates), Compare with previous period (on by default), "Computed … ago" and Refresh; a strip of five figures with ⓘ definitions and change lines; opened and resolved bars per hour, day or week with View as table; the resolution cause list; and one breakdown panel switched between Severity, Origin, Correlation rule and Assignee. Breakdown names open the Incidents list filtered by that value and the period's created time, so the list now reads its filters from the URL once on opening. A range before the 90-day retention horizon shows what it covers; assignment history that could not be read in time leaves first response and the assignee breakdown unavailable with Retry; the first load shows flat placeholders; a refresh keeps the figures and says Refreshing…; a failure shows its request ID and Retry. The report does not reload on live hints. Chart colours are the `chart-1` and `chart-2` roles, validated for both themes.

On 2026-10-31 the user asked for an optional v2 alert name (REV-54). An alert's title is its name: the Feed, preset and dashboard rows show it as the link with the message as one muted line under it (`alertTitle` and `alertSubtitle` in `lib/api.ts`, `.alert-sub` in `design.css`), and the alert page heading (with the message in at most two lines beside it and in full in its tooltip, `.alert-detail-message`), the dismiss and link dialogs and the incident and maintenance alert lists use it too. An unnamed v2 alert is named by its 64-character key; a v1 alert has no name and keeps its message. The title column keeps its stored `message` identifier and is labelled Alert, and grouping and sorting offer Alert name, so it is not confused with a preset's own Name field.

On 2026-10-31 the user asked to show where an alert came from (REV-55). Alert detail lists Provider (Grafana, API, or a dash for a v2 alert stored before providers that the backfill has not reached, `providerLabel` in `lib/api.ts`) after Operator, and a Grafana alert with a rule URL gets an Open alert rule button beside Open runbook, with the same safe new-tab link. Provider is a selectable preset column and CEL editor field; the rule URL is searchable but not offered as a column.

On 2026-11-01 the user chose to fill the incident list's Linked alerts column, which showed "—" on every row because the list returned no counts (REV-56). `linkedSummary` in `incident-list.tsx` reads the row's `total_linked`, `suppressed` and `unavailable` and shows "3 linked · 1 suppressed · 1 unavailable", leaving out zero parts. A row whose maintenance proof is pending shows its total alone, and "—" remains only for a row without counts.

On 2026-11-03 the user added dashboard panel types (REV-57, [panel types mock](https://claude.ai/artifact/193U2ejvHGUg2tjpUjWq6k)). Create and Edit panel open one fixed 1000 × 720 dialog for every type (`dashboard-panel-dialog.tsx`): a Panel type dropdown with a search box on top (locked when editing), the type's settings on the left, a preview at the panel's grid size on the right, and the draft note with Cancel and Create/Apply at the bottom; only the middle scrolls. Alert count keeps the preset combobox, title and thresholds; HTML has a title and a line-numbered editor, a live preview and a warning listing what the server's sanitizer would remove (from `POST /dashboards/validate`). `HtmlTile` in `dashboard-counts.tsx` shows stored HTML after a second sanitizing pass (`lib/panel-html.ts`, the same allowlist as keep-domain), with `.pn-html` styles in `dashboards.css`. A dashboard with no count panels makes no count request. Later the same day the user asked for the count preview to show a number before saving: the dialog counts the chosen preset with `previewTotal` (`POST /alerts/counts`, suppressed alerts excluded as on dashboards), and thresholds color it as they change.

On 2026-11-09 the user added image panels (REV-62, [image panel mock](https://claude.ai/artifact/DBAYiG4UFA3YEtsJec69w2)). Image is the third panel type in the same dialog: an optional title, an **Upload a file** / **Link to an image** switch, a drop area with Choose file (the file uploads at once through `lib/panel-image.ts` to `POST /dashboard-images` and previews from a local `blob:` URL meanwhile) or an `https` address field, an image description and a Fit choice (**Show whole image** = `contain`, **Fill the panel** = `cover`). A link that does not load in the preview warns but does not block Create. `ImageTile` and `PanelImage` in `dashboard-counts.tsx` render the picture with loading and "Image unavailable" states (Open link for links); links load with `referrerpolicy="no-referrer"`. Without a title the image fills the card (`.pn-img-bare`). The image's alt text is its description, else its title, else "Image panel"; the card is labeled by its title or "Image panel". Styles live in `dashboards.css` (`.pn-img*`) and `dashboard-panel-dialog.css`.

On 2026-11-09 the user added ServiceNow ticket panels (REV-65, ServiceNow panel mock approved with the queue link removed). **ServiceNow tickets** is the fifth panel type: an optional title (blank shows "<team> tickets"), a free-text Team (required, up to 200 characters; no suggestions), Ticket state (Open / In progress / Both) and Detection method (Hamal / Direct / All) segmented radios with per-choice help, and the count panel's threshold editor. A new panel is 3 × 3. While `GET /ticket-counts/status` reports `configured: false` the type is listed with `aria-disabled` and the reason, and the keys skip it. The preview asks `POST /ticket-counts` for the draft's query 400 ms after the settings stop changing, beside an "About this count" note. `ServiceNowTile` and `useTicketCounts` in `dashboard-servicenow-panel.tsx` render the board tile: title, "Team · State · Detection", the centered `.pn-value` count with the threshold top bar, and the first-load placeholder, Team not found, No count, greyed last count with "Last count N min ago. Retrying.", Couldn't get the count and ServiceNow isn't connected states. One batched, de-duplicated request per dashboard (drafts included, never part of alert count batches) runs on load, every 60 s, on Refresh counts and when the tab becomes visible; a paused dashboard skips the automatic refreshes. Administration › Integrations (`integrations.tsx`, super admins only) is read-only: Connected / Not configured, host, last answer and last error, and Test connection; the address is deployment configuration.

On 2026-11-10 the user added Grafana panels (REV-68, Grafana panel mock approved without a theme option). **Grafana panel** is listed last: an optional title (blank by default, because Grafana draws its own), one **Panel address** box that takes a URL or Grafana's Share › Embed code (`DOMParser` reads only the first iframe's `src`, and a "Using …" line shows it), an attached strip with **Add "Open in Grafana" link** (fills the REV-66 panel link with the `/d/…?viewPanel=N` view), the inline problem, the allowed Grafana list and the "From this address" facts. The browser checks the address in the design's order (`lib/grafana-panel.ts`) as it is typed and again before every frame is created; a new or changed address is saved as the parsed `URL.href`, and an unchanged saved address may stay while other settings change. A new panel is 6 × 6. While `GET /grafana-panels/status` reports no allowed Grafana the type is listed with `aria-disabled` and the reason. `GrafanaTile` in `dashboard-grafana-panel.tsx` frames the panel in a sandboxed, no-referrer, lazy iframe (no top navigation) with `theme=` set to the viewer's Keep theme, live; it shows a skeleton until the frame loads, "Grafana panel blocked" with the reason (and Edit panel for editors) or "Grafana panels are turned off" instead of a frame, and a "Paused while you move it" cover over every frame while a panel moves or resizes. Untitled panels give the frame the whole card with the link button floating top-right. Frames are never part of count batches and Refresh counts doesn't reload them; below 1,024 pixels a Grafana panel spans the full width and six rows. While creating an HTML panel whose HTML holds an `<iframe`, the dialog offers **Use a Grafana panel instead**, carrying the iframe's address over. Administration › Integrations adds a read-only Grafana panels card: On/Off, the allowed Grafana and their `/d-solo/` paths, ignored configuration entries, and the Grafana-side settings with **Copy for Grafana admins** (the `frame-ancestors` line uses Keep's own origin). Per-Grafana usage counts are not shown.

On 2026-11-10 the user added incident count panels (REV-69, [incident count mock](https://claude.ai/artifact/GUkDWqBYr5DjzkMyMJacpd), with the statuses reduced to two plain checkboxes through canvas comments). **Incident count** is the second panel type: an optional title (blank shows "<preset> incidents"), the shared Preset combobox, **Incidents to count** as Firing and Investigating checkboxes (both ticked; unticking both shows "Choose at least one status to count." and disables Create) and the count panel's threshold editor. A new panel is 3 × 3. The preview counts with `previewIncidents` (`lib/incident-counts.ts`, `POST /alerts/counts` with `incident_status`) and lists "Behind this number, right now": matching alerts, how many are in a counted incident, and the incidents. On the board the panel is a `CountTile` fed by the dashboard's count batch, with the status line under the title; "Too many incidents to count" replaces the number when the API reports `incident_count_too_large`. The title opens the preset, as for an alert count.

## Review and verification

The user’s 2026-10-08 correction puts editing on the regular dashboard screen.
Click its name or adjacent pen icon to rename it. Create panel and each panel’s
options open a dialog for one panel; Delete panel changes the local draft. Save
is disabled until the complete name/panel/layout draft differs from the saved
baseline, including after reverting all changes or successful save. Canceling a panel
dialog leaves the dashboard draft unchanged. There is no separate
dashboard editor.

The user’s 2026-10-09 correction replaces Pause updates with Discard changes in
the primary dashboard toolbar. Discard is available to editors, disabled while
clean or commands are locked, and confirms before restoring the current saved
definition. There is one discard entry point. Automatic count updates and manual
Refresh counts remain, including fullscreen, which has no pause control. Preview
draft counts and its requests/preview state are removed. New or changed preset
references show “Save the dashboard to count this panel” until saved.

The later 2026-10-09 user correction removes the visible unsaved-draft reminder,
preset-opening hint, drag/resize instructions and tenant/live/capture/revision
status line. The draft’s Unsaved changes chip and Save/Discard controls remain.
Keyboard instructions stay available to assistive technology through the handles;
count status is visually hidden. The subsequent same-day correction removes the
Count provenance button, details panel and reserved action row. Batch metadata
continues to validate count context internally. Count refresh keeps panels steady;
actual errors and stale/unavailable count markers remain visible.

Each desktop panel exposes a move grip and a lower-right resize handle. Following
the later 2026-10-08 user correction, the active panel follows the pointer in CSS
pixels while a placeholder shows its compacted grid destination. Neighbors and
the released panel settle smoothly; reduced-motion preference skips settling
animations. Saved dimensions use the existing grid choices; arrow keys provide the same
operations. Escape or pointer cancellation restores the pre-gesture draft.
Panels are moved and resized only on the desktop grid (REV-50, REV-60), so the panel
options hold Edit and Delete and narrow screens show the saved layout without
rearranging it. Responsive display preserves desktop columns and sizes.

Assistant-selected collision handling pins the edited rectangle, visits other
panels in saved y/x/UUID order and moves overlapping panels downward until they
fit, then applies upward gravity while preserving horizontal blocker order.
Panels settle at the top or immediately beneath supporting panels in overlapping
columns. This closes empty gaps after moving, shrinking, deleting, creating or
reordering panels. A gesture whose compacted layout exceeds 100 units keeps the
last valid preview. New panels fill the first compacted row-major gap. Existing
sparse saved layouts display compacted for editors, viewers and fullscreen;
opening alone stays clean and writes nothing. Subsequent explicit edits save the
compacted coordinates. All changes stay in the per-tab draft until explicit Save,
using the existing revision and command identity. API validation remains the
authority for the submitted whole layout.

Browser review uses a temporary, isolated synthetic API that returns shapes from `contracts/openapi.json`, and an isolated Next build directory; the existing developer stack is separate. `KEEP_NEXT_DIST_DIR` can select this directory without overwriting another running server's output; the normal default remains `.next`. On 2026-09-24 every reference artboard was rendered from its source and compared side by side with the corresponding screen at 1440 × 900; remaining differences come from illustrative prototype data or data the API does not provide (for example incident activity actor names, see REV-13 in the design register).

Principal names shown in tables and details come from optional read-time `*_display_name` fields; the UI falls back to the identifier when a name is unavailable and marks the signed-in user as “(you)”.

The redesign adds browser checks for quick-filter composition, preset draft boundaries, exact observed revisions in row and bulk actions, select-all, role-dependent actions, styled delete confirmations with revision and idempotency headers, the default light palette under dark OS preference and narrow-screen overflow. Dark-mode checks must cover explicit selection, persistence across navigation and reload, and readable representative screens. Existing browser tests cover the retained authentication, editor, history, notes, audit, dashboard, live-state and conflict flows. Executed results are recorded in [implementation status](https://github.com/keep-alert-operations/keep-delivery/blob/main/status/implementation-status.md).

Continuation checks also cover saved custom columns and sort indicators, draft column removal/reordering without a save, and navigation/suppression with Message hidden at a narrow viewport. The saved-preview pagination test captures its own cursor request so concurrent quick-view count requests cannot overwrite its assertion. [Fresh preset screenshots](https://github.com/keep-alert-operations/keep-delivery/blob/main/qualification/ui-redesign-2026-09-24/README.md) supplement the earlier comparison evidence.

REV-17 browser checks additionally cover creating presets with initial or adjusted
columns, opening and reloading the saved result, reopening the editor, and reading
presets with the original default column order. New forms follow the default order
in [preset section 3](https://github.com/keep-alert-operations/keep-design/blob/main/specs/spec-preset-operations.md#3-saved-definition-and-initial-defaults);
previously saved field order is read as configured, subject to the later REV-27 acknowledgement-column adaptation below.

Visual review is not a certified pixel-diff comparison of every reference state. Production qualification remains outstanding. Sign-in is served by the identity provider's own login portal (Authelia's stock portal in the dev stack); the dev identity stack is documented in [local identity setup](https://github.com/keep-alert-operations/keep-delivery/blob/main/docs/local-identity.md), and Keep ships no login theme to shared identity services.

## Assignment and alert status (REV-27)

The user's 2026-09-27 redesign makes assignment the sole current ownership control. Alert detail has one Assign menu with Assign to me, a directory picker and Unassign. Bulk assignment uses the same choices. Feed and preset rows offer Assign to me or Unassign, and Resolve or Reopen, in their ⋯ menu (REV-43). Remove standalone acknowledgement actions, badges and table fields. Detail, feeds, presets, incident links and maintenance summaries show Firing when firing and unassigned, Acknowledged when firing and assigned, and Resolved regardless of assignment. Suppression stays separate. Assignment history and old acknowledgement activity remain readable.

Alert detail also has Link to incident beside Assign, and Feed and preset rows add Link to incident to their ⋯ menu (REV-48). Both open `LinkIncidentDialog`, which lists active incidents to search and choose one; for an alert another active incident owns, the action is Move to incident and uses the explicit move command.

Quick views Firing and Acknowledged use `display_status`; REV-43 removed the Active view, which used the raw firing lifecycle and included both. Assigned to me (REV-45) uses `assignee_id` equal to the signed-in principal's ID, and pressing the selected quick view again returns to All. New preset defaults use Status (`display_status`) and Assignee. CEL fields are suggested by bare catalog name; existing `alert.field` source remains compatible. Current legacy column adaptation, legacy query semantics and the Lifecycle-only sort choice are specified in [alert operations section 17](https://github.com/keep-alert-operations/keep-design/blob/main/specs/spec-alert-operations.md#17-assignment-and-derived-acknowledgement) and [preset section 4](https://github.com/keep-alert-operations/keep-design/blob/main/specs/spec-preset-operations.md#4-columns-and-sorting). Existing saved history is not rewritten.

## Current alert JSON viewer (REV-28)

The alert detail page offers **View alert** to every reader who can open that page. It opens the currently loaded authoritative alert detail response as formatted JSON in a native modal dialog. The modal is read-only; it has an explicit Close control, supports Escape/backdrop dismissal and keeps the browser's native focus handling. Opening it makes no second API request and does not change alert state.
