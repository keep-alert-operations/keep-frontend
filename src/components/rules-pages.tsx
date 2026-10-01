"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  ApiError,
  display,
  type RecordData,
  request,
  tenantPath,
  timestamp,
} from "@/lib/api";
import { useCommand, useDirtyWarning, useResource } from "@/lib/hooks";
import type { Scope } from "./workspace";
import { NavLink, Page, Severity, personLabel, useConfirm } from "./page";
import { CelEditor } from "./cel-editor";
import { CorrelationTester } from "./correlation-tester";
import {
  Banner,
  CommandBanner,
  ErrorBanner,
  TemporalHistory,
  diagnosticMessages,
  titleCase,
} from "./temporal-history";

type RuleScope = Scope & { section: string; id?: string };
interface Condition {
  id: string;
  label: string;
  cel: string;
}
interface Draft {
  name: string;
  description: string;
  severity: string;
  conditions: Condition[];
  window: string;
  groupBy: string[];
}
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const HEALTH: Record<string, [string, string]> = {
  healthy: ["Healthy", "b-green"],
  delayed: ["Delayed", "b-amber"],
  blocked: ["Blocked", "b-red"],
  recovery_needed: ["Recovery needed", "b-red"],
};

/** Routes the correlation-rule list, detail/editor, creation and history. */
export function RulePages(scope: RuleScope) {
  const pathname = usePathname();
  if (scope.id && pathname.endsWith("/history"))
    return (
      <TemporalHistory
        key={`${scope.tenant.id}:rules:${scope.id}`}
        scope={scope}
        section="correlation-rules"
        id={scope.id}
      />
    );
  if (scope.id === "new")
    return <RuleEditor key={`${scope.tenant.id}:new`} scope={scope} />;
  if (scope.id)
    return (
      <RuleDetail
        key={`${scope.tenant.id}:${scope.id}`}
        scope={scope}
        id={scope.id}
      />
    );
  return <RuleList key={scope.tenant.id} scope={scope} />;
}

export function HealthChip({ value }: { value: unknown }) {
  const [label, tone] = HEALTH[String(value)] ?? [
    titleCase(value),
    "b-neutral",
  ];
  return <span className={`chip ${tone}`}>{label}</span>;
}
function StateChip({ enabled }: { enabled: unknown }) {
  return enabled ? (
    <span className="chip b-dark">Enabled</span>
  ) : (
    <span className="chip b-neutral">Disabled</span>
  );
}

/* ------------------------------------------------------------------ S10 */

function RuleList({ scope }: { scope: Scope }) {
  const [state, setState] = useState<"active" | "deleted">("active");
  const [search, setSearch] = useState(""),
    [name, setName] = useState("");
  const [enabled, setEnabled] = useState(""),
    [health, setHealth] = useState("");
  const [pages, setPages] = useState<{ cursor: string; offset: number }[]>([]);
  const page = pages[pages.length - 1];
  useEffect(() => {
    const timer = setTimeout(() => {
      setName(search.trim());
      setPages([]);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({ limit: "50", state });
  if (name) params.set("name", name);
  if (state === "active" && enabled) params.set("enabled", enabled);
  if (state === "active" && health) params.set("health", health);
  if (page) params.set("cursor", page.cursor);
  const result = useResource<RecordData[]>(
    `${tenantPath(scope.tenant.id)}/correlation-rules?${params}`,
    scope.onDenied,
    page ? 0 : scope.version,
  );
  const rows = Array.isArray(result.data?.data) ? result.data.data : null;
  const offset = page?.offset ?? 0;
  const base = `/tenants/${scope.tenant.id}/correlation-rules`;
  const canEdit = scope.tenant.role !== "view";
  const deleted = state === "deleted";
  return (
    <Page
      scope={scope}
      title="Correlation rules"
      crumbs={[{ label: "Correlation rules" }]}
      extra={
        <span className="page-subtitle">
          Group related alerts into incidents automatically
        </span>
      }
      actions={
        canEdit && (
          <button
            type="button"
            className="btn btn-p"
            onClick={() => scope.navigate(`${base}/new`)}
          >
            New rule
          </button>
        )
      }
    >
      <div className="rl-toolbar">
        <div className="seg" role="group" aria-label="Records">
          {(
            [
              ["active", "Active definitions"],
              ["deleted", "Deleted history"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={state === value}
              className={state === value ? "on" : undefined}
              onClick={() => {
                setState(value);
                setPages([]);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="rule-search">
          Search rules by name
        </label>
        <input
          id="rule-search"
          className="inp rl-search"
          placeholder="Search rules by name"
          value={search}
          maxLength={200}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="inp"
          aria-label="Status"
          value={enabled}
          disabled={deleted}
          onChange={(event) => {
            setEnabled(event.target.value);
            setPages([]);
          }}
        >
          <option value="">Enabled and disabled</option>
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
        <select
          className="inp"
          aria-label="Health"
          value={health}
          disabled={deleted}
          onChange={(event) => {
            setHealth(event.target.value);
            setPages([]);
          }}
        >
          <option value="">Any health</option>
          {Object.entries(HEALTH).map(([value, [label]]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <Banner tone="info">
        {deleted
          ? "Deleted rules keep their retained history for review. They no longer create or extend incidents."
          : "Rules are listed in evaluation order. When rules overlap, the earlier rule claims an eligible alert first."}
      </Banner>
      <ErrorBanner error={result.error} />
      <section className="panel table-panel grow">
        <div role="table" aria-label="Correlation rules" className="table-body">
          <div role="row" className="row head g-rule">
            <span role="columnheader">#</span>
            <span role="columnheader">Rule</span>
            <span role="columnheader">Severity</span>
            <span role="columnheader">Conditions</span>
            <span role="columnheader">Grouped by</span>
            <span role="columnheader">Window</span>
            <span role="columnheader">State</span>
            <span role="columnheader">Health</span>
            <span role="columnheader">
              {deleted ? "Deleted" : "Last change"}
            </span>
          </div>
          {rows?.map((row, index) => {
            const groups = Array.isArray(row.group_by)
              ? (row.group_by as string[])
              : [];
            const href = `${base}/${row.id}${deleted || row.deleted_at ? "/history" : ""}`;
            return (
              <div
                role="row"
                className="row g-rule rl-row alert-link-row"
                key={row.id}
              >
                <span role="cell" className="mono small muted">
                  {deleted ? "—" : offset + index + 1}
                </span>
                <span role="cell" className="rl-name">
                  <NavLink
                    scope={scope}
                    href={href}
                    className="lnk alert-row-link"
                  >
                    {display(row.name)}
                  </NavLink>
                  {row.description ? (
                    <span className="cell small muted">
                      {display(row.description)}
                    </span>
                  ) : null}
                </span>
                <span role="cell">
                  <Severity value={row.severity} />
                </span>
                <span role="cell" className="small">
                  {Array.isArray(row.conditions) ? row.conditions.length : "—"}
                </span>
                <span role="cell" className="cell mono small">
                  {groups.length ? groups.join(", ") : "Singleton group"}
                </span>
                <span role="cell" className="small">
                  {row.window_minutes === undefined
                    ? "—"
                    : `${display(row.window_minutes)} min`}
                </span>
                <span role="cell">
                  {deleted || row.deleted_at ? (
                    <span className="chip b-neutral">Deleted</span>
                  ) : (
                    <StateChip enabled={row.enabled} />
                  )}
                </span>
                <span role="cell">
                  {deleted || row.deleted_at ? (
                    <span className="small muted">—</span>
                  ) : (
                    <HealthChip value={row.health} />
                  )}
                </span>
                <span role="cell" className="rl-change">
                  <span className="small cell">
                    {deleted
                      ? "Retained history"
                      : personLabel(
                          scope,
                          row.updated_by,
                          row.updated_by_display_name,
                          "—",
                        )}
                  </span>
                  <span className="mono rl-at">
                    {timestamp(deleted ? row.deleted_at : row.updated_at)}
                  </span>
                </span>
              </div>
            );
          })}
          {rows && !rows.length && (
            <div className="rl-empty">
              <b>
                {deleted
                  ? "No deleted rules with retained history"
                  : name || enabled || health
                    ? "No rules match these filters"
                    : "No correlation rules yet"}
              </b>
              <span className="small muted">
                {deleted || name || enabled || health
                  ? "Change the search or filters to see other rules."
                  : canEdit
                    ? "Create a rule to open incidents from related alerts automatically."
                    : "Rules created by editors appear here."}
              </span>
            </div>
          )}
          {result.loading && !rows && (
            <div className="rl-empty" role="status">
              <span className="small muted">Loading correlation rules…</span>
            </div>
          )}
        </div>
        {(pages.length > 0 || result.data?.next_cursor) && (
          <div className="table-footer-bar">
            <span>
              Rules <b>{offset + 1}</b>–<b>{offset + (rows?.length ?? 0)}</b>
            </span>
            <span className="grow-x" />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!pages.length || result.loading}
              onClick={() => setPages([])}
            >
              First page
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!result.data?.next_cursor || result.loading}
              onClick={() =>
                setPages((previous) => [
                  ...previous,
                  {
                    cursor: result.data!.next_cursor!,
                    offset: offset + (rows?.length ?? 0),
                  },
                ])
              }
            >
              Next page
            </button>
          </div>
        )}
        {result.data && Boolean(result.error) && rows && (
          <div className="table-footer-bar">
            <span className="small muted" role="status">
              Showing previous results · refresh unavailable
            </span>
          </div>
        )}
      </section>
    </Page>
  );
}

/* ------------------------------------------------------------------ S11 */

function RuleDetail({ scope, id }: { scope: Scope; id: string }) {
  const path = `${tenantPath(scope.tenant.id)}/correlation-rules/${id}`;
  const result = useResource<RecordData>(path, scope.onDenied, scope.version);
  const rule = result.data?.data;
  if (rule && typeof rule.revision === "string")
    return (
      <RuleEditor
        scope={scope}
        existing={rule}
        reload={result.reload}
        loading={result.loading}
        refreshError={result.error}
      />
    );
  const base = `/tenants/${scope.tenant.id}/correlation-rules`;
  const missing =
    result.error instanceof ApiError && result.error.status === 404;
  return (
    <Page
      scope={scope}
      title={missing ? "Rule unavailable" : "Correlation rule"}
      crumbs={[{ label: "Correlation rules", href: base }]}
    >
      {result.loading && !result.error && (
        <p className="small muted" role="status">
          Loading correlation rule…
        </p>
      )}
      {missing ? (
        <Banner tone="warn" role="alert">
          This rule was deleted or is not visible to you.{" "}
          <NavLink
            scope={scope}
            href={`${base}/${id}/history`}
            className="inline-link"
          >
            View retained history
          </NavLink>
        </Banner>
      ) : (
        <ErrorBanner error={result.error} />
      )}
    </Page>
  );
}

function toDraft(record?: RecordData): Draft {
  return {
    name: String(record?.name ?? ""),
    description: String(record?.description ?? ""),
    severity: String(record?.severity ?? ""),
    conditions: Array.isArray(record?.conditions)
      ? (record.conditions as Condition[]).map((item) => ({
          id: item.id,
          label: item.label,
          cel: item.cel,
        }))
      : [{ id: crypto.randomUUID(), label: "", cel: "" }],
    window: String(record?.window_minutes ?? 10),
    groupBy: Array.isArray(record?.group_by)
      ? [...(record.group_by as string[])]
      : [],
  };
}
function definitionOf(draft: Draft) {
  const minutes = /^\d+$/.test(draft.window.trim())
    ? Number(draft.window)
    : NaN;
  return {
    name: draft.name,
    description: draft.description,
    severity: draft.severity,
    conditions: draft.conditions,
    window_minutes: minutes,
    group_by: draft.groupBy,
  };
}

function RuleEditor({
  scope,
  existing,
  reload,
  loading,
  refreshError,
}: {
  scope: Scope;
  existing?: RecordData;
  reload?: () => void;
  loading?: boolean;
  refreshError?: unknown;
}) {
  const canEdit = scope.tenant.role !== "view";
  const [base, setBase] = useState<RecordData | undefined>(existing);
  const [initial, setInitial] = useState<Draft>(() => toDraft(existing));
  const [draft, setDraft] = useState<Draft>(initial);
  const [leaving, setLeaving] = useState<string | null>(null);
  const command = useCommand(scope.session.csrf_token, scope.onDenied);
  const toggle = useCommand(scope.session.csrf_token, scope.onDenied);
  const [confirmDialog, confirm] = useConfirm();
  const definition = definitionOf(draft);
  const dirty =
    !leaving &&
    canEdit &&
    JSON.stringify(definition) !== JSON.stringify(definitionOf(initial));
  const newer =
    existing && base && existing.revision !== base.revision
      ? existing
      : undefined;
  useDirtyWarning(dirty);
  useEffect(() => {
    scope.setDirty(dirty);
    return () => scope.setDirty(false);
  }, [dirty, scope.setDirty]);
  useEffect(() => {
    if (leaving) scope.navigate(leaving);
  }, [leaving, scope.navigate]);
  // Adopt a newer shared revision automatically while there is no draft.
  useEffect(() => {
    if (!existing || existing.revision === base?.revision || dirty) return;
    setBase(existing);
    const next = toDraft(existing);
    setInitial(next);
    setDraft(next);
  }, [existing, base?.revision, dirty]);
  const listHref = `/tenants/${scope.tenant.id}/correlation-rules`;
  const path = existing
    ? `${tenantPath(scope.tenant.id)}/correlation-rules/${existing.id}`
    : "";

  function update(patch: Partial<Draft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
  }
  function updateCondition(id: string, patch: Partial<Condition>) {
    setDraft((previous) => ({
      ...previous,
      conditions: previous.conditions.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  }
  async function save() {
    if (!canEdit) return;
    const result = await command.execute<RecordData>(
      existing ? path : `${tenantPath(scope.tenant.id)}/correlation-rules`,
      {
        ...definition,
        ...(base ? { expected_revision: base.revision } : {}),
      },
      existing ? "PUT" : "POST",
    );
    if (!result) return;
    const saved = result.data;
    if (!existing) {
      scope.setDirty(false);
      setLeaving(
        saved && typeof saved.id === "string"
          ? `${listHref}/${saved.id}`
          : listHref,
      );
      return;
    }
    if (
      saved &&
      typeof saved.revision === "string" &&
      Array.isArray(saved.conditions)
    ) {
      setBase(saved);
      const next = toDraft(saved);
      setInitial(next);
      setDraft(next);
    } else {
      setInitial(draft);
    }
    reload?.();
  }
  async function discard() {
    if (
      dirty &&
      !(await confirm({
        title: "Discard unsaved changes?",
        body: <p>Your edits to this rule will be lost.</p>,
        confirmLabel: "Discard changes",
        danger: true,
      }))
    )
      return;
    if (!existing) {
      scope.setDirty(false);
      setLeaving(listHref);
      return;
    }
    const target = existing ?? base;
    setBase(target);
    const next = toDraft(target);
    setInitial(next);
    setDraft(next);
  }
  async function setEnabled(value: boolean) {
    if (!base) return;
    if (
      await toggle.execute(`${path}/${value ? "enable" : "disable"}`, {
        expected_revision: base.revision,
      })
    )
      reload?.();
  }
  async function remove() {
    if (!base) return;
    const ok = await confirm({
      title: `Delete rule “${display(base.name)}”?`,
      body: (
        <p>
          It stops correlating immediately and its collected evidence is
          discarded. Existing incidents keep their alerts. Retained history
          stays available for review.
        </p>
      ),
      confirmLabel: "Delete rule",
      danger: true,
    });
    if (!ok) return;
    const headers = {
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": `"${base.revision}"`,
    };
    if (await toggle.execute(path, {}, "DELETE", headers)) {
      scope.setDirty(false);
      setLeaving(listHref);
    }
  }

  const busy = command.busy || toggle.busy;
  const title = existing
    ? display(base?.name ?? existing.name)
    : "New correlation rule";
  const health = existing?.health;
  return (
    <Page
      scope={scope}
      title={title}
      crumbs={[{ label: "Correlation rules", href: listHref }]}
      extra={
        <>
          {existing && <StateChip enabled={existing.enabled} />}
          {existing && <HealthChip value={health} />}
          {dirty && <span className="chip b-amber">Unsaved changes</span>}
        </>
      }
      actions={
        <>
          {existing && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                scope.navigate(`${listHref}/${existing.id}/history`)
              }
            >
              History
            </button>
          )}
          {existing && canEdit && (
            <button
              type="button"
              className="btn"
              disabled={busy || toggle.uncertain || dirty}
              title={dirty ? "Save or discard your changes first" : undefined}
              onClick={() => void setEnabled(!existing.enabled)}
            >
              {existing.enabled ? "Disable" : "Enable"}
            </button>
          )}
          {existing && canEdit && (
            <button
              type="button"
              className="btn btn-d"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn btn-g"
              disabled={busy || (Boolean(existing) && !dirty && !newer)}
              onClick={() => void discard()}
            >
              Discard
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn btn-p"
              disabled={
                busy ||
                (!command.uncertain &&
                  (!dirty || draft.conditions.length === 0 || !draft.severity))
              }
              onClick={() => void save()}
            >
              {command.uncertain
                ? "Retry original command"
                : existing
                  ? "Save changes"
                  : "Create rule"}
            </button>
          )}
        </>
      }
    >
      {confirmDialog}
      <CommandBanner command={command} />
      <CommandBanner command={toggle} />
      {refreshError && !loading ? (
        <Banner tone="warn" role="status">
          Showing the last loaded revision · refresh failed.
        </Banner>
      ) : null}
      {newer && dirty && (
        <Banner tone="warn" role="status">
          A newer shared revision {newer.revision} is available. Your draft is
          based on revision {base?.revision}; saving will conflict. Discard to
          load the newer revision.
        </Banner>
      )}
      {existing && <HealthBanner rule={existing} />}
      <div className="rl-grid grow">
        <RuleDefinition
          scope={scope}
          existing={existing}
          base={base}
          draft={draft}
          readOnly={!canEdit}
          update={update}
          updateCondition={updateCondition}
          definition={definition}
        />
        <aside className="rl-side">
          <CorrelationTester
            scope={scope}
            definition={definition}
            revision={existing && !dirty ? base?.revision : undefined}
          />
          {existing && <RuleIncidents scope={scope} ruleId={existing.id} />}
          {existing && <RuleEvidence scope={scope} rule={existing} />}
        </aside>
      </div>
    </Page>
  );
}

function RuleDefinition({
  scope,
  existing,
  base,
  draft,
  readOnly,
  update,
  updateCondition,
  definition,
}: {
  scope: Scope;
  existing?: RecordData;
  base?: RecordData;
  draft: Draft;
  readOnly: boolean;
  update: (patch: Partial<Draft>) => void;
  updateCondition: (id: string, patch: Partial<Condition>) => void;
  definition: Record<string, unknown>;
}) {
  const [validation, setValidation] = useState<{
    key: string;
    busy?: boolean;
    valid?: boolean;
    messages?: string[];
    error?: unknown;
  }>();
  const key = JSON.stringify(definition);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), [key]);
  const active = validation?.key === key ? validation : undefined;
  async function validate() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setValidation({ key, busy: true });
    try {
      const response = await request<{
        valid?: boolean;
        diagnostics?: unknown;
      }>(`${tenantPath(scope.tenant.id)}/correlation-rules/validate`, {
        method: "POST",
        body: definition,
        csrf: scope.session.csrf_token,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setValidation({
        key,
        valid: response.data?.valid === true,
        messages: diagnosticMessages(response.data?.diagnostics),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && [401, 403].includes(error.status))
        scope.onDenied();
      setValidation({
        key,
        error,
        messages:
          error instanceof ApiError ? diagnosticMessages(error.fields) : [],
      });
    }
  }
  return (
    <section className="panel rl-def" aria-label="Rule definition">
      <div className="panel-h">
        <h2>Definition</h2>
        <span className="grow-x" />
        <span className="small muted">
          {existing
            ? `Revision ${base?.revision ?? existing.revision} · shared with everyone in ${scope.tenant.name}`
            : `Shared with everyone in ${scope.tenant.name} once created`}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-g"
          disabled={active?.busy}
          onClick={() => void validate()}
        >
          {active?.busy ? "Validating…" : "Validate"}
        </button>
      </div>
      <div className="rl-def-body">
        <div className="rl-row2">
          <div className="f">
            <label className="lbl" htmlFor="rule-name">
              Name
            </label>
            <input
              id="rule-name"
              className="inp"
              value={draft.name}
              maxLength={200}
              required
              readOnly={readOnly}
              onChange={(event) => update({ name: event.target.value })}
            />
          </div>
          <div className="f">
            <label className="lbl" htmlFor="rule-window">
              Window (minutes)
            </label>
            <input
              id="rule-window"
              className="inp"
              type="number"
              min={1}
              max={1440}
              step={1}
              required
              readOnly={readOnly}
              value={draft.window}
              onChange={(event) => update({ window: event.target.value })}
            />
          </div>
        </div>
        <div className="f">
          <label className="lbl" htmlFor="rule-description">
            Description
          </label>
          <textarea
            id="rule-description"
            className="inp"
            rows={2}
            maxLength={10000}
            readOnly={readOnly}
            value={draft.description}
            onChange={(event) => update({ description: event.target.value })}
          />
        </div>
        <div className="rl-row-sev">
          <div className="f">
            <span className="lbl" id="rule-severity-label">
              Incident severity
            </span>
            <div
              className="seg"
              role="group"
              aria-labelledby="rule-severity-label"
            >
              {SEVERITIES.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={draft.severity === value}
                  className={draft.severity === value ? "on" : undefined}
                  disabled={readOnly && draft.severity !== value}
                  onClick={() => !readOnly && update({ severity: value })}
                >
                  {titleCase(value)}
                </button>
              ))}
            </div>
          </div>
          <GroupFields
            scope={scope}
            value={draft.groupBy}
            readOnly={readOnly}
            onChange={(groupBy) => update({ groupBy })}
          />
        </div>
        <div className="f rl-conds">
          <div className="rl-conds-h">
            <span className="lbl">Conditions</span>
            <span className="help">
              All must match to open an incident. Any one adds alerts to the
              open incident.
            </span>
            <span className="grow-x" />
            {!readOnly && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={draft.conditions.length >= 10}
                onClick={() =>
                  update({
                    conditions: [
                      ...draft.conditions,
                      { id: crypto.randomUUID(), label: "", cel: "" },
                    ],
                  })
                }
              >
                Add condition
              </button>
            )}
          </div>
          {draft.conditions.length === 0 && (
            <span className="help">Add at least one named condition.</span>
          )}
          {draft.conditions.map((condition, index) => (
            <div className="cond" key={condition.id}>
              <div className="cond-h">
                <label className="sr-only" htmlFor={`cond-${condition.id}`}>
                  Condition {index + 1} label
                </label>
                <input
                  id={`cond-${condition.id}`}
                  className="inp cond-label"
                  value={condition.label}
                  placeholder={`Condition ${index + 1} label`}
                  maxLength={100}
                  required
                  readOnly={readOnly}
                  onChange={(event) =>
                    updateCondition(condition.id, { label: event.target.value })
                  }
                />
                <span className="grow-x" />
                {!readOnly && (
                  <button
                    type="button"
                    className="btn btn-sm btn-g"
                    aria-label={`Remove condition ${index + 1}`}
                    onClick={() =>
                      update({
                        conditions: draft.conditions.filter(
                          (item) => item.id !== condition.id,
                        ),
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
              <CelEditor
                scope={scope}
                context="correlation"
                label={`Condition ${index + 1} CEL`}
                value={condition.cel}
                minimal
                rows={1}
                disabled={readOnly}
                onChange={(cel) => updateCondition(condition.id, { cel })}
              />
            </div>
          ))}
        </div>
        {active && !active.busy && (
          <div role="status">
            {active.error ? (
              <>
                <ErrorBanner error={active.error} />
                {active.messages?.length ? (
                  <ul className="rt-diag">
                    {active.messages.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : active.valid ? (
              <Banner tone="ok">
                The definition is valid. Saving checks it again.
              </Banner>
            ) : (
              <Banner tone="err">
                <b>The definition is invalid.</b>
                <ul className="rt-diag">
                  {(active.messages?.length
                    ? active.messages
                    : ["No detailed diagnostics were supplied."]
                  ).map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </Banner>
            )}
          </div>
        )}
        {existing ? (
          <Banner tone="warn">
            Changing conditions, window or grouping may clear collected
            evidence. Existing matches are not re-evaluated.
          </Banner>
        ) : (
          <Banner tone="info">
            Rules may overlap. Earlier-created rules claim eligible alerts
            first. New rules start enabled and do not backfill existing matches.
          </Banner>
        )}
      </div>
    </section>
  );
}

function GroupFields({
  scope,
  value,
  readOnly,
  onChange,
}: {
  scope: Scope;
  value: string[];
  readOnly: boolean;
  onChange: (value: string[]) => void;
}) {
  const [adding, setAdding] = useState(false),
    [typed, setTyped] = useState("");
  const profile = useResource<{
    fields?: { name: string; type: string }[];
  }>(
    `${tenantPath(scope.tenant.id)}/cel/profile?context=correlation`,
    scope.onDenied,
  );
  const fields = useMemo(
    () =>
      Array.isArray(profile.data?.data?.fields)
        ? profile.data.data.fields
            .filter((field) =>
              ["string", "int", "bool", "enum"].includes(field.type),
            )
            .map((field) => field.name)
        : [],
    [profile.data],
  );
  const choices = fields.filter((field) => !value.includes(field));
  function add(field: string) {
    const name = field.trim();
    if (name && !value.includes(name) && value.length < 3)
      onChange([...value, name]);
    setAdding(false);
    setTyped("");
  }
  return (
    <div className="f">
      <span className="lbl" id="rule-group-label">
        Group alerts by
      </span>
      <div className="rl-chips" role="list" aria-labelledby="rule-group-label">
        {value.map((field, index) => (
          <span className="fchip rl-gchip" role="listitem" key={field}>
            {index + 1} · {field}
            {!readOnly && index > 0 && (
              <button
                type="button"
                className="rl-x"
                aria-label={`Move ${field} earlier`}
                title="Move earlier"
                onClick={() => {
                  const next = [...value];
                  [next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ];
                  onChange(next);
                }}
              >
                ‹
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                className="rl-x"
                aria-label={`Remove ${field}`}
                title="Remove"
                onClick={() => onChange(value.filter((item) => item !== field))}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {!value.length && <span className="small muted">Singleton group</span>}
        {!readOnly &&
          value.length < 3 &&
          (adding ? (
            choices.length ? (
              <select
                className="inp rl-add"
                aria-label="Grouping field to add"
                autoFocus
                value=""
                onChange={(event) => add(event.target.value)}
                onBlur={() => setAdding(false)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setAdding(false);
                }}
              >
                <option value="">Choose a field…</option>
                {choices.map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="inp rl-add"
                aria-label="Grouping field to add"
                autoFocus
                placeholder="Field name"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onBlur={() => (typed ? add(typed) : setAdding(false))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    add(typed);
                  } else if (event.key === "Escape") setAdding(false);
                }}
              />
            )
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-g"
              onClick={() => setAdding(true)}
            >
              Add field
            </button>
          ))}
      </div>
      <span className="help">
        Up to three, in order. Leave empty to put every match in one shared
        group.
      </span>
    </div>
  );
}

function HealthBanner({ rule }: { rule: RecordData }) {
  const health = String(rule.health ?? "");
  if (!health || health === "healthy") return null;
  const reason = rule.blocked_reason
    ? ` Reason: ${titleCase(rule.blocked_reason)}.`
    : "";
  if (health === "delayed")
    return (
      <Banner tone="warn">
        Evaluation is delayed. New incidents and additions from this rule may
        arrive late.
      </Banner>
    );
  if (health === "recovery_needed")
    return (
      <Banner tone="err">
        Recovery is needed before this rule resumes automatic processing.
        {reason}
      </Banner>
    );
  return (
    <Banner tone="err">
      Automatic processing is blocked.{reason} Correct the rule, or disable and
      re-enable it once the issue is addressed. Resuming starts fresh without
      backfill.
    </Banner>
  );
}

function RuleIncidents({ scope, ruleId }: { scope: Scope; ruleId: string }) {
  const result = useResource<RecordData[]>(
    `${tenantPath(scope.tenant.id)}/incidents?${new URLSearchParams({
      rule_id: ruleId,
      view: "active",
      limit: "5",
    })}`,
    scope.onDenied,
    scope.version,
  );
  const rows = Array.isArray(result.data?.data)
    ? result.data.data.filter(
        (row) => row.rule_id === undefined || row.rule_id === ruleId,
      )
    : [];
  if (!rows.length) return null;
  return (
    <section className="panel rl-small" aria-label="Incidents from this rule">
      <span className="lbl">Incidents from this rule</span>
      {rows.map((row) => (
        <div className="rl-inc" key={row.id}>
          <NavLink
            scope={scope}
            href={`/tenants/${scope.tenant.id}/incidents/${row.id}`}
            className="lnk"
          >
            {display(row.title)}
          </NavLink>
          <span className="small muted">
            {titleCase(row.status)} · {titleCase(row.severity)}
            {row.last_activity
              ? ` · last activity ${timestamp(row.last_activity)}`
              : ""}
          </span>
        </div>
      ))}
      {result.data?.next_cursor && (
        <NavLink
          scope={scope}
          href={`/tenants/${scope.tenant.id}/incidents`}
          className="small inline-link"
        >
          More in Incidents
        </NavLink>
      )}
    </section>
  );
}

function groupText(group: unknown): string {
  if (Array.isArray(group))
    return group
      .map((entry) =>
        Array.isArray(entry) && entry.length >= 2
          ? `${String(entry[0])} = ${JSON.stringify(entry[entry.length - 1])}`
          : display(entry),
      )
      .join(" · ");
  if (group && typeof group === "object")
    return Object.entries(group)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      .join(" · ");
  return display(group);
}

function RuleEvidence({ scope, rule }: { scope: Scope; rule: RecordData }) {
  const result = useResource<{
    groups?: {
      context_id: string;
      group: unknown;
      active_incident_id: string | null;
      conditions: { condition_id: string; matches: string }[];
    }[];
  }>(
    `${tenantPath(scope.tenant.id)}/correlation-rules/${rule.id}/diagnostics?limit=20`,
    scope.onDenied,
    scope.version,
  );
  const groups = Array.isArray(result.data?.data?.groups)
    ? result.data.data.groups
    : [];
  if (!groups.length) return null;
  const labels = new Map(
    (Array.isArray(rule.conditions)
      ? (rule.conditions as Condition[])
      : []
    ).map((item) => [item.id, item.label]),
  );
  return (
    <section className="panel rl-small" aria-label="Current evidence">
      <span className="lbl">Current evidence</span>
      {groups.map((group) => (
        <div className="rl-inc" key={group.context_id}>
          <span className="mono small">
            {groupText(group.group) || "Singleton group"}
          </span>
          <span className="small muted">
            {group.conditions
              .map(
                (item) =>
                  `${labels.get(item.condition_id) ?? "Condition"} ${item.matches}`,
              )
              .join(" · ")}
          </span>
          {group.active_incident_id && (
            <NavLink
              scope={scope}
              href={`/tenants/${scope.tenant.id}/incidents/${group.active_incident_id}`}
              className="small inline-link"
            >
              Open incident receiving additions
            </NavLink>
          )}
        </div>
      ))}
      {typeof result.data?.meta?.as_of === "string" && (
        <span className="small muted">
          As of{" "}
          <span className="mono">{timestamp(result.data.meta.as_of)}</span>
        </span>
      )}
    </section>
  );
}
