# keep-frontend

Next.js user interface, generated HTTP client, browser tests and the sign-in page.

Read the workspace-level `../AGENTS.md` and instructions scoped to affected files.
Choose task-relevant sources from the [context map](../keep-design/context/map.md)
using intent, paths and behavioral impact. For a local edit, start with local code,
README guidance and affected checks. For behavior, architecture or cross-repository
changes, include relevant system design, current worker scope and affected contracts.
Read source introductions/scope corrections with selected sections; expand when new
dependencies or uncertainty appear. All applicable requirements remain binding.
If working from a standalone clone, use the canonical [workspace guidance](https://github.com/keep-alert-operations/keep-delivery/blob/main/workspace/AGENTS.md)
and [design](https://github.com/keep-alert-operations/keep-design/tree/main/specs).

This repository owns its source, tests and artifact. Runtime imports must not
depend on another service repository. Shared packages may depend only on their
declared lower-level packages. Cross-repository changes require compatible pinned
dependencies, affected consumer verification and updated delivery evidence.

Use the README and committed manifests for commands. Preserve unrelated changes,
migration checksums, protocol field names, tenant/recovery safeguards and deferred
worker scope. The extracted source includes historical checks; their evidence is
not proof for this revision. Production qualification remains separate.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
