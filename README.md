# keep-frontend

Next.js user interface, generated HTTP client and custom Keycloak login theme.

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
The Docker build context is this repository. Keycloak theme assets live under
`keycloak/themes`; realm/client configuration lives in delivery.
