# Contributing

Thank you for helping improve Task Sync. Keep changes focused, avoid real credentials or student data, and use synthetic fixtures for tests.

## Development workflow

1. Create a branch from `main`.
2. Install the locked dependency tree with `npm ci`.
3. Make the smallest coherent change and add or update tests.
4. Run:

   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run build
   npm audit --audit-level=high
   ```

5. Open a pull request describing behavior changes, security/privacy effects, and manual validation.

Provider-facing behavior should preserve preview-before-apply, stable identity, deterministic duplicate prevention, and read-only LMS access. New IPC methods must remain narrow and validate both arguments and results. Never add secrets, real LMS exports, local databases, or diagnostic dumps to commits.

Report security issues through the private process in [SECURITY.md](SECURITY.md), not a public issue.
