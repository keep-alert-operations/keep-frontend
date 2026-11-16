# keep-frontend

Next.js user interface, generated HTTP client, browser tests and the sign-in page.

See [system design](https://github.com/keep-alert-operations/keep-design), [workspace setup](https://github.com/keep-alert-operations/keep-delivery) and [source provenance](SOURCE.md).

## Development

Use the Node version required by `package.json` and configure Git authentication
for the private contracts repository.

```powershell
npm ci
npm run generate
npm run typecheck
npm run build
npm test
```

`KEEP_BACKEND_URL` selects the trusted Product API origin for development. Real
identity and system browser checks require the documented isolated environment.
The Docker build context is this repository.

Keep's own sign-in page is `src/app/sign-in` at `/sign-in` (REV-73): a username
and password form that posts `POST /auth/login`. It sits outside `/auth`, which
the Product API serves, and outside the workspace route, so it never runs the
session check. The local OpenLDAP and mock ADAPI it signs in against are
described in delivery's [local sign-in and directory](https://github.com/keep-alert-operations/keep-delivery/blob/main/docs/local-identity.md).
