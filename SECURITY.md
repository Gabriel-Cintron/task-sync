# Security policy

This is a personal local application. Do not commit credentials, OAuth tokens, local databases, real student content, or diagnostic exports.

If a secret is accidentally committed, revoke or rotate it at the provider first, then remove it from Git history. Do not rely on deleting the working-tree file alone.

Provider access is read-only for Canvas and Google Classroom. Todoist writes require the explicit `--apply` flag; the compatibility lifecycle test additionally requires `--mutate`.

Report a suspected application vulnerability privately to the repository owner rather than placing credentials or student data in a public issue.
