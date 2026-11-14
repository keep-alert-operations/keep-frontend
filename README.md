# keep-frontend

Next.js user interface and generated HTTP client. Sign-in is handled by the
identity provider's own login portal (Authelia's stock portal in the dev stack);
this repository ships no custom login theme.

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
The Docker build context is this repository. The identity provider (Authelia)
and its OpenLDAP backing directory are provisioned and configured in delivery;
the frontend only calls the same-origin `/auth` and `/api` endpoints.
