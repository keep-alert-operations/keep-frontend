"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ApiError,
  Session,
  Tenant,
  message,
  request,
  requestSession,
  tenantPath,
} from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { liveStream } from "@/lib/live-stream";
import { Alerts } from "./alerts";
import { Resources } from "./resources";
import { Administration } from "./administration";
import { ErrorNotice } from "./ui";
import { Icon } from "./icons";

const sections = [
  ["alerts", "Alerts"],
  ["incidents", "Incidents"],
  ["presets", "Presets"],
  ["correlation-rules", "Correlation rules"],
  ["maintenance", "Maintenance"],
  ["dashboards", "Dashboards"],
  ["operators", "Operators"],
] as const;
export interface Scope {
  tenant: Tenant;
  session: Session;
  version: number;
  liveStatus?: string;
  /** Re-reads the current view (live status control). */
  refresh?: () => void;
  /** Administration tabs rendered under the page header. */
  subnav?: React.ReactNode;
  /** Tenant processing banners rendered at the top of the page body. */
  banners?: React.ReactNode;
  onDenied: () => void;
  navigate: (url: string) => void;
  setDirty: (dirty: boolean) => void;
}

export function Workspace() {
  const pathname = usePathname(),
    router = useRouter();
  const [session, setSession] = useState<Session>(),
    [error, setError] = useState<unknown>(),
    [loading, setLoading] = useState(true);
  const [accountOpen, setAccountOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [notice, setNotice] = useState<string>();
  const [epoch, setEpoch] = useState(0),
    [dirty, setDirty] = useState(false);
  const sessionRequest = useRef<AbortController | null>(null);
  const signedOut = useRef(false);
  useEffect(() => {
    setTheme(
      document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    );
  }, []);
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem("appchi-theme", next);
    } catch {
      // The theme still changes for this page when browser storage is blocked.
    }
  }
  const reauthorize = useCallback(async (clear = false) => {
    if (signedOut.current) return;
    sessionRequest.current?.abort();
    const controller = new AbortController();
    sessionRequest.current = controller;
    if (clear) {
      setSession(undefined);
      setDirty(false);
      setEpoch((v) => v + 1);
    }
    try {
      const result = await requestSession(controller.signal);
      if (controller.signal.aborted) return;
      setSession(result.data);
      setError(undefined);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure);
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
        setSession(undefined);
        setDirty(false);
        setEpoch((v) => v + 1);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reauthorize();
    const check = () => {
      if (document.visibilityState === "visible") void reauthorize();
    };
    const timer = setInterval(check, 30000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      sessionRequest.current?.abort();
    };
  }, [reauthorize]);
  const onDenied = useCallback(() => {
    void reauthorize(true);
  }, [reauthorize]);
  const parts = pathname.split("/").filter(Boolean);
  const requestedTenant = parts[0] === "tenants" ? parts[1] : undefined;
  const tenant =
    session?.tenants.find((t) => t.id === requestedTenant) ??
    (!requestedTenant
      ? (session?.tenants.find((t) => t.id === session.last_tenant_id) ??
        session?.tenants.find((t) => t.kind === "global"))
      : undefined);
  const section = parts[2] ?? "alerts",
    id = parts[3];
  useEffect(() => {
    if (tenant && !requestedTenant)
      router.replace(`/tenants/${tenant.id}/alerts`);
  }, [tenant, requestedTenant, router]);
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void request("/auth/activity", {
        method: "POST",
        body: {},
        csrf: session.csrf_token,
      }).catch((failure) => {
        if (failure instanceof ApiError && [401, 403].includes(failure.status))
          onDenied();
      });
    }, 60000);
    return () => clearInterval(timer);
  }, [session, onDenied]);
  const navigate = (url: string) => {
    if (
      dirty &&
      !window.confirm(
        "Discard unsaved changes and leave? Choose Cancel to stay and save your draft.",
      )
    )
      return;
    setDirty(false);
    router.push(url);
  };
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: PopStateEvent) => {
      if (
        window.confirm(
          "Discard unsaved changes and leave? Choose Cancel to stay and save your draft.",
        )
      ) {
        setDirty(false);
        return;
      }
      event.stopImmediatePropagation();
      window.history.pushState(window.history.state, "", pathname);
    };
    window.addEventListener("popstate", leave, true);
    return () => window.removeEventListener("popstate", leave, true);
  }, [dirty, pathname]);
  async function logout() {
    // Protected client state is cleared even if the provider logout is unavailable.
    signedOut.current = true;
    sessionRequest.current?.abort();
    const csrf = session?.csrf_token;
    setSession(undefined);
    setDirty(false);
    setEpoch((v) => v + 1);
    try {
      const result = await request<{
        logout_url?: string;
        provider_logout_completed?: boolean;
      }>("/auth/logout", { method: "POST", csrf, body: {} });
      if (result.data.logout_url) {
        const target = new URL(result.data.logout_url, location.origin);
        if (["https:", "http:"].includes(target.protocol))
          location.assign(target.href);
      }
      setNotice(
        result.data.provider_logout_completed === false
          ? "Signed out locally. Provider sign-out could not be completed."
          : "You have signed out.",
      );
    } catch (failure) {
      setNotice(
        `Sign-out could not be confirmed. Protected data was cleared. ${message(failure)}`,
      );
    }
  }
  if (!session) {
    // An unauthenticated response is the normal signed-out state; only
    // transport or service failures are reported as a connection problem.
    const signedOutState =
      error instanceof ApiError && [401, 403].includes(error.status);
    return (
      <div className="login-screen">
        <main id="main-content" className="login">
          <div className="login-brand">
            <div className="brand-mark" aria-hidden="true">
              A
            </div>
            <div>
              <h1>Appchi</h1>
              <p>Alert operations, in one place.</p>
            </div>
          </div>
          <p className="login-lead">
            Sign in with your company account using your username and password.
          </p>
          {loading ? (
            <p role="status" className="login-lead">
              Checking your session…
            </p>
          ) : (
            <>
              <a className="btn btn-p login-button" href="/auth/login">
                Sign in with company account
              </a>
              {notice ? (
                <div className="banner bn-info" role="status">
                  {notice}
                </div>
              ) : (
                error &&
                !signedOutState && (
                  <div className="banner bn-warn login-error" role="alert">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01" />
                    </svg>
                    <div className="login-error-body">
                      <span>
                        <b>Sign-in service not reachable.</b> Your session could
                        not be checked. Try again in a moment.
                      </span>
                      <span className="help">{message(error)}</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void reauthorize()}
                      >
                        Retry connection
                      </button>
                    </div>
                  </div>
                )
              )}
            </>
          )}
          <p className="help">
            Your company identity determines tenant access. Sessions end after
            30 minutes idle or 24 hours.
          </p>
          <button type="button" className="login-theme" onClick={toggleTheme}>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
        </main>
      </div>
    );
  }
  const adminSection = [
    "operators",
    "permissions",
    "audit",
    "platform",
  ].includes(section);
  return (
    <div className="shell" data-section={section} data-detail={Boolean(id)}>
      <aside className="rail">
        <a
          href="/"
          aria-label="Appchi home"
          className="brand-mark"
          onClick={(event) => {
            event.preventDefault();
            navigate("/");
          }}
        >
          A
        </a>
        <nav aria-label="Tenant navigation">
          {sections
            .filter(([key]) => key !== "operators")
            .map(([key, label]) => (
              <a
                key={key}
                href={tenant ? `/tenants/${tenant.id}/${key}` : "#"}
                aria-label={label}
                title={label}
                aria-current={section === key ? "page" : undefined}
                onClick={(event) => {
                  if (event.ctrlKey || event.metaKey || event.shiftKey) return;
                  event.preventDefault();
                  if (tenant) navigate(`/tenants/${tenant.id}/${key}`);
                }}
              >
                <Icon name={key} />
                <span>
                  {key === "correlation-rules"
                    ? "Rules"
                    : key === "maintenance"
                      ? "Maint."
                      : key === "dashboards"
                        ? "Boards"
                        : label}
                </span>
              </a>
            ))}
        </nav>
        <div className="rail-bottom">
          <a
            href={tenant ? `/tenants/${tenant.id}/operators` : "#"}
            aria-label="Operators"
            title="Administration"
            aria-current={adminSection ? "page" : undefined}
            onClick={(event) => {
              if (event.ctrlKey || event.metaKey || event.shiftKey) return;
              event.preventDefault();
              if (tenant) navigate(`/tenants/${tenant.id}/operators`);
            }}
          >
            <Icon name="operators" />
            <span>Admin</span>
          </a>
          <button
            className="avatar"
            aria-label={`Account: ${session.principal.display_name}`}
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen(!accountOpen)}
          >
            {session.principal.display_name
              .split(/[ ._-]+/)
              .filter(Boolean)
              .map((part) => part[0])
              .slice(0, 2)
              .join("")
              .toUpperCase()}
          </button>
          {accountOpen && (
            <div className="account-menu">
              <strong>{session.principal.display_name}</strong>
              <span className="muted">Company account</span>
              <button type="button" onClick={toggleTheme}>
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </button>
              <button onClick={() => void logout()}>Sign out</button>
            </div>
          )}
        </div>
      </aside>
      <main id="main-content">
        <ErrorNotice error={error} />
        {tenant ? (
          <TenantWorkspace
            key={`${tenant.id}:${epoch}`}
            tenant={tenant}
            session={session}
            onDenied={onDenied}
            navigate={navigate}
            setDirty={setDirty}
            section={section}
            id={id}
          />
        ) : (
          <div className="empty" style={{ margin: 24 }}>
            <h1>Tenant unavailable</h1>
            <p>
              This tenant is unavailable or your access has changed. Select an
              accessible tenant above.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function TenantWorkspace(
  props: Omit<Scope, "version"> & { section: string; id?: string },
) {
  const [version, setVersion] = useState(0),
    [liveStatus, setLiveStatus] = useState("Connecting");
  useEffect(() => {
    let coalesce: ReturnType<typeof setTimeout> | undefined;
    let stopped = false,
      lastVector = "",
      liveConnected = false;
    type PollAttempt = {
      controller: AbortController;
      timer?: ReturnType<typeof setTimeout>;
    };
    let polling: PollAttempt | undefined;
    function stopPolling() {
      const previous = polling;
      polling = undefined;
      clearTimeout(previous?.timer);
      previous?.controller.abort();
    }
    function changed(vector: unknown) {
      const next = JSON.stringify(vector);
      if (next === lastVector) return;
      lastVector = next;
      if (coalesce !== undefined || document.visibilityState !== "visible")
        return;
      coalesce = setTimeout(() => {
        coalesce = undefined;
        if (!stopped && document.visibilityState === "visible")
          setVersion((v) => v + 1);
      }, 250);
    }
    async function reconcile() {
      if (stopped || polling || document.visibilityState !== "visible") return;
      const attempt: PollAttempt = {
        controller: new AbortController(),
      };
      polling = attempt;
      attempt.timer = setTimeout(() => {
        if (polling !== attempt) return;
        stopPolling();
        if (!stopped && document.visibilityState === "visible")
          setLiveStatus("Updates unavailable");
      }, 10000);
      try {
        const result = await request(
          `${tenantPath(props.tenant.id)}/view-state`,
          { signal: attempt.controller.signal },
        );
        if (
          !stopped &&
          polling === attempt &&
          !attempt.controller.signal.aborted
        ) {
          changed(result.data);
          setLiveStatus(
            liveConnected
              ? "Live hints connected"
              : "Live delivery degraded · reconciling",
          );
        }
      } catch (failure) {
        if (stopped || polling !== attempt || attempt.controller.signal.aborted)
          return;
        if (
          failure instanceof ApiError &&
          [401, 403, 404].includes(failure.status)
        )
          props.onDenied();
        if (!stopped) setLiveStatus("Updates unavailable");
      } finally {
        clearTimeout(attempt.timer);
        if (polling === attempt) polling = undefined;
      }
    }
    const stream = liveStream({
      path: `${tenantPath(props.tenant.id)}/events`,
      onEvent(event) {
        const vector = JSON.parse(event.data);
        if (!vector || typeof vector !== "object" || Array.isArray(vector))
          throw new Error("Invalid live vector");
        liveConnected = true;
        changed(vector);
        if (!stopped) setLiveStatus("Live hints connected");
      },
      onConnect() {
        if (stopped) return;
        liveConnected = false;
        setLiveStatus("Reconciling");
        void reconcile();
        if (document.visibilityState === "visible") setVersion((v) => v + 1);
      },
      onDegraded() {
        if (stopped) return;
        liveConnected = false;
        setLiveStatus("Live delivery degraded · reconciling");
        void reconcile();
      },
      onDenied: props.onDenied,
    });
    function visibility() {
      const visible = document.visibilityState === "visible";
      stream.setVisible(visible);
      if (visible) {
        setLiveStatus("Reconciling");
        void reconcile();
        setVersion((v) => v + 1);
      } else {
        stopPolling();
        clearTimeout(coalesce);
        coalesce = undefined;
      }
    }
    stream.setVisible(document.visibilityState === "visible");
    void reconcile();
    const poll = setInterval(() => void reconcile(), 2000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      stopPolling();
      stream.close();
      clearInterval(poll);
      clearTimeout(coalesce);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [props.tenant.id, props.onDenied]);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const health = useResource<Record<string, unknown>>(
    `${tenantPath(props.tenant.id)}/health`,
    props.onDenied,
    version,
  );
  const adminSection = [
    "operators",
    "permissions",
    "audit",
    "platform",
  ].includes(props.section);
  const subnav = adminSection ? (
    <nav className="tabbar" aria-label="Administration">
      {[
        ["operators", "Operators"],
        ...(props.tenant.role === "admin"
          ? [
              ["permissions", "Permissions"],
              ["audit", "Access audit"],
            ]
          : []),
        ...(props.session.global_super_admin ? [["platform", "Platform"]] : []),
      ].map(([key, label]) => (
        <a
          key={key}
          className="tab"
          href={`/tenants/${props.tenant.id}/${key}`}
          aria-current={props.section === key ? "page" : undefined}
          onClick={(event) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey) return;
            event.preventDefault();
            props.navigate(`/tenants/${props.tenant.id}/${key}`);
          }}
        >
          {label}
        </a>
      ))}
    </nav>
  ) : undefined;
  const scope: Scope = {
    ...props,
    version,
    liveStatus,
    refresh,
    subnav,
    banners: <HealthBanners health={health} />,
  };
  return props.section === "platform" ? (
    <Administration {...scope} />
  ) : props.section === "alerts" ? (
    <Alerts {...scope} id={props.id} />
  ) : sections.some(([key]) => key === props.section) ||
    ["permissions", "audit"].includes(props.section) ? (
    <Resources {...scope} section={props.section} id={props.id} />
  ) : (
    <div className="empty" style={{ margin: 24 }}>
      <h1>Page unavailable</h1>
      <p>Choose an available workspace page.</p>
    </div>
  );
}
/**
 * Tenant processing conditions as nonmodal banners (reference "System
 * states"). Nothing is shown while processing and search are current.
 */
function HealthBanners({
  health,
}: {
  health: ReturnType<typeof useResource<Record<string, unknown>>>;
}) {
  if (health.error)
    return (
      <div className="banner bn-warn" role="status">
        <b>Tenant health unavailable.</b> {message(health.error)}
      </div>
    );
  const data = health.data?.data;
  if (!data) return null;
  const sequence = (value: unknown) =>
    typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
  const committed = sequence(data.committed_seq),
    searchable = sequence(data.searchable_seq);
  return (
    <>
      {data.source_blocked === true && (
        <div className="banner bn-err" role="status">
          <b>Alerts are arriving late.</b> Source processing is blocked for this
          tenant. Administrators can see the repair steps.
        </div>
      )}
      {committed !== null && searchable !== null && searchable < committed && (
        <div className="banner bn-warn" role="status">
          <b>Updating.</b> Search has not caught up with the latest changes.
          Counts may be slightly behind.
        </div>
      )}
    </>
  );
}
