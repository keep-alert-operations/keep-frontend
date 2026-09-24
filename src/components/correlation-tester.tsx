"use client";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  type Envelope,
  request,
  tenantPath,
  timestamp,
} from "@/lib/api";
import type { components } from "@/lib/generated";
import type { Scope } from "./workspace";
import { ErrorBanner, diagnosticMessages } from "./temporal-history";

type TestBody = components["schemas"]["TestRequest"];
type Definition = Omit<TestBody, "alert_id">;
type ConditionResult = {
  condition_id: string;
  label: string;
  matches: boolean | null;
  error: string | null;
};
type GroupValue = [
  string,
  "string" | "int" | "bool",
  string | number | boolean,
];
type TestResult = {
  valid: boolean;
  diagnostics?: unknown;
  conditions?: ConditionResult[];
  group?: GroupValue[] | null;
  eligibility_exclusions?: string[];
  qualification_proven: false;
  explanation?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const caveat =
  "A match now does not prove a qualifying transition or a complete window. Testing creates no evidence, incidents, links or history.";

function candidate(value: Record<string, unknown>): Definition | null {
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.description !== "string" ||
    !["critical", "high", "medium", "low"].includes(String(value.severity)) ||
    !Number.isInteger(value.window_minutes) ||
    Number(value.window_minutes) < 1 ||
    Number(value.window_minutes) > 1440 ||
    !Array.isArray(value.group_by) ||
    !value.group_by.every((field) => typeof field === "string") ||
    !Array.isArray(value.conditions) ||
    value.conditions.length < 1 ||
    value.conditions.length > 10
  )
    return null;
  const conditions: Definition["conditions"] = [];
  for (const item of value.conditions) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !uuid.test(item.id) ||
      typeof item.label !== "string" ||
      !item.label.trim() ||
      typeof item.cel !== "string" ||
      !item.cel.trim()
    )
      return null;
    conditions.push({ id: item.id, label: item.label, cel: item.cel });
  }
  return {
    name: value.name,
    description: value.description,
    severity: value.severity as Definition["severity"],
    conditions,
    group_by: value.group_by,
    window_minutes: Number(value.window_minutes),
  };
}

function checkedResult(
  value: Envelope<unknown>,
  definition: Definition,
): Envelope<TestResult> {
  const data = value.data as TestResult | undefined;
  const fail = () => {
    throw new ApiError(
      502,
      "invalid_response",
      "The rule test response does not match its API contract.",
    );
  };
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.valid !== "boolean" ||
    data.qualification_proven !== false ||
    typeof value.meta?.profile !== "string"
  )
    return fail();
  if (!data.valid) return { ...value, data };
  const conditions = data.conditions;
  if (
    !Array.isArray(conditions) ||
    conditions.length !== definition.conditions.length ||
    new Set(conditions.map((item) => item?.condition_id)).size !==
      conditions.length ||
    !conditions.every(
      (item) =>
        item &&
        definition.conditions.some(
          (expected) => expected.id === item.condition_id,
        ) &&
        typeof item.label === "string" &&
        (typeof item.matches === "boolean" || item.matches === null) &&
        (item.error === null || typeof item.error === "string"),
    ) ||
    !Array.isArray(data.eligibility_exclusions) ||
    !data.eligibility_exclusions.every(
      (reason) => typeof reason === "string",
    ) ||
    typeof value.meta?.alert_revision !== "string" ||
    !/^\d+$/.test(value.meta.alert_revision) ||
    typeof value.meta?.as_of !== "string" ||
    !Number.isFinite(Date.parse(value.meta.as_of))
  )
    return fail();
  if (
    data.group !== null &&
    (!Array.isArray(data.group) ||
      !data.group.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 3 &&
          typeof entry[0] === "string" &&
          ((entry[1] === "string" && typeof entry[2] === "string") ||
            (entry[1] === "bool" && typeof entry[2] === "boolean") ||
            (entry[1] === "int" &&
              ((typeof entry[2] === "string" && /^-?\d+$/.test(entry[2])) ||
                (typeof entry[2] === "number" &&
                  Number.isSafeInteger(entry[2]))))),
      ))
  )
    return fail();
  return { ...value, data };
}

const exclusionLabels: Record<string, string> = {
  not_firing: "Alert is not firing",
  suppressed: "Alert is suppressed",
  active_ownership: "Alert already belongs to an active incident",
  invalid_group: "Grouping fields are missing, empty, or have invalid types",
};

export function CorrelationTester({
  scope,
  definition,
  revision,
}: {
  scope: Scope;
  definition: Record<string, unknown>;
  revision?: string;
}) {
  const [alertId, setAlertId] = useState("");
  const definitionKey = JSON.stringify(definition);
  const context = JSON.stringify([
    scope.tenant.id,
    scope.tenant.role,
    scope.tenant.revision,
    scope.session.principal.id,
    scope.session.csrf_token,
    revision,
    definitionKey,
    alertId,
  ]);
  const current = useRef(context);
  current.current = context;
  const pending = useRef<AbortController | null>(null);
  const [state, setState] = useState<{
    context: string;
    loading?: boolean;
    error?: unknown;
    result?: Envelope<TestResult>;
  }>();
  const active = state?.context === context ? state : undefined;
  const submittedDefinition = candidate(definition);
  useEffect(() => {
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [context]);

  async function test() {
    if (!submittedDefinition || active?.loading) return;
    if (!uuid.test(alertId.trim())) {
      setState({
        context,
        error: new Error("Enter a valid existing alert UUID."),
      });
      return;
    }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setState({ context, loading: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15000);
    try {
      const body: TestBody = {
        ...submittedDefinition,
        alert_id: alertId.trim(),
      };
      const result = checkedResult(
        await request<unknown>(
          `${tenantPath(scope.tenant.id)}/correlation-rules/test`,
          {
            method: "POST",
            body,
            csrf: scope.session.csrf_token,
            signal: controller.signal,
          },
        ),
        submittedDefinition,
      );
      if (!controller.signal.aborted && current.current === context)
        setState({ context, result });
    } catch (error) {
      if (current.current !== context || pending.current !== controller) return;
      if (controller.signal.aborted && !timedOut) return;
      if (error instanceof ApiError && [401, 403].includes(error.status))
        scope.onDenied();
      setState({
        context,
        error: timedOut
          ? new Error(
              "The rule test timed out. Your alert identifier is retained; test again explicitly.",
            )
          : error,
      });
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
    }
  }

  const result = active?.result;
  const exclusions = result?.data.eligibility_exclusions ?? [];
  return (
    <section
      className="panel rt-panel"
      aria-label="Test rule against a current alert"
    >
      <div className="panel-h">
        <h2>Test against a current alert</h2>
      </div>
      <div className="rt-body">
        <div className="rt-input">
          <label className="sr-only" htmlFor="rule-test-alert">
            Alert identifier for rule test
          </label>
          <input
            id="rule-test-alert"
            className="inp mono-ph"
            value={alertId}
            placeholder="Alert ID (UUID)"
            onChange={(event) => {
              event.stopPropagation();
              setAlertId(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void test();
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={!submittedDefinition || active?.loading}
            onClick={() => void test()}
          >
            {active?.loading ? "Testing…" : "Test"}
          </button>
        </div>
        {!submittedDefinition && (
          <span className="help">
            Complete the rule name, severity, window and named conditions before
            testing.
          </span>
        )}
        {active?.loading && (
          <span className="sr-only" role="status">
            Testing current alert…
          </span>
        )}
        <ErrorBanner error={active?.error} />
        {active?.error instanceof ApiError &&
          active.error.fields !== undefined && (
            <ul className="rt-diag">
              {diagnosticMessages(active.error.fields).map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          )}
        {result && !result.data.valid && (
          <div role="status" className="banner bn-err banner-top">
            <div className="banner-text">
              <h3 className="rt-h">Rule validation failed</h3>
              <ul className="rt-diag">
                {(diagnosticMessages(result.data.diagnostics).length
                  ? diagnosticMessages(result.data.diagnostics)
                  : ["No detailed diagnostics were supplied."]
                ).map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {result?.data.valid && (
          <section aria-label="Current alert test result" className="rt-result">
            <span className="small muted">
              Alert revision {String(result.meta?.alert_revision)} · as of{" "}
              <span className="mono">{timestamp(result.meta?.as_of)}</span>
              {revision ? "" : " · unsaved definition"}
            </span>
            <div
              role="table"
              aria-label="Condition results"
              className="rt-table"
            >
              <div role="row" className="row head g-tr">
                <span role="columnheader">Condition</span>
                <span role="columnheader">Current match</span>
                <span role="columnheader">Diagnostic</span>
              </div>
              {result.data.conditions!.map((condition) => (
                <div
                  role="row"
                  className="row g-tr"
                  key={condition.condition_id}
                >
                  <span role="rowheader" className="small rt-label">
                    {condition.label}
                  </span>
                  <span role="cell">
                    {condition.error || condition.matches === null ? (
                      <span className="chip b-amber">Unavailable</span>
                    ) : condition.matches ? (
                      <span className="chip b-green">True</span>
                    ) : (
                      <span className="chip b-neutral">False</span>
                    )}
                  </span>
                  <span role="cell" className="small muted">
                    {condition.error ?? "—"}
                  </span>
                </div>
              ))}
            </div>
            <div className="f rt-f">
              <span className="lbl">Group</span>
              {result.data.group === null ? (
                <span className="small">
                  Unavailable: grouping fields are incomplete or invalid.
                </span>
              ) : result.data.group!.length === 0 ? (
                <span className="small">
                  Singleton group (no grouping fields).
                </span>
              ) : (
                <span className="mono small rt-group">
                  {result.data.group!.map(([field, type, value], index) => (
                    <span key={field} title={`${field} · ${type}`}>
                      {index > 0 && <span aria-hidden="true"> · </span>}
                      {field} ={" "}
                      <span>
                        {typeof value === "string" && type === "string"
                          ? JSON.stringify(value)
                          : String(value)}
                      </span>
                    </span>
                  ))}
                </span>
              )}
            </div>
            <div className="f rt-f">
              <span className="lbl">Eligibility</span>
              {exclusions.length ? (
                exclusions.map((reason, index) => (
                  <span className="small rt-excl" key={`${reason}:${index}`}>
                    <span className="chip b-amber">Excluded</span>
                    <span>{exclusionLabels[reason] ?? reason}</span>
                  </span>
                ))
              ) : (
                <span className="small rt-excl">
                  <span className="chip b-green">Eligible</span>
                  No current firing, suppression, ownership or grouping
                  exclusions reported.
                </span>
              )}
            </div>
          </section>
        )}
        <p className="help rt-caveat">{caveat}</p>
      </div>
    </section>
  );
}
