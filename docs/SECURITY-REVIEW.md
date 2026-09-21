# Pre-publication security review

Review date: 2026-09-21  
Release candidate: 0.1.5

This review covers the local application, provider adapters, persistence/import behavior, Electron boundary, packaged Windows application, dependency tree, and release workflow. It is an engineering review, not a third-party penetration test or compliance certification.

## Verified controls

- Canvas and Google Classroom use read-only access; Todoist writes remain previewed and explicitly confirmed.
- The renderer is sandboxed with context isolation, no Node integration, narrow validated IPC, local-only assets, restrictive CSP, denied permissions/downloads/popups, and blocked untrusted navigation.
- Production Electron fuses disable run-as-Node, `NODE_OPTIONS`, and inspect arguments; enable cookie encryption and ASAR integrity; and require application code to load from ASAR.
- Credentials are write-only to the renderer. App-owned settings, secrets, configuration, and SQLite files use owner-only permissions where supported.
- Saved plans are time-limited, single-attempt, bound to configuration and hashed provider credentials, and rehashed from stored JSON immediately before apply.
- Import uses a consistent SQLite backup, integrity and foreign-key checks, schema migration validation, atomic activation, backup, and rollback.
- OAuth uses a pre-bound random loopback port, unpredictable state, PKCE, exact callback-path validation, minimum read-only scopes, timeout, and atomic token storage.
- Provider requests have bounded timeouts; preview work is cancellable; apply remains protected from ordinary cancellation.
- Release automation pins third-party actions by full commit SHA, checks tag/version agreement, performs a full dependency audit, builds and smoke-tests each target OS, and publishes SHA-256 checksums.
- No credential-shaped values were found in the working tree during the review.

## Defects corrected in 0.1.5

- Classroom coursework identity now includes the course ID, with legacy-marker recovery to avoid duplicate Todoist tasks.
- Full due datetimes and precision now participate in drift detection.
- Todoist Inbox identity and project moves are normalized, and update/move operations use separate request identifiers.
- Enrichment cache identity now includes allowlists, destinations, and description limits.
- Imported Windows paths are no longer double-escaped, imported OAuth paths become desktop-owned copies, and credential removal also removes app-owned secret copies and sanitizes settings backups.
- UI settings actions now surface errors instead of leaving rejected operations unhandled.
- Source maps are excluded from packaged bundles.
- Vulnerable archive and DMG build dependencies were replaced with patched Packager 20 and native macOS `hdiutil` packaging.

## Validation results

- TypeScript typecheck: pass
- ESLint: pass
- Unit/integration tests: 46 pass
- Packaged Electron smoke tests: 5 pass
- Windows x64 Squirrel installer creation: pass
- Clean `npm ci`: pass
- Full `npm audit --audit-level=high`: 0 vulnerabilities
- Production ASAR content inspection: only compiled application assets and package metadata
- Production Electron fuse inspection: expected hardened values enabled

Windows was validated locally. The pinned GitHub Actions matrix is the release gate for Windows x64, macOS x64/arm64, and Linux x64 artifacts.

## Accepted limitations

- Initial artifacts are unsigned and not notarized. Users must verify the published SHA-256 checksums before bypassing SmartScreen, Gatekeeper, or Linux trust warnings.
- Local credentials and assignment history are plaintext at rest. Directory/file permissions reduce accidental exposure but do not replace full-disk encryption.
- Institution policy can still block Canvas tokens or Google Classroom consent; the application cannot bypass those controls.
- Electron Forge 8 is currently a pinned prerelease build-only dependency because Forge 7's supported packager retains a vulnerable extractor. Packaged smoke tests and the zero-vulnerability audit are required until Forge 8 is stable.
- No live school, OpenAI, or Todoist account was used in automated tests. Live compatibility checks remain explicit, user-run operations.
