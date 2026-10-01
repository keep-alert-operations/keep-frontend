# Appchi login theme

User-approved password form, installed for the `appchi-web` client only.
Other templates inherit `keycloak`; no authentication provider is replaced.

`login/login.ftl` uses the installed Keycloak 26.7.4 form contract, generated
`url.loginAction`, selected credential and sanitized provider errors. The small
browser module handles appearance, password visibility and submission state,
and imports the parent's `authChecker.js` for its cross-tab session checks.
The form submits normally even with JavaScript disabled. Appearance defaults to
light and is the only value saved in localStorage.

The Geist Latin font is copied from the frontend's pinned Next.js package and
distributed under `login/resources/fonts/OFL.txt`.

See [local setup](../../../../../docs/local-keycloak.md#appchi-login-theme) for
installation and upgrade notes. Review the form and inherited resources whenever
the pinned Keycloak version changes.
