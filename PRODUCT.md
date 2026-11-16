# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Operations and NOC teams inside one large organization. Operators work at desk
monitors through a shift: they watch the Feed, open alerts, assign them to
themselves or a colleague, write notes, open and work incidents, and set
maintenance windows. Dashboards also run fullscreen on shared NOC wall displays
that people read from across the room (user, 2026-10-25).

Tenant administrators set up operators (v2 alert senders and their API keys),
grant users and teams view/edit/admin access, and read the access audit. Global
super-admins create tenants and read platform health and audit.

## Product Purpose

Keep is an internal, multi-tenant alert operations system. It receives v1
(fixed Global tenant) and v2 (per-tenant, through managed operators and Grafana)
alerts, keeps one evolving row per logical alert with its occurrence and source
history, and provides CEL-queried feeds, shared presets, incidents, automatic
correlation, maintenance suppression and shared count dashboards.

It is being proposed as the replacement for the organization's KeepHQ fork,
whose core the organization uses: ingestion, feed, presets, incidents,
maintenance and dashboards. Success means operators see what is firing, trust
the counts and freshness they are shown, and take ownership without friction.

## Positioning

- One row per logical alert, not per delivery: resolve-then-fire starts a new
  occurrence on the same row, with history readable in place.
- Assignment is the only ownership control. Status is derived: Firing
  (firing, unassigned), Acknowledged (firing, assigned), Resolved.
- CEL everywhere (feeds, presets, rules, maintenance), validated by the same
  server compiler, with caret-aware completion.
- Test before activation: maintenance windows and correlation rules can be
  tested against a real current alert before saving.
- Every shared configuration keeps retained revisions with comparison,
  "Use this revision" and "Save as new draft"; concurrent edits are detected.
- Exact logical-alert counts and explicit freshness: live, updating, stale and
  uncertain states are shown, never hidden.
- Database-enforced tenant isolation; access and platform audit.

## Operating Context

- Closed corporate network; deployed on OpenShift. Pages must not depend on
  external hosts at runtime (fonts are served locally).
- Company username-and-password sign-in on Keep's own `/sign-in` page: one
  LDAP bind against Active Directory, people and groups from ADAPI (REV-73).
  Sessions last 24 hours from sign-in, with no idle timeout; sign-out is
  local to Keep.
- Alerts arrive from Grafana contact points and other senders; a tenant can see
  "alerts arriving late" when source processing is blocked.
- Desk monitors (primary) and NOC wall displays (dashboards fullscreen).
- Local development stack: https://localhost:3443 with real local data.

## Capabilities and Constraints

- Areas: Feed (formerly "Alerts"; `/alerts` URLs and alert terminology for
  records remain), alert detail, incidents, presets, correlation rules,
  maintenance, dashboards, operators, permissions, access audit, platform.
- Roles per tenant: view, edit, admin; Global is edit for every eligible user
  and administered only by global super-admins.
- Light appearance is the default; a user can select dark, remembered per
  device (REV-24 sun/moon switch).
- Feedback for saves, errors and deletions is visible text, not toast-only.
  Native confirmation dialogs remain native; the alert JSON viewer is a native
  modal dialog.
- Drafts live in tab memory; navigation warns before discarding them.
- Behavior, routes, API calls, permissions and copy are specified in
  `keep-design/specs`; visual work must not change them.
- Undecided: product logo/mark (the current "A" square is a placeholder).

## Brand Commitments

- Name: Keep. Nothing else from the current look is binding (user,
  2026-10-25).
- The user does not want it to feel like a generic SaaS admin dashboard, a
  hacker/neon dark console, or a playful consumer app (user, 2026-10-25).
- Standing preference (user, 2026-10-25, after two rejected direction hands):
  the current interface is the best so far because "it is simple and looks
  good in the eye". New visual work must be at least as simple and calm. Use a
  real colour palette, not black-and-white or grayscale, and keep any borrowed
  world light.

## Evidence on Hand

- Real local data in the development stack (2 tenants, 41 alerts, 2 incidents,
  4 presets, 1 dashboard, 2 correlation rules, 1 maintenance window,
  1 operator as of 2026-10-25).
- No customer testimonials, adoption figures, benchmarks or production
  qualification. Do not invent counts, users, capacity or readiness claims;
  live responses determine every number shown.

## Product Principles

1. Truth over reassurance: freshness, uncertainty, staleness and failure are
   always visible and specific.
2. Scanning first: an operator finds what is firing and unowned in seconds.
3. Every change leaves evidence: revisions, history and audit are first-class.
4. Explicit over automatic: validate, test, then save; nothing changes silently.
5. One truth at the desk and on the wall.

## Accessibility & Inclusion

Semantic tables and forms, labelled controls, full keyboard operation, skip
link, visible focus, reduced-motion support and responsive layouts are existing
requirements. Assistant-selected targets: Lighthouse accessibility 95; a full
WCAG audit is an outstanding release gate.
