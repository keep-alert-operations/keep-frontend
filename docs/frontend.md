# Frontend implementation and verification

The frontend uses the selected Next.js App Router and TypeScript architecture.
The server renders a non-sensitive shell; same-origin Python APIs authorize all
protected reads and writes. There is no development sign-in bypass, offline data,
localStorage draft, or sample data in application routes. The ordinary browser regression suite intercepts requests with synthetic fixtures;
those tests do not qualify backend authorization, PostgreSQL transactions,
Elasticsearch, or company integrations. The opt-in real HTTPS test below uses the
actual API and an isolated PostgreSQL database.

## Run

Use Node.js 22.17 or newer. Exact packages and integrity hashes are in
`frontend/package-lock.json`; tested locally with Node 22.17.1 and npm 10.9.2.

```powershell
cd frontend
npm ci
$env:APPCHI_BACKEND_URL = 'http://127.0.0.1:8000'
npm run dev
```

The URL above is an isolated development binding, not a company service endpoint.
Open `http://127.0.0.1:3000`. Without configured backend identity, the sign-in shell
shows a connection/authentication failure instead of synthetic operational data.
The backend origin is server-only and supplies `/api` and `/auth` rewrites. In
production the approved ingress must route those paths to Python under the same
HTTPS origin. The frontend sends authenticated commands; Python owns authorization and
transactional mutation semantics. The frontend does not exchange OIDC tokens.

```powershell
npm run generate
npm run format:check
npm run typecheck
npm run build
npx playwright install chromium
npm test
```

The generated OpenAPI file is `frontend/src/lib/generated.ts`. Regenerate it after
the coordinator updates `contracts/openapi.json`. The generated `openapi-fetch`
client supplies session access and generated models supply alert-command fields.
The remaining transport wrapper enforces the documented JSON envelope and no-store
credentials/CSRF rules. Backend response models and generated method coverage are
still incomplete; handwritten response views are not proof of complete schema
conformance.

For an already installed browser, set `PLAYWRIGHT_CHANNEL=chrome` or `msedge`.
This is an explicit alternative test environment, not the pinned browser build.
The local pinned Chromium download timed out on all five attempts. Tests were run
with installed Chrome 153.0.8010.48 through Playwright 1.63.0 instead.

## Real browser/API/PostgreSQL smoke

`tests/integration-real.spec.ts` is opt-in and uses no Playwright route mocks. It
requires the backend virtual environment, a local PostgreSQL administrator role
that can create/drop disposable databases, installed frontend dependencies, and a
Playwright-supported browser. The administrator URL below is the isolated local
development cluster used in this workspace, not a company binding.

```powershell
cd frontend
$env:APPCHI_REAL_BROWSER_DATABASE_ADMIN_URL = 'postgresql://appchi_migrator@127.0.0.1:55432/postgres'
$env:PLAYWRIGHT_CHANNEL = 'chrome'
node node_modules/@playwright/test/cli.js test tests/integration-real.spec.ts --reporter=list
Remove-Item Env:APPCHI_REAL_BROWSER_DATABASE_ADMIN_URL
```

An optional `APPCHI_REAL_BROWSER_PYTHON` selects another backend Python executable;
otherwise the test uses `backend/.venv`. With this opt-in environment variable set,
the ordinary Playwright port-3100 server is disabled. Run the integration file
explicitly, then clear the variable before running the ordinary browser suite.

The fixture creates a randomly named `appchi_browser_test_<hex>` database, applies
the real migrations, inserts one synthetic verified principal and a hashed opaque
session with encrypted CSRF material, and opens the human-auth gate only in that
disposable database. It admits a native v1 alert and runs the real source processor.
It then launches the actual Uvicorn API and Next.js HTTPS server on dynamically
allocated loopback ports. A short-lived self-signed test certificate permits a real
Secure, HttpOnly `__Host-appchi_session` cookie; certificate verification is relaxed
only in the test browser/request context.

The browser loads authoritative alert detail, assigns it to the signed-in user, and writes a note
through the UI and same-origin API. Direct PostgreSQL assertions confirm the
assignment, one persisted note, and revision `3`. Finally the fixture stops
only its own process trees, drops only its validated generated database name, and
removes only its verified temporary certificate directory. No test behavior or
credential acceptance path is added to application code.

Pre-REV-27 executed result (the earlier acknowledgement workflow): **1 passed in 28.8 seconds** (test body 26.7 seconds) against real
local PostgreSQL and HTTPS Next.js/FastAPI with installed Chrome 153.0.8010.48.
A follow-up catalog query confirmed zero remaining `appchi_browser_test_*`
databases and no remaining fixture Next.js/Uvicorn processes. TypeScript
validation also passed. This establishes
one real UI/API/database workflow; it does not qualify Keycloak sign-in, LDAP,
Elasticsearch, Kafka, Redis, company integrations, capacity, or production readiness.

## Connected workflows

- Session sign-in link, sign-out, current identity/tenant/role, scoped navigation,
  foreground activity heartbeat, session reauthorization and access-loss clearing.
- Alert CEL/text/suppression query, exact decimal count presentation, snapshot page
  controls, detail, lifecycle, derived ownership status, one self/other/unassign menu, notes
  create/edit/delete, history/occurrences/source reads and explicit bulk status.
- Incident lists default to Active, last activity descending, and 50 rows.
  Active/Resolved/All views combine with status, severity, assignee (me, unassigned,
  or user UUID), source, originating-rule UUID, linked-alert UUID, exact incident
  UUID, and created/activity/resolved time ranges. Text search uses ANDed
  case-insensitive terms from current title, description, and non-deleted notes.
  Sort by creation, activity, severity, or resolution in either direction; severity
  labels distinguish highest/lowest first, UUIDs break ties, and unresolved entries
  sort last by resolution time. Range inputs explicitly use UTC minute precision,
  inclusive lower bounds and exclusive upper bounds. Apply resets the cursor;
  refresh starts at page one with the applied filters. Page sizes are 50/100/200.
  Draft filters do not change the current request until applied. Pagination is live,
  not a frozen cross-page snapshot.
- Incident creation with explicit immutable severity, detail, title/description
  editing, status, assignment, note creation/edit/delete and retained revision
  history, including deleted-note discovery, plus linked/activity/cycle reads. Membership
  controls support candidate selection or explicit IDs for atomic link/unlink and
  moves with both observed incident revisions.
- The shared CEL editor discovers supported fields/functions from the server
  profile, offers caret-aware completion, and explicitly validates with the same
  compiler. Type/compile diagnostics preserve drafts and use Unicode-aware source
  positions; late validation cannot certify a changed expression.
- Shared presets with CEL, columns and sorting; dashboard definitions with preset
  references and keyboard panel ordering/dimensions and exact-integer thresholds; batched count presentation,
  provenance, pause, fullscreen and preset drill-through. Retained preset/dashboard
  history supports comparison and explicit Use this revision or Save as new draft.
  Deleted-history discovery preserves read-only evidence and permits a new identity;
  it does not undelete a resource or silently restore old links.
- Correlation create/edit/enable/disable/delete with candidate validation and
  selected-alert tests, diagnostics and paged history. Maintenance creation and
  metadata/timezone/schedule edits preserve the observed base revision, distinguish
  display-timezone changes from UTC endpoint changes, and expose repeated-local-time
  choices from the server timezone catalog and authoritative validation, including
  DST gaps/folds and pinned timezone evidence. Active-window edits omit locked
  CEL/start fields; ended windows permit metadata/timezone changes only. Server validation/test
  results supply schedule evidence; current matches never claim transition proof.
- Saved preset preview includes text/suppression controls, decimal totals, stale
  observations and server cursor paging. Unsaved preset/dashboard candidates can be
  validated and previewed, with dashboard previews bound to referenced preset
  revisions. Live saved dashboard counts show projection/suppression updating state.
- Tenant-admin operator setup, rename, deletion, provisioning retry/cancel, key
  creation/rotation and immediate individual/all-key revocation. Prepared keys stay
  unavailable; explicit current-key Copy sends the dedicated POST response directly
  to the clipboard without rendering or persistent browser storage. Audit is paged.
  Missing remote capability/provisioner support stays pending or needs attention;
  the durable worker interface does not establish company Kong/Grafana qualification.
- Tenant-admin permission editing uses verified directory users/teams, atomic
  explicit-grant batches and the roster response revision; conflicts retain the
  draft. Alert/incident assignment uses verified eligible-user directory search,
  showing pending matches without making them selectable. Bulk alert controls
  include lifecycle and assignment actions while retaining selected revisions.
  Tenant/platform audit is a paged read view with applied filters and malformed
  response handling. Global-super-admin controls include tenant creation, platform
  health/audit and source-head repair with a reason and observed generation.
  Configuration histories,
  references and maintenance alert membership have cursor controls.

Requests abort on scope changes, reject late responses, coalesce repeated resource
refreshes, retain an uncertain mutation's exact original UUID/body, and keep draft
base revisions during remote updates. Alert bulk selections retain the revisions
observed when selected. Configuration drafts and note text remain in tab memory;
explicit navigation warns about discarding them. Shared saves, errors and deletion
confirmations are visible text, not toast-only feedback.

The UI uses semantic tables/forms, labels, keyboard controls, a skip link, focus
outlines, the supplied light palette as the default, a persisted user-selected dark palette, reduced-motion support and responsive layouts. The 2026-09-24 [UI design mapping](ui-design.md) records the supplied reference and the later dark-mode request; an explicit user selection controls the theme.
Assistant-selected implementation targets are corporate desktop LCP 2,500 ms,
INP 200 ms and CLS 0.1 at p75; initial route JS target 200 KiB gzip; Lighthouse
accessibility 95/performance 90. These are unmeasured development targets, not
release guarantees. The named accessibility owner has not been supplied.

## Evidence and remaining scope

An earlier complete controlled browser run executed **72 cases: 71 passed and
1 skipped in 1.6 minutes**, using installed Chrome through Playwright 1.63.0.
The skipped case is the opt-in real HTTPS test, separately passed as recorded
above. Fresh formatting and TypeScript checks passed after the browser run.
The optimized production build also passed with Next.js 16.3.5. No application
changes were needed during this final verification run.

Exact commands, executed sequentially from `frontend`:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
node node_modules/@playwright/test/cli.js test --reporter=list
node node_modules/prettier/bin/prettier.cjs --check src tests *.ts *.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/next/dist/bin/next build
```

These explicit Node entry points avoid this workstation's broken roaming
`npm.ps1` shim. Standard package scripts remain available with a working npm
installation. The Windows browser run needed permission to terminate its own
Next.js process tree; it exited successfully and cleaned up without manual
intervention. Do not run another Next.js server/build in the same output directory
while the browser suite owns it.

Controlled coverage includes API failure versus empty results, decimal precision,
viewer restrictions, directory assignment and permission conflicts, uncertain
UUID/body retries, note revision/deletion history, stale responses, access loss,
incident filters and cursor reset, severity/CSRF, captured bulk revisions, explicit
moves, keyboard/mobile/dark presentation, CEL discovery/validation, retained
configuration comparison/reuse, DST schedule validation and phase restrictions,
operator prepared-key/clipboard/replacement behavior, and platform administration.
Fourteen transport/workspace cases cover bounded SSE frames and heartbeat silence,
reconnect backoff, hidden lifecycle, authorization denial, fixed refresh coalescing,
and stalled reconciliation requests. Browser route mocks are not real-service
end-to-end qualification.

`frontend/Dockerfile` builds from the repository root and serves standalone
Next.js output as a non-root user. Its Node image tag is an assistant-selected
development runtime, not a verified production image digest. The container build
and OpenShift execution have not been run in this environment.

Remaining frontend qualification includes diagnostic drill-through completeness,
render-observation telemetry and relative-time one-second refresh, complete
dashboard batch-retry acceptance and real counts/preview integration coverage.
CSP/nonce and gateway security acceptance, a full WCAG audit, measured performance,
and broader authenticated real-service browser qualification remain release gates.
The local checks do not qualify private Keycloak/LDAP/Kong/Grafana bindings,
production capacity, or deployment readiness, and do not mark the entire initial
release complete.

Correlation-rule details and unsaved editor drafts now expose an explicit current
alert test for viewers and editors. The request carries the displayed definition,
an existing alert UUID and CSRF, without creating a command. Results distinguish
true, false and unavailable condition evaluations, preserve typed grouping values,
show eligibility exclusions and the server snapshot time/revision, and explain
that a current match does not establish a qualifying transition or window.
Definition, alert identifier and authorization-context changes discard old
results and cancel pending requests. The existing generic editor still validates
the definition; correlation testing uses the dedicated result presentation.

The focused controlled Chrome suite `tests/correlation-tester.spec.ts` passed all
six cases in 39.7 seconds after this addition. It covers viewer CSRF/body shape,
string/boolean grouping, exact revision strings, stale draft responses, invalid
UUIDs, validation diagnostics, unavailable grouping, incompatible unsafe numeric
responses, rejected qualification claims and authorization loss. These mocks do
not expand the server's grouping-field whitelist or establish real-service
correlation qualification. TypeScript and formatting checks also passed; this
addition has not yet received a fresh full browser-suite or production-build run.

A subsequent keyboard pass fixed focus loss when shared-definition editing
replaces its triggering button: focus enters the first enabled editor control and
returns to the edit action after save or discard. Native browser confirmation
dialogs remain native; the application does not introduce a custom modal or focus
trap. CEL completion lists now expose autocomplete semantics and dismiss on Tab
without intercepting normal focus movement. Current validation, size and service
errors are associated with the expression control; only invalid content marks
the input invalid, and changed drafts lose obsolete diagnostic associations.
Uncertain-command guidance is a live status alongside the existing visible error.

The CEL editor and configuration-history Chrome suites passed all 13 cases in
20.9 seconds after these changes, including two new keyboard cases and enhanced
error-association/status assertions. TypeScript and touched-file formatting also
passed. This verifies the selected interactions, not a full WCAG audit, native
screen-reader qualification, or every form's field-error association.

Maintenance and correlation lists now expose deleted-history discovery. Retained
history URLs read the history APIs directly, page immutable revisions and open
the selected revision even when the active resource no longer exists. These
screens are read-only; expired content and authorization loss clear the displayed
evidence. Maintenance also exposes Current and upcoming, Ended and All list modes.

Saved maintenance details offer viewers the same explicit current-alert test used
by candidate drafts. The assistant-selected saved-window endpoint receives only
the alert ID and expected window revision; it evaluates the stored CEL and UTC
endpoints, including ended windows, without reconstructing a local-time schedule.
Results show schedule coverage separately from enabled intent and explicitly deny
transition qualification. Changed window revisions cancel obsolete test responses.
Four isolated PostgreSQL cases passed in 5.38 seconds for ended/disabled viewer
testing, CSRF, stale/missing resources, compile-time changes and absence of command,
history or activity-clock writes. The combined temporal-history, maintenance-editor
and alert-evidence Chrome run passed 11 cases in 28.5 seconds after test-fixture
corrections; TypeScript and touched-file formatting also passed. This is focused
local evidence, not private-service or production qualification.


## Current integrated verification checkpoint — 2026-09-23

The completed controlled Chrome checkpoint passed **97 tests with one real-backend case
skipped in 4.1 minutes**, including null-body 401/403 denial and draft clearing. The skipped opt-in case then ran separately and passed
in **34.5 seconds**, exercising real HTTPS, Next.js, FastAPI and an isolated
PostgreSQL database. Formatting, TypeScript and the optimized production build
also passed. These results supersede the earlier incremental browser/build
checkpoints above; they do not qualify installed SSO, private services or a full
accessibility standard.

The integrated run includes dashboard relative-clock refresh/coalescing,
pause/fullscreen keyboard behavior, configuration/history discovery, preset
selection beyond the first result page, source JSON escaping, deleted alert note
history, and access-loss clearing. Production actor labels now use immutable
recorded display names, with ID fallback for older history lacking a snapshot.
Browser fixtures use controlled responses except for the explicitly separate
real-service case. They are not a product authentication path.

The latest UI redesign continuation supersedes those frontend checkpoints: **111 controlled Chrome cases passed and 7 opt-in environment cases were skipped in 3.4 minutes** on 2026-09-24. Formatting, TypeScript, the isolated production build, five display-name unit checks and generated contract checks also passed. Custom preset column choices now render in saved/draft order while the reference's default layout is preserved. See [implementation status](https://github.com/appchi-alert-operations/appchi-delivery/blob/main/status/implementation-status.md#ui-redesign-continuation--2026-09-24) and [UI review evidence](https://github.com/appchi-alert-operations/appchi-delivery/blob/main/qualification/ui-redesign-2026-09-24/README.md) for scope, outputs and remaining limitations.
