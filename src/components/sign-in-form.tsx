"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { signIn } from "@/lib/sign-in";
import { BrandMark } from "./brand-mark";
import { ThemeSwitch, useTheme } from "./theme-switch";

interface Failure {
  text: string;
  /** The username or password was refused: mark both fields invalid. */
  credentials: boolean;
  requestId?: string;
}

/** One message per outcome (identity configuration 3); never the server's
 * reason for a refusal, so wrong passwords and disabled accounts look alike. */
function failureOf(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.status === 401)
      return {
        text: "The username or password wasn't accepted. Check them and try again.",
        credentials: true,
      };
    if (error.status === 403 && error.code === "account_not_in_directory")
      return {
        text: "Your account isn't in the company directory.",
        credentials: false,
        requestId: error.requestId,
      };
    if (error.status === 403 && error.code === "account_ambiguous")
      return {
        text: "More than one directory account has this username. Contact your administrator.",
        credentials: false,
        requestId: error.requestId,
      };
    if (error.status === 0 || error.status >= 500)
      return {
        text: "Sign-in is unavailable right now. Try again in a moment.",
        credentials: false,
        requestId: error.requestId,
      };
    return {
      text: "Sign-in couldn't be completed. Reload the page and try again.",
      credentials: false,
      requestId: error.requestId,
    };
  }
  return {
    text: "Sign-in is unavailable right now. Try again in a moment.",
    credentials: false,
  };
}

export function SignInForm() {
  const [theme, toggleTheme] = useTheme();
  // The fields are uncontrolled and read at submit: what someone types before the
  // page's script runs survives hydration instead of being reset to empty.
  const passwordRef = useRef<HTMLInputElement>(null);
  const clearPassword = () => {
    if (passwordRef.current) passwordRef.current.value = "";
  };
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  // Until the script runs, a click would submit the form natively; keep the button
  // disabled so a password is never sent by the browser on its own.
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => setReady(true), []);
  // Move focus to a new message so keyboard and screen-reader users hear it.
  useEffect(() => {
    if (failure) errorRef.current?.focus();
  }, [failure]);
  // Returning through the browser's back/forward cache re-enables the form.
  useEffect(() => {
    const ready = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", ready);
    return () => window.removeEventListener("pageshow", ready);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const username = String(fields.get("username") ?? "");
    const password = String(fields.get("password") ?? "");
    if (!username.trim() || !password) {
      setFailure({
        text: "Enter your username and password.",
        credentials: true,
      });
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await signIn({
        username,
        password,
        returnTo:
          new URLSearchParams(window.location.search).get("return_to") ?? "/",
      });
      clearPassword();
      window.location.assign(result.return_to);
    } catch (error) {
      const next = failureOf(error);
      if (next.credentials) clearPassword();
      setFailure(next);
      setBusy(false);
    }
  }
  const invalid = failure?.credentials ? true : undefined;
  const described = failure ? "sign-in-error" : undefined;
  return (
    <div className="login-screen">
      <div className="sign-in-stage">
        <main
          id="main-content"
          className="login sign-in"
          aria-labelledby="sign-in-title"
        >
          <div className="login-brand">
            <div className="brand-mark" aria-hidden="true">
              <BrandMark />
            </div>
            <div>
              <div className="sign-in-name">Keep</div>
              <p>Alert operations, in one place.</p>
            </div>
          </div>
          <h1 id="sign-in-title">Sign in</h1>
          <p className="sign-in-intro">
            Use your company username and password.
          </p>
          {/* POST, never the default GET, so even a native submit can't put the
              password in the address, history or server logs. */}
          <form
            className="sign-in-form"
            method="post"
            noValidate
            onSubmit={submit}
          >
            {failure && (
              <div
                id="sign-in-error"
                ref={errorRef}
                tabIndex={-1}
                role="alert"
                className="sign-in-message"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7.5v5.5M12 16.5h.01" />
                </svg>
                <span>
                  {failure.text}
                  {failure.requestId && (
                    <span className="sign-in-request">
                      Request {failure.requestId}
                    </span>
                  )}
                </span>
              </div>
            )}
            <div>
              <label className="sign-in-label" htmlFor="username">
                Username
              </label>
              <input
                className="sign-in-input"
                id="username"
                name="username"
                type="text"
                placeholder="Enter your username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                required
                maxLength={64}
                aria-invalid={invalid}
                aria-describedby={described}
              />
            </div>
            <div>
              <label className="sign-in-label" htmlFor="password">
                Password
              </label>
              <div className="sign-in-field">
                <input
                  className="sign-in-input sign-in-password"
                  id="password"
                  name="password"
                  ref={passwordRef}
                  type={reveal ? "text" : "password"}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                  aria-invalid={invalid}
                  aria-describedby={described}
                />
                <button
                  className="sign-in-eye"
                  type="button"
                  aria-label={reveal ? "Hide password" : "Show password"}
                  aria-controls="password"
                  aria-pressed={reveal}
                  onClick={() => setReveal(!reveal)}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    aria-hidden="true"
                  >
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                    <circle cx="12" cy="12" r="3" />
                    {reveal && <path d="m3 3 18 18" />}
                  </svg>
                </button>
              </div>
            </div>
            <button
              className="btn btn-p sign-in-submit"
              type="submit"
              disabled={busy || !ready}
              aria-busy={busy || undefined}
            >
              <span>{busy ? "Signing in…" : "Sign in"}</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <path d="M5 12h14m-6-6 6 6-6 6" />
              </svg>
            </button>
          </form>
          <details className="sign-in-help">
            <summary>Need help signing in?</summary>
            <p>
              For account access or password help, contact your company’s IT
              support.
            </p>
          </details>
        </main>
        <ThemeSwitch theme={theme} onToggle={toggleTheme} />
      </div>
    </div>
  );
}
