export default function SignInExpiredPage() {
  return (
    <div className="login-screen">
      <main id="main-content" className="login">
        <div className="login-brand">
          <div className="brand-mark" aria-hidden="true">
            K
          </div>
          <div>
            <h1>Sign-in link expired</h1>
            <p>Keep</p>
          </div>
        </div>
        <p className="login-lead">
          This sign-in attempt has expired or already been used. Start a new
          sign-in with your username and password.
        </p>
        <a className="btn btn-p login-button" href="/auth/login">
          Sign in again
        </a>
        <p className="help">
          <a href="/">Back to Keep</a>
        </p>
      </main>
    </div>
  );
}
