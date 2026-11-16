"use client";
import { useEffect, useState } from "react";
import { display, RecordData, tenantPath } from "@/lib/api";
import { useCommand, useDirtyWarning, useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { CommandFeedback, ErrorNotice } from "./ui";
import { NavLink, Page } from "./page";
import {
  Chip,
  currentKeyText,
  integrationChip,
  lifecycleChip,
  OperatorCreate,
  OperatorDetail,
  routingLabel,
} from "./operations";
import { AuditBrowser } from "./audit-browser";
import {
  DirectoryPicker,
  initials,
  type DirectoryPrincipal,
  type ExplicitGrant,
} from "./directory-picker";

/** Routes the administration list, detail and editor screens. */
export function AdminPages(scope: Scope & { section: string; id?: string }) {
  if (scope.section === "audit")
    return <AuditBrowser key={scope.tenant.id} scope={scope} />;
  if (scope.section === "permissions")
    return <PermissionsPage key={scope.tenant.id} scope={scope} />;
  if (scope.id === "new") return <OperatorCreate {...scope} />;
  if (scope.id)
    return (
      <OperatorDetail
        key={`${scope.tenant.id}:${scope.id}`}
        {...scope}
        id={scope.id}
      />
    );
  return <OperatorList key={scope.tenant.id} {...scope} />;
}

const subtitle = (text: string) => <span className="adm-subtitle">{text}</span>;

/* ------------------------------------------------------------- S16 list */

function OperatorList(scope: Scope) {
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState(""),
    [lifecycle, setLifecycle] = useState(""),
    [health, setHealth] = useState(""),
    [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilter((previous) => {
        if (previous !== search.trim()) setCursor(null);
        return search.trim();
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({ limit: "50" });
  if (filter) params.set("name", filter);
  if (cursor) params.set("cursor", cursor);
  const result = useResource<RecordData[]>(
    `${tenantPath(scope.tenant.id)}/operators?${params}`,
    scope.onDenied,
    cursor ? 0 : scope.version,
  );
  const rows = Array.isArray(result.data?.data) ? result.data.data : null;
  const invalid = !!result.data && !rows;
  const visible = (rows ?? []).filter(
    (row) =>
      (!lifecycle || lifecycleChip(row.lifecycle)[0] === lifecycle) &&
      (!health || integrationChip(row.integration_health)[0] === health),
  );
  const create =
    scope.tenant.role === "admin" && scope.tenant.kind !== "global";
  const base = `/tenants/${scope.tenant.id}/operators`;
  return (
    <Page
      scope={scope}
      title="Operators"
      crumbs={[{ label: "Administration" }]}
      extra={subtitle(
        `Alert sources that send to ${scope.tenant.name} with their own keys`,
      )}
      className="adm-page"
      actions={
        create && (
          <button
            type="button"
            className="btn btn-p"
            onClick={() => scope.navigate(`${base}/new`)}
          >
            New operator
          </button>
        )
      }
    >
      <div className="adm-toolbar">
        <label className="sr-only" htmlFor="operator-search">
          Search operators
        </label>
        <input
          id="operator-search"
          className="inp adm-search"
          placeholder="Search operators by name"
          value={search}
          maxLength={128}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="inp"
          aria-label="Lifecycle"
          value={lifecycle}
          onChange={(event) => setLifecycle(event.target.value)}
        >
          <option value="">Any lifecycle</option>
          <option>Setup pending</option>
          <option>Ready</option>
          <option>Deleted</option>
        </select>
        <select
          className="inp"
          aria-label="Integration health"
          value={health}
          onChange={(event) => setHealth(event.target.value)}
        >
          <option value="">Any health</option>
          <option>In sync</option>
          <option>Pending</option>
          <option>Needs attention</option>
        </select>
      </div>
      <ErrorNotice error={result.error} />
      <ErrorNotice
        error={
          invalid
            ? new Error(
                "The operator response does not match its API contract. Refresh to try again.",
              )
            : undefined
        }
      />
      <div className="panel table-panel">
        <div role="table" aria-label="Operators" className="table-body">
          <div role="row" className="row head g-op">
            <span role="columnheader">Operator</span>
            <span role="columnheader">Lifecycle</span>
            <span role="columnheader">Integration</span>
            <span role="columnheader">Current key</span>
            <span role="columnheader">Grafana routing label</span>
            <span role="columnheader">Revision</span>
          </div>
          {visible.map((row) => (
            <div role="row" key={row.id} className="row g-op adm-op-row">
              <span role="cell" className="adm-op-name">
                <NavLink
                  scope={scope}
                  href={`${base}/${row.id}`}
                  className="lnk"
                >
                  {display(row.name)}
                </NavLink>
                {typeof row.pending_name === "string" && row.pending_name ? (
                  <span className="small muted cell">
                    Renaming to {row.pending_name}
                  </span>
                ) : row.deletion_pending ? (
                  <span className="small muted cell">Deletion pending</span>
                ) : null}
              </span>
              <span role="cell">
                <Chip value={lifecycleChip(row.lifecycle)} />
              </span>
              <span role="cell">
                <Chip value={integrationChip(row.integration_health)} />
              </span>
              <span role="cell" className="small cell">
                {currentKeyText(row)}
              </span>
              <span role="cell" className="cell mono small">
                {routingLabel(row.name)} = true
              </span>
              <span role="cell" className="mono small">
                {display(row.revision)}
              </span>
            </div>
          ))}
          {result.loading && !rows && (
            <div className="adm-empty-row" role="status">
              Loading operators…
            </div>
          )}
          {rows && !visible.length && (
            <div className="adm-empty-row">
              {rows.length || filter
                ? "No operators match these filters."
                : create
                  ? "No operators yet. Create one to give an alert source its own key."
                  : "No operators send to this tenant."}
            </div>
          )}
        </div>
        {(cursor || result.data?.next_cursor) && (
          <div className="table-footer-bar">
            <span>
              {result.data && (result.loading || !!result.error)
                ? "Previous successful records · updating"
                : "Sorted by name"}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-g"
              disabled={!cursor}
              onClick={() => setCursor(null)}
            >
              First page
            </button>
            <button
              type="button"
              className="btn btn-sm btn-g"
              disabled={!result.data?.next_cursor || result.loading}
              onClick={() => setCursor(result.data?.next_cursor ?? null)}
            >
              Next page
            </button>
          </div>
        )}
      </div>
    </Page>
  );
}

/* ------------------------------------------------------ S18 permissions */

type Role = "view" | "edit" | "admin";
const roleName = (role: unknown) =>
  role === "admin" ? "Admin" : role === "edit" ? "Edit" : "View";
type Edit = {
  principal_id: string;
  label: string;
  kind: "user" | "team";
  action: "set" | "remove";
  role?: Role;
};

function RolesHelp({ tenant }: { tenant: string }) {
  return (
    <aside className="adm-col">
      <section className="panel adm-help-panel">
        <span className="lbl">Roles</span>
        <div className="adm-roles">
          <div>
            <b>View</b>{" "}
            <span className="muted">
              — see alerts, incidents, presets and dashboards.
            </span>
          </div>
          <div>
            <b>Edit</b>{" "}
            <span className="muted">
              — act on alerts and incidents, change shared presets, rules,
              maintenance and dashboards.
            </span>
          </div>
          <div>
            <b>Admin</b>{" "}
            <span className="muted">
              — everything above, plus operators, permissions and the access
              audit.
            </span>
          </div>
        </div>
      </section>
      <section className="panel adm-help-panel" style={{ gap: 8 }}>
        <span className="lbl">How grants combine</span>
        <p className="help">
          Team and direct grants combine and the highest role wins. Changes are
          saved together, and every save must leave {tenant} with at least one
          eligible administrator.
        </p>
      </section>
    </aside>
  );
}

function PermissionsPage({ scope }: { scope: Scope }) {
  if (scope.tenant.role !== "admin")
    return (
      <Page
        scope={scope}
        title="Permissions"
        crumbs={[{ label: "Administration" }]}
        className="adm-page"
      >
        <div className="panel adm-notice-panel">
          <p className="notice">
            Permissions require tenant administration access.
          </p>
        </div>
      </Page>
    );
  return <GrantEditor scope={scope} />;
}

function GrantEditor({ scope }: { scope: Scope }) {
  const result = useResource<ExplicitGrant[]>(
    `${tenantPath(scope.tenant.id)}/permissions`,
    scope.onDenied,
    scope.version,
  );
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const [edits, setEdits] = useState<Edit[]>([]);
  const revisionValue = result.data?.meta?.revision;
  const revision = typeof revisionValue === "string" ? revisionValue : null;
  const [base, setBase] = useState<string | null>(null);
  const [pick, setPick] = useState<DirectoryPrincipal & { id: string }>();
  const [addRole, setAddRole] = useState<Role>();
  const [pickerKey, setPickerKey] = useState(0);
  const frozen = command.busy || command.uncertain;
  const dirty = edits.length > 0 || command.uncertain;
  // REV-71: a tenant created without grants, or one whose last eligible
  // administrator was lost, needs one before this page is left.
  const adminRequired = result.data?.meta?.has_local_admin === false;
  const addsAdmin = edits.some(
    (item) => item.action === "set" && item.role === "admin",
  );
  const newRole = addRole ?? (adminRequired && !addsAdmin ? "admin" : "view");
  const leaving = adminRequired
    ? `${scope.tenant.name} has no administrator. Leave without saving one? Choose Cancel to stay and add an administrator.`
    : dirty;
  useDirtyWarning(!!leaving);
  useEffect(() => {
    scope.setDirty(leaving);
    return () => scope.setDirty(false);
  }, [leaving, scope.setDirty]);
  const grants = Array.isArray(result.data?.data) ? result.data.data : null;
  const invalid = !!result.data && !grants;
  const effectiveBase = edits.length || command.uncertain ? base : revision;
  const stale =
    edits.length > 0 && revision !== null && base !== null && base !== revision;
  function edit(value: Edit) {
    if (frozen) return;
    if (!edits.length) setBase(revision);
    const grant = grants?.find((g) => g.principal_id === value.principal_id);
    setEdits((current) => {
      const rest = current.filter(
        (item) => item.principal_id !== value.principal_id,
      );
      // Choosing the saved role again cancels the pending change.
      if (grant && value.action === "set" && value.role === grant.role)
        return rest;
      return [...rest, value];
    });
  }
  const discard = (principal: string) =>
    setEdits((current) =>
      current.filter((item) => item.principal_id !== principal),
    );
  const capped = (principal: string) =>
    edits.length >= 100 && !edits.some((e) => e.principal_id === principal);
  const added = edits.filter(
    (item) =>
      item.action === "set" &&
      !grants?.some((grant) => grant.principal_id === item.principal_id),
  );
  const count = edits.length;
  async function save() {
    const result2 = await command.execute(
      `${tenantPath(scope.tenant.id)}/permissions`,
      {
        expected_revision: effectiveBase,
        operations: edits.map(({ principal_id, action, role }) =>
          action === "set"
            ? { principal_id, action, role }
            : { principal_id, action },
        ),
      },
      "PATCH",
    );
    if (result2) {
      setEdits([]);
      result.reload();
      scope.onDenied();
    }
  }
  const self = scope.session.principal.id;
  const noteFor = (grant: ExplicitGrant) =>
    grant.deleted
      ? "Deleted from the company directory"
      : !grant.eligible
        ? "Not eligible in the company directory"
        : grant.principal_id === self
          ? "You"
          : grant.kind === "team"
            ? "Company directory team"
            : "Company directory user";
  return (
    <Page
      scope={scope}
      title="Permissions"
      crumbs={[{ label: "Administration" }]}
      extra={subtitle(`Who can view, edit or administer ${scope.tenant.name}`)}
      className="adm-page"
      actions={
        <>
          <button
            type="button"
            className="btn btn-g"
            disabled={frozen || !count}
            onClick={() => setEdits([])}
          >
            Discard all
          </button>
          <button
            type="button"
            className="btn btn-p"
            disabled={
              command.busy ||
              (!command.uncertain &&
                (!count || stale || !revision || (adminRequired && !addsAdmin)))
            }
            onClick={() => void save()}
          >
            {command.uncertain
              ? "Retry original grant change"
              : count
                ? `Save ${count} change${count === 1 ? "" : "s"}`
                : "Save changes"}
          </button>
        </>
      }
    >
      <ErrorNotice error={result.error} />
      <ErrorNotice
        error={
          invalid
            ? new Error(
                "The permissions response does not match its API contract. Refresh to try again.",
              )
            : undefined
        }
      />
      {result.data && !revision && (
        <p className="notice">
          The permissions revision is unavailable. Refresh before editing
          grants.
        </p>
      )}
      {stale && (
        <div className="banner bn-warn" role="status">
          <span>
            <b>Permissions changed while this draft was open.</b> Review the
            current grants before using the latest revision.
          </span>
          <span className="adm-spacer" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={frozen}
            onClick={() => setBase(revision)}
          >
            Use current revision after review
          </button>
        </div>
      )}
      {adminRequired && (
        <div className="banner bn-warn" role="status">
          <span>
            <b>{scope.tenant.name} has no administrator.</b> Add a user or team
            with the Admin role and save before leaving this page.
          </span>
        </div>
      )}
      {(command.error || command.uncertain) && (
        <CommandFeedback command={command} />
      )}
      <div className="adm-split adm-split-360">
        <section
          className="panel table-panel"
          aria-label="Explicit grants"
          style={{ overflow: "visible" }}
        >
          <div className="panel-h adm-add-row">
            <DirectoryPicker
              key={pickerKey}
              endpoint={`${tenantPath(scope.tenant.id)}/permission-principals`}
              resolve={{
                endpoint: `${tenantPath(scope.tenant.id)}/permission-principals/resolve`,
                csrf: scope.session.csrf_token,
              }}
              label="Add a user or team from the company directory"
              placeholder="Add a user or team from the company directory"
              labelHidden
              floating
              searchOnType
              showSearchButton={false}
              disabled={frozen || edits.length >= 100 || !revision}
              onDenied={scope.onDenied}
              onQueryChange={(query) => {
                if (pick && query !== pick.display_name) setPick(undefined);
              }}
              onChoose={(principal) => {
                setPick(principal);
                const existing = grants?.find(
                  (grant) => grant.principal_id === principal.id,
                );
                if (existing) setAddRole(existing.role);
              }}
              trailing={
                <>
                  <select
                    className="inp"
                    aria-label="Role for new grant"
                    value={newRole}
                    disabled={frozen}
                    onChange={(event) => setAddRole(event.target.value as Role)}
                  >
                    <option value="view">View</option>
                    <option value="edit">Edit</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    type="button"
                    className="btn"
                    disabled={!pick || frozen || capped(pick.id)}
                    onClick={() => {
                      if (!pick) return;
                      edit({
                        principal_id: pick.id,
                        label: pick.display_name,
                        kind: pick.kind,
                        action: "set",
                        role: newRole,
                      });
                      setPick(undefined);
                      setAddRole(undefined);
                      setPickerKey((value) => value + 1);
                    }}
                  >
                    Add
                  </button>
                </>
              }
            />
          </div>
          <div className="table-body adm-table-scroll">
            <div role="table" aria-label="Explicit grants">
              <div role="row" className="row head g-pm">
                <span role="columnheader">User or team</span>
                <span role="columnheader">Type</span>
                <span role="columnheader">Role</span>
                <span role="columnheader">Change</span>
                <span role="columnheader">
                  <span className="sr-only">Remove</span>
                </span>
              </div>
              {grants?.map((grant) => {
                const pending = edits.find(
                  (item) => item.principal_id === grant.principal_id,
                );
                const ineligible = grant.deleted || !grant.eligible;
                const role =
                  pending?.action === "set" && pending.role
                    ? pending.role
                    : grant.role;
                return (
                  <div
                    role="row"
                    key={grant.principal_id}
                    className={`row g-pm adm-pm-row${pending ? " r-pend" : ineligible ? " r-res" : ""}`}
                  >
                    <span role="cell" className="adm-principal">
                      <span className="adm-avatar" aria-hidden="true">
                        {initials(grant.display_name)}
                      </span>
                      <span className="adm-principal-text">
                        <span className="cell">{grant.display_name}</span>
                        <span className="cell small muted">
                          {noteFor(grant)}
                        </span>
                      </span>
                    </span>
                    <span role="cell" className="small">
                      {grant.kind === "team" ? "Team" : "User"}
                    </span>
                    <span role="cell">
                      <select
                        className="inp adm-role"
                        aria-label={`Role for ${grant.display_name}`}
                        value={role}
                        disabled={
                          frozen ||
                          pending?.action === "remove" ||
                          capped(grant.principal_id)
                        }
                        onChange={(event) =>
                          edit({
                            principal_id: grant.principal_id,
                            label: grant.display_name,
                            kind: grant.kind,
                            action: "set",
                            role: event.target.value as Role,
                          })
                        }
                      >
                        <option value="view">View</option>
                        <option value="edit">Edit</option>
                        <option value="admin">Admin</option>
                      </select>
                    </span>
                    <span role="cell" className="adm-chips">
                      {pending?.action === "set" && (
                        <span className="chip b-amber">
                          {roleName(grant.role)} → {roleName(pending.role)}
                        </span>
                      )}
                      {pending?.action === "remove" && (
                        <span className="chip b-red">Will be removed</span>
                      )}
                      {ineligible && (
                        <span className="chip b-red">Ineligible identity</span>
                      )}
                    </span>
                    <span role="cell" className="adm-row-actions">
                      {pending?.action === "remove" ? (
                        <button
                          type="button"
                          className="ibtn"
                          disabled={frozen}
                          aria-label={`Keep grant for ${grant.display_name}`}
                          onClick={() => discard(grant.principal_id)}
                        >
                          Undo
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ibtn"
                          disabled={frozen || capped(grant.principal_id)}
                          aria-label={`Remove grant for ${grant.display_name}`}
                          onClick={() =>
                            edit({
                              principal_id: grant.principal_id,
                              label: grant.display_name,
                              kind: grant.kind,
                              action: "remove",
                            })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
              {added.map((item) => (
                <div
                  role="row"
                  key={item.principal_id}
                  className="row g-pm adm-pm-row r-pend"
                >
                  <span role="cell" className="adm-principal">
                    <span className="adm-avatar" aria-hidden="true">
                      {initials(item.label)}
                    </span>
                    <span className="adm-principal-text">
                      <span className="cell">{item.label}</span>
                      <span className="cell small muted">
                        {item.principal_id === self
                          ? "You"
                          : item.kind === "team"
                            ? "Company directory team"
                            : "Company directory user"}
                      </span>
                    </span>
                  </span>
                  <span role="cell" className="small">
                    {item.kind === "team" ? "Team" : "User"}
                  </span>
                  <span role="cell">
                    <select
                      className="inp adm-role"
                      aria-label={`Role for ${item.label}`}
                      value={item.role}
                      disabled={frozen}
                      onChange={(event) =>
                        edit({ ...item, role: event.target.value as Role })
                      }
                    >
                      <option value="view">View</option>
                      <option value="edit">Edit</option>
                      <option value="admin">Admin</option>
                    </select>
                  </span>
                  <span role="cell">
                    <span className="chip b-amber">New grant</span>
                  </span>
                  <span role="cell" className="adm-row-actions">
                    <button
                      type="button"
                      className="ibtn"
                      disabled={frozen}
                      aria-label={`Discard new grant for ${item.label}`}
                      onClick={() => discard(item.principal_id)}
                    >
                      Remove
                    </button>
                  </span>
                </div>
              ))}
              {result.loading && !grants && (
                <div className="adm-empty-row" role="status">
                  Loading explicit grants…
                </div>
              )}
              {grants && !grants.length && !added.length && (
                <div className="adm-empty-row">
                  No explicit grants. Add a user or team from the company
                  directory.
                </div>
              )}
            </div>
          </div>
        </section>
        <RolesHelp tenant={scope.tenant.name} />
      </div>
    </Page>
  );
}
