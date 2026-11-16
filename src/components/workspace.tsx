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
import { onOwnCommand, useResource } from "@/lib/hooks";
import { liveCoalescer } from "@/lib/live-coalescer";
import { liveStream } from "@/lib/live-stream";
import { Alerts } from "./alerts";
import { Resources } from "./resources";
import { Administration } from "./administration";
import { Integrations } from "./integrations";
import { ErrorNotice } from "./ui";
import { Icon } from "./icons";
import { BrandMark } from "./brand-mark";
import { ThemeSwitch, useTheme } from "./theme-switch";
import { signInPath } from "@/lib/sign-in";

const sections = [
  ["alerts", "Feed"],
  ["incidents", "Incidents"],
  ["presets", "Presets"],
  ["correlation-rules", "Correlation rules"],
  ["maintenance", "Maintenance"],
  ["dashboards", "Dashboards"],
  ["reports", "Reports"],
  ["operators", "Operators"],
] as const;

/** Per-tenant Administration pages; Global has none (REV-72). */
const tenantAdminPages = ["operators", "permissions", "audit"];

/** The Administration tabs this user sees in this tenant, in order. In Global
 * only global super-admins get Administration, with Integrations and Platform
 * (REV-72). */
function adminTabs(tenant: Tenant, session: Session): [string, string][] {
  return [
    ...(tenant.kind === "global"
      ? []
      : ([
          ["operators", "Operators"],
          ...(tenant.role === "admin"
            ? [
                ["permissions", "Permissions"],
                ["audit", "Access audit"],
              ]
            : []),
        ] as [string, string][])),
    ...(session.global_super_admin
      ? ([
          ["integrations", "Integrations"],
          ["platform", "Platform"],
        ] as [string, string][])
      : []),
  ];
}

export interface Scope {
  tenant: Tenant;
  session: Session;
  version: number;
  liveStatus?: string;
  /** Last reported search projection lag for this tenant. */
  searchUpdating?: boolean;
  /** Re-reads the current view (live status control). */
  refresh?: () => void;
  /** Administration tabs rendered under the page header. */
  subnav?: React.ReactNode;
  /** Tenant processing banners rendered at the top of the page body. */
  banners?: React.ReactNode;
  onDenied: () => void;
  /** Opens a page, first confirming when the current page reports unsaved work.
   * `refresh` rereads the signed-in user's tenant access before opening it, for
   * a tenant created after the session was read. */
  navigate: (url: string, options?: { refresh?: boolean }) => void;
  /** Reports unsaved work; a string replaces the default leave question. */
  setDirty: (dirty: boolean | string) => void;
}

const discardQuestion =
  "Discard unsaved changes and leave? Choose Cancel to stay and save your draft.";
const leaveQuestion = (dirty: boolean | string) =>
  typeof dirty === "string" ? dirty : discardQuestion;

export function Workspace() {
  const pathname = usePathname(),
    router = useRouter();
  const [session, setSession] = useState<Session>(),
    [error, setError] = useState<unknown>(),
    [loading, setLoading] = useState(true);
  const [accountOpen, setAccountOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const [notice, setNotice] = useState<string>();
  const [signingOut, setSigningOut] = useState(false);
  const [epoch, setEpoch] = useState(0),
    [dirty, setDirtyState] = useState<boolean | string>(false);
  // Navigation reads the latest report, including one made earlier in the same
  // event handler, before React has rendered it. The setter's identity is stable.
  const dirtyNow = useRef<boolean | string>(false);
  const setDirty = useCallback((value: boolean | string) => {
    dirtyNow.current = value;
    setDirtyState(value);
  }, []);
  const sessionRequest = useRef<AbortController | null>(null);
  const signedOut = useRef(false);
  const hasAuthenticated = useRef(false);
  const loginStarted = useRef(false);
  /** Rereads the session; says whether it was applied, superseded or failed. */
  const reauthorize = useCallback(async (clear = false) => {
    if (signedOut.current) return "failed";
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
      if (controller.signal.aborted) return "superseded";
      hasAuthenticated.current = true;
      setSession(result.data);
      setError(undefined);
      return "applied";
    } catch (failure) {
      if (controller.signal.aborted) return "superseded";
      setError(failure);
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
        setSession(undefined);
        setDirty(false);
        setEpoch((v) => v + 1);
      }
      return "failed";
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
  const openingSignIn =
    !session &&
    !hasAuthenticated.current &&
    !signedOut.current &&
    pathname !== "/signed-out" &&
    error instanceof ApiError &&
    error.status === 401 &&
    error.code === "unauthenticated";
  // Entry without a session opens Keep's sign-in page for this path and query
  // (identity configuration 2). A session lost later keeps the recovery card.
  useEffect(() => {
    if (!openingSignIn || loginStarted.current) return;
    loginStarted.current = true;
    window.location.replace(
      signInPath(window.location.pathname + window.location.search),
    );
  }, [openingSignIn]);
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
  const navigate = (url: string, options?: { refresh?: boolean }) => {
    const pending = dirtyNow.current;
    if (pending && !window.confirm(leaveQuestion(pending))) return;
    setDirty(false);
    if (!options?.refresh) {
      router.push(url);
      return;
    }
    // Open the page only with a session that lists the new tenant. A check that
    // another session read cut short is retried once; a failure stays here.
    void (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await reauthorize();
        if (outcome === "applied") router.push(url);
        if (outcome !== "superseded") return;
      }
    })();
  };
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: PopStateEvent) => {
      if (window.confirm(leaveQuestion(dirty))) {
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
    // Sign-out is local only (REV-73; identity configuration 10). Protected
    // client state is cleared at once, even if the request cannot be confirmed.
    signedOut.current = true;
    sessionRequest.current?.abort();
    const csrf = session?.csrf_token;
    setSession(undefined);
    setDirty(false);
    setEpoch((v) => v + 1);
    setSigningOut(true);
    try {
      await request("/auth/logout", { method: "POST", csrf, body: {} });
      setNotice(undefined);
    } catch (failure) {
      setNotice(
        `Sign-out could not be confirmed. Protected data was cleared. ${message(failure)}`,
      );
    }
    setSigningOut(false);
    router.replace("/signed-out");
  }
  if (!session) {
    // An unauthenticated response is the normal signed-out state; only
    // transport or service failures are reported as a connection problem.
    const signedOutState =
      error instanceof ApiError && [401, 403].includes(error.status);
    const signedOutPage = pathname === "/signed-out";
    return (
      <div className="login-screen">
        <main id="main-content" className="login">
          <div className="login-brand">
            <div className="brand-mark" aria-hidden="true">
              <BrandMark />
            </div>
            <div>
              <h1>Keep</h1>
              <p>Alert operations, in one place.</p>
            </div>
          </div>
          {loading || openingSignIn || signingOut ? (
            <p role="status" className="login-lead">
              {signingOut
                ? "Signing out…"
                : openingSignIn
                  ? "Opening sign in…"
                  : "Checking your session…"}
            </p>
          ) : (
            <>
              <p
                className="login-lead"
                role={signedOutPage ? "status" : undefined}
              >
                {signedOutPage
                  ? "You have signed out of Keep."
                  : "Sign in with your company username and password."}
              </p>
              <a
                className="btn btn-p login-button"
                href={
                  signedOutPage
                    ? signInPath()
                    : signInPath(
                        window.location.pathname + window.location.search,
                      )
                }
              >
                Sign in
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
            Your company identity determines tenant access. Sessions last 24
            hours.
          </p>
          <ThemeSwitch theme={theme} onToggle={toggleTheme} />
        </main>
      </div>
    );
  }
  const adminSection = [
    "operators",
    "permissions",
    "audit",
    "integrations",
    "platform",
  ].includes(section);
  // The rail's Admin link opens the first Administration tab.
  const [adminHome, adminLabel] =
    (tenant && adminTabs(tenant, session)[0]) ?? [];
  return (
    <div className="shell" data-section={section} data-detail={Boolean(id)}>
      <aside className="rail">
        <a
          href="/"
          aria-label="Keep home"
          className="brand-mark"
          onClick={(event) => {
            event.preventDefault();
            navigate("/");
          }}
        >
          <BrandMark />
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
          {tenant && adminHome && (
            <a
              href={`/tenants/${tenant.id}/${adminHome}`}
              aria-label={adminLabel}
              title="Administration"
              aria-current={adminSection ? "page" : undefined}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey || event.shiftKey) return;
                event.preventDefault();
                navigate(`/tenants/${tenant.id}/${adminHome}`);
              }}
            >
              <Icon name="operators" />
              <span>Admin</span>
            </a>
          )}
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
              <ThemeSwitch theme={theme} onToggle={toggleTheme} />
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
  const pendingLive = useRef<ReturnType<typeof liveCoalescer>>(undefined);
  useEffect(() => {
    let stopped = false,
      lastVector = "",
      liveConnected = false;
    const coalesce = liveCoalescer(() => {
      if (!stopped && document.visibilityState === "visible")
        setVersion((v) => v + 1);
    });
    pendingLive.current = coalesce;
    // Search reflects the user's own command only after its projection hint.
    const scope = `${tenantPath(props.tenant.id)}/`;
    const stopCommands = onOwnCommand((path) => {
      if (path.startsWith(scope)) coalesce.expedite();
    });
    // A direct reload covers every change seen so far; drop the pending merge.
    function reload() {
      coalesce.cancel();
      setVersion((v) => v + 1);
    }
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
      if (document.visibilityState === "visible") coalesce.change();
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
        if (document.visibilityState === "visible") reload();
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
        reload();
      } else {
        stopPolling();
        coalesce.cancel();
      }
    }
    stream.setVisible(document.visibilityState === "visible");
    void reconcile();
    const poll = setInterval(() => {
      if (!liveConnected) void reconcile();
    }, 2000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      stopPolling();
      stream.close();
      clearInterval(poll);
      coalesce.cancel();
      stopCommands();
      if (pendingLive.current === coalesce) pendingLive.current = undefined;
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [props.tenant.id, props.onDenied]);
  const refresh = useCallback(() => {
    pendingLive.current?.cancel();
    setVersion((v) => v + 1);
  }, []);
  const health = useResource<Record<string, unknown>>(
    `${tenantPath(props.tenant.id)}/health`,
    props.onDenied,
    version,
  );
  const adminSection = [
    "operators",
    "permissions",
    "audit",
    "integrations",
    "platform",
  ].includes(props.section);
  const subnav = adminSection ? (
    <nav className="tabbar" aria-label="Administration">
      {adminTabs(props.tenant, props.session).map(([key, label]) => (
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
    searchUpdating: !health.error && isSearchUpdating(health.data?.data),
    refresh,
    subnav,
    banners: <HealthBanners health={health} />,
  };
  // Operators, Permissions and Access audit don't exist in Global (REV-72).
  const tenantAdminPage = tenantAdminPages.includes(props.section);
  const hidden = tenantAdminPage && props.tenant.kind === "global";
  return props.section === "platform" ? (
    <Administration {...scope} />
  ) : props.section === "integrations" ? (
    <Integrations {...scope} />
  ) : props.section === "alerts" ? (
    <Alerts {...scope} id={props.id} />
  ) : !hidden &&
    (sections.some(([key]) => key === props.section) || tenantAdminPage) ? (
    <Resources {...scope} section={props.section} id={props.id} />
  ) : (
    <div className="empty" style={{ margin: 24 }}>
      <h1>Page unavailable</h1>
      <p>Choose an available workspace page.</p>
    </div>
  );
}
function isSearchUpdating(data?: Record<string, unknown>) {
  const sequence = (value: unknown) =>
    typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
  const committed = sequence(data?.committed_seq);
  const searchable = sequence(data?.searchable_seq);
  return committed !== null && searchable !== null && searchable < committed;
}

/** Tenant failures remain prominent; routine search lag uses the status line. */
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
  if (data?.source_blocked !== true) return null;
  return (
    <div className="banner bn-err" role="status">
      <b>Alerts are arriving late.</b> Source processing is blocked for this
      tenant. Administrators can see the repair steps.
    </div>
  );
}
