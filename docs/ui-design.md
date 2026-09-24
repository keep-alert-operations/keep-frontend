# UI design reference

The user requested full frontend adoption of their [Claude artifact](https://claude.ai/artifact/XMD6gScr8TVDnWvYtcvNWP) on 2026-09-24. Implementation uses the artifact's **Option B · full system**, containing 21 artboards at 1440 × 900. The reference was inspected in the browser, including its rendered frames and authored CSS. Its scripts were not incorporated into Appchi.

## Reference mapping

| Reference screens | Frontend implementation |
|---|---|
| 01 Sign-in; shared rail and page frame (tenant breadcrumb, role chip, title, live status, actions, admin tabs, status banners) | `workspace.tsx`, `page.tsx`, `icons.tsx`, `layout.tsx` |
| 02 Alerts; 03 Alert detail | `alerts.tsx`, `alert-table.tsx`, `cel-editor.tsx`, `alert-evidence.tsx` |
| 04 Presets; 05 Saved preset; 06 Preset editor; 07 History | `presets-pages.tsx`, `definition-editor.tsx`, `configuration-history.tsx`, `alert-table.tsx` |
| 08 Incidents; 09 Incident detail | `incidents-pages.tsx`, `incident-list.tsx`, `incident-membership.tsx`, `incident-notes.tsx` |
| 10 Correlation rules; 11 Rule editor | `rules-pages.tsx`, `correlation-tester.tsx`, `temporal-history.tsx` |
| 12 Maintenance; 13 Maintenance editor | `maintenance-pages.tsx`, `maintenance-editor.tsx`, `temporal-history.tsx` |
| 14 Dashboards; 15 Dashboard | `dashboards-pages.tsx`, `definition-editor.tsx`, `dashboard-counts.tsx` |
| 16 Operators; 17 Operator detail | `admin-pages.tsx`, `operations.tsx` |
| 18 Permissions; 19 Access audit; 20 Platform | `admin-pages.tsx`, `directory-picker.tsx`, `audit-browser.tsx`, `administration.tsx` |
| 21 Loading, empty, error, stale and confirmation states | `page.tsx` (`useConfirm`), tenant health banners in `workspace.tsx`, shared styles |

Component paths above are relative to `frontend/src/components`; `resources.tsx` only routes a tenant section to its area. Styles: `frontend/src/app/design.css` carries the reference's class vocabulary (reference `.card`/`.tabs` are named `.panel`/`.tabbar` there); per-area rules are in `frontend/src/app/styles/<area>.css`; `globals.css` keeps base element rules.

## Visual contract and adaptations

The user's reference selects a 76-pixel warm gray rail, `#f6f5f2` canvas, `#fffefc` surfaces, `#1b1a17` text, `#5f5b53` secondary text and `#e4e1da` borders. Geist body text is 13.5 pixels; page titles are 24 pixels. Inputs/buttons use 8-pixel corners and panels use 12-pixel corners. Geist Mono distinguishes expressions, timestamps and counts. The fonts are served locally through Next's font loader from the pinned Next package; rendering does not depend on a Google Fonts request.

The fixed light palette is user-directed and overrides the prior OS-selected theme. Assistant-selected adaptations stack editors/detail panels on narrow viewports, retain horizontal scrolling inside wide tables, and keep keyboard focus and semantic controls. Live responses determine rows, counts, identities, available controls, references, errors and freshness. Prototype numbers, names and green Live indicators are never hardcoded into production views. External Keycloak authentication remains on the normal OIDC route.

The alerts quick views combine with the applied CEL expression and search text. Saving a preset starts from the expression draft; transient quick views, text search and suppression toggles are not silently saved. Existing authoritative revisions, CSRF, authorization, conflict handling and idempotent command recovery remain in use. Detail notes remain separately paginated and editable alongside activity.

Saved presets and editor previews render every configured field as its own column
in the selected order, including the initial default selection. The user's preset
creation report exposed that REV-14's default-selection shortcut replaced fields
with composite Alert/Ownership cells; REV-17 removes that exception. The ordinary
Alerts screen uses its compact layout because it has no preset column selection.
Header arrows reflect the applied sort, wide tables scroll inside their panel,
and row navigation and suppression remain available when Message is omitted.

Loading placeholders appear before a request has a completed result. Confirmed
empty states and loaded content remain visible while the same query refreshes,
including list, notes and history views. Refresh text uses existing status areas;
ordinary refreshes do not insert warning rows. Actual failures still display
errors and identify retained results. Saved preset empty results are matched to
their completed query, so a changed filter waits for its own result (REV-18).

The operational routes share `frontend/src/app/(workspace)/layout.tsx`, which owns
the client workspace and its session state. Changing pages preserves that mounted
workspace instead of returning to the initial session-check screen (REV-19).
Tenant content still resets on tenant/access changes, and foreground session
revalidation and expiry handling continue. The public expired-sign-in page remains
outside this layout.

## Review and verification

Browser review uses a temporary, isolated synthetic API that returns shapes from `contracts/openapi.json`, and an isolated Next build directory; the existing developer stack is separate. `APPCHI_NEXT_DIST_DIR` can select this directory without overwriting another running server's output; the normal default remains `.next`. On 2026-09-24 every reference artboard was rendered from its source and compared side by side with the corresponding screen at 1440 × 900; remaining differences come from illustrative prototype data or data the API does not provide (for example incident activity actor names, see REV-13 in the design register).

Principal names shown in tables and details come from optional read-time `*_display_name` fields; the UI falls back to the identifier when a name is unavailable and marks the signed-in user as “(you)”.

The redesign adds browser checks for quick-filter composition, preset draft boundaries, exact observed revisions in row and bulk actions, select-all, role-dependent actions, styled delete confirmations with revision and idempotency headers, the reference palette under dark OS preference and narrow-screen overflow. Existing browser tests cover the retained authentication, editor, history, notes, audit, dashboard, live-state and conflict flows. Executed results are recorded in [implementation status](../implementation-status.md).

Continuation checks also cover saved custom columns and sort indicators, draft column removal/reordering without a save, and navigation/suppression with Message hidden at a narrow viewport. The saved-preview pagination test captures its own cursor request so concurrent quick-view count requests cannot overwrite its assertion. [Fresh preset screenshots](../qualification/ui-redesign-2026-09-24/README.md) supplement the earlier comparison evidence.

REV-17 browser checks additionally cover creating presets with initial or adjusted
columns, opening and reloading the saved result, reopening the editor, and reading
presets with the original default column order. New forms follow the default order
in [preset section 3](../spec-preset-operations.md#3-saved-definition-and-initial-defaults);
previously saved field order is read as configured.

Visual review is not a certified pixel-diff comparison of every reference state. Production qualification and external identity-service theme changes are outside this UI change.
