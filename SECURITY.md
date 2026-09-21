# Security policy

This is a personal local application. Do not commit credentials, OAuth tokens, local databases, real student content, or diagnostic exports.

If a secret is accidentally committed, revoke or rotate it at the provider first, then remove it from Git history. Do not rely on deleting the working-tree file alone.

Provider access is read-only for Canvas and Google Classroom. Todoist writes require the explicit `--apply` flag; the compatibility lifecycle test additionally requires `--mutate`.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/Gabriel-Cintron/task-sync/security/advisories/new). Do not place credentials, OAuth tokens, student data, or an unpatched exploit in a public issue. Include the affected version, operating system, impact, and minimal reproduction steps. You should receive an acknowledgement within seven days.

## Supported versions

Security fixes are made on the latest released version. This pre-1.0 project does not promise fixes for older releases.

## Local-data boundary

Task Sync is a single-user local application. Credentials and its SQLite assignment history are stored as plaintext files with owner-only permissions where supported. Users should rely on operating-system account security and full-disk encryption for protection at rest.
