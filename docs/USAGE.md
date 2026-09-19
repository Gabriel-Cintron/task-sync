# Usage guide

This guide walks through setting up and operating the school-obligations-to-Todoist sync safely. The application reads Canvas and/or Google Classroom, optionally enriches assignment text with OpenAI, and creates or updates Todoist tasks only when you explicitly pass `--apply`.

## 1. Before you begin

You need:

- Node.js 22.13 or later.
- npm.
- A Todoist account and API token.
- Access to at least one supported source:
  - a Canvas personal access token permitted by your school; or
  - a Google Classroom account permitted to authorize a personal Google OAuth application.
- An OpenAI API key only if you want LLM enrichment. The default `fallback` mode works without one.

The application does not request or store your school password.

## 2. Install the application

From the repository directory:

```powershell
npm install
Copy-Item .env.example .env
Copy-Item task-sync.config.example.json task-sync.config.json
```

On macOS or Linux:

```bash
npm install
cp .env.example .env
cp task-sync.config.example.json task-sync.config.json
```

Confirm that the CLI starts:

```bash
npm run cli -- --help
```

The `.env`, `task-sync.config.json`, OAuth files, and local SQLite database contain personal configuration or data. Do not commit them. The provided `.gitignore` already excludes the sensitive files and database.

## 3. Configure Todoist

Todoist is the destination and is required even for a sync dry-run because the planner reads existing tasks to prevent duplicates.

1. In Todoist, open **Settings → Integrations → Developer**.
2. Copy the personal API token.
3. Set it in `.env`:

```dotenv
TODOIST_API_TOKEN=replace-with-your-token
```

Do not add quotes unless they are part of the actual value.

Run the read-only compatibility check:

```bash
npm run check:todoist
```

This verifies authentication and counts visible projects and sections without changing Todoist.

After the read-only check passes, you may explicitly test the full write lifecycle:

```bash
npm run check:todoist -- --mutate
```

That command creates, retrieves, updates, and deletes one clearly labeled compatibility-test task. Do not use `--mutate` if you only want a read-only check.

## 4. Configure OpenAI enrichment

OpenAI enrichment is optional in the default configuration. It cleans noisy titles, summarizes useful instructions, classifies actionability, and may suggest an allowlisted label or destination. Deterministic application code still controls identities, deadlines, mappings, deduplication, and Todoist writes.

To enable it, add your key and desired model to `.env`:

```dotenv
OPENAI_API_KEY=replace-with-your-key
OPENAI_MODEL=gpt-4.1-mini
```

Test authentication and strict structured output:

```bash
npm run check:openai
```

You can test the enrichment pipeline without any real student data:

```bash
npm run cli -- enrich-fixture
```

If no OpenAI key is configured and the mode is `fallback`, this fixture command uses source fields and reports that deterministic fallback was used.

Choose the behavior in `task-sync.config.json`:

```json
{
  "enrichment": {
    "mode": "fallback",
    "model": "gpt-4.1-mini",
    "inferredDueConfidence": 0.85,
    "mappingConfidence": 0.8,
    "maxDescriptionCharacters": 8000,
    "allowedLabels": ["school", "needs-review"]
  }
}
```

Available modes:

| Mode | Behavior |
| --- | --- |
| `fallback` | Use OpenAI when available; safely fall back to source fields after a missing key, refusal, timeout, rate limit, or invalid result. |
| `required` | Report an item error and skip its write if enrichment does not succeed. |
| `disabled` | Never call OpenAI. |

Only labels in `allowedLabels` can be accepted from the model.

## 5. Configure Canvas

Use Canvas only if your school permits personal access tokens.

1. Sign in to your institution's Canvas site.
2. Create a personal access token from the approved account/settings area, if available.
3. Add the HTTPS school URL and token to `.env`:

```dotenv
CANVAS_BASE_URL=https://school.instructure.com
CANVAS_ACCESS_TOKEN=replace-with-your-token
```

4. Give the connection a stable local name in `task-sync.config.json`:

```json
{
  "sources": {
    "canvas": {
      "connectionId": "my-school-canvas"
    }
  }
}
```

Do not change `connectionId` after syncing unless you intentionally want the same account to be treated as a new source connection.

Run the compatibility check:

```bash
npm run check:canvas
```

It authenticates, reads your profile, lists active courses, and samples assignment due-date and URL fields. It does not modify Canvas.

If your school disables personal tokens, the application cannot bypass that policy. Canvas OAuth for a future multi-user deployment would normally require an institution-approved developer key.

## 6. Configure Google Classroom

Google Classroom uses a local OAuth Desktop application and read-only scopes.

1. Create or select a Google Cloud project.
2. Enable the Google Classroom API.
3. Configure the OAuth consent screen required by your account or institution.
4. Create an OAuth client with application type **Desktop app**.
5. Download the client JSON into a local `secrets` directory, for example:

```text
secrets/google-oauth-client.json
```

6. Configure the paths in `.env`:

```dotenv
GOOGLE_CLIENT_SECRET_FILE=./secrets/google-oauth-client.json
GOOGLE_TOKEN_FILE=./secrets/google-oauth-token.json
```

7. Set a stable connection name in `task-sync.config.json`:

```json
{
  "sources": {
    "googleClassroom": {
      "connectionId": "my-school-google"
    }
  }
}
```

8. Start authorization:

```bash
npm run cli -- auth classroom
```

Open the printed URL, sign in to the intended school Google account, and approve the requested read-only access. After the browser redirects to the local callback, the refresh token is stored at `GOOGLE_TOKEN_FILE`.

9. Run the compatibility check:

```bash
npm run check:classroom
```

The application requests:

- `classroom.courses.readonly`
- `classroom.coursework.me.readonly`

The check lists active courses, coursework, and submission records accessible for the signed-in student. Google Workspace administrators may block unverified apps or individual scopes. If that happens, use the reported error when contacting the administrator; do not provide the application with your school password.

## 7. Configure course destinations

Edit `task-sync.config.json` before the first live sync. Destinations are stable local keys that point to Todoist projects and optional sections:

```json
{
  "destinations": {
    "inbox": {},
    "math": {
      "projectId": "your-todoist-project-id",
      "sectionId": "your-optional-section-id"
    },
    "english": {
      "projectId": "another-project-id"
    }
  },
  "defaultDestinationKey": "inbox"
}
```

An empty object means Todoist Inbox. Remove the placeholder project and section IDs from the example file or replace them with real IDs before syncing.

Map courses by their provider ID whenever possible:

```json
{
  "courseMappings": [
    {
      "sourceType": "canvas",
      "connectionId": "my-school-canvas",
      "courseExternalId": "12345",
      "destinationKey": "math",
      "enabled": true
    },
    {
      "sourceType": "google_classroom",
      "connectionId": "my-school-google",
      "courseAlias": "english 11",
      "destinationKey": "english"
    }
  ]
}
```

Set `enabled` to `false` to omit a course from Canvas fetching and all sync previews. The desktop setup screen manages this with the **Include in sync** checkbox. Existing configurations that omit `enabled` continue to include the course.

Mapping order is deterministic:

1. Exact provider, connection, and course external ID.
2. Configured normalized course-name alias.
3. An allowlisted OpenAI suggestion above `mappingConfidence`.
4. The default destination, with a warning.

The application does not silently fuzzy-match course names. Start with the Inbox default if you do not yet know your course IDs; a dry-run prints source keys and warnings that can help you refine the configuration before applying.

## 8. Run the first dry-run

Always begin with one source and no `--apply` flag.

Canvas:

```bash
npm run sync -- --source canvas
```

Google Classroom:

```bash
npm run sync -- --source classroom
```

Both configured sources:

```bash
npm run sync -- --source all --dry-run
```

Dry-run is the default. `--dry-run` is available when you want the intent to be explicit in a script or terminal history.

Planning may read existing Todoist tasks to check stored mappings and stable markers. It does not create, update, complete, move, or delete Todoist tasks.

Typical output resembles:

```text
Sources: canvas
OpenAI enrichment: 2 cached, 2 processed, 0 fallback, 0 disabled
Sync plan: 2 create, 1 update, 1 unchanged
  CREATE canvas:my-school-canvas:1001: No existing mapping or stable marker found
  UPDATE canvas:my-school-canvas:1002: Resolved task content changed
  UNCHANGED canvas:my-school-canvas:1003: Source and Todoist destination fingerprints are unchanged
Todoist: dry run; no changes applied
Plan ID: ...
```

Review every `CREATE`, `UPDATE`, warning, conflict, and destination before continuing.

## 9. Understand plan actions

| Action | Meaning |
| --- | --- |
| `create` | No local mapping or Todoist stable marker was found; apply will create a task. |
| `update` | Source content changed, Todoist drifted, or one stable marker recovered a missing local mapping. |
| `unchanged` | The source, stored applied fingerprint, and current Todoist task agree. No write is needed. |
| `skip` | The item is non-actionable or excluded by the submitted/completed policy. |
| `conflict` | Safe automatic handling is impossible, such as multiple stable-marker matches or a missing mapped Todoist task. No write occurs. |
| `error` | A source, enrichment, validation, or provider operation failed. No write occurs for that item. |

Enrichment counters mean:

| Status | Meaning |
| --- | --- |
| `processed` | OpenAI produced a new validated result. |
| `cached` | An unchanged item reused its versioned local result; no OpenAI call was made. |
| `fallback` | OpenAI was unavailable or failed and deterministic source fields were used. |
| `disabled` | Configuration bypassed OpenAI entirely. |

Warnings deserve review but do not necessarily block an action. Common examples are an unmapped course using Inbox, an item without a deadline, or a clearly labeled inferred deadline.

## 10. Apply a reviewed sync

After the dry-run is correct, rerun the same source selection with `--apply`:

```bash
npm run sync -- --source canvas --apply
```

Or:

```bash
npm run sync -- --source all --apply
```

The application generates a current plan and applies that plan in the same invocation. It does not apply an old plan silently.

Afterward, rerun the dry-run:

```bash
npm run sync -- --source all
```

Successfully synced, unchanged items should now report `unchanged`, with cached enrichment and no Todoist writes.

## 11. Machine-readable output

Add `--json` to a sync or diagnostic when another local tool needs structured output:

```bash
npm run sync -- --source canvas --json
npm run check:todoist -- --json
```

Do not publish JSON output from a real account without reviewing it. A sync plan can contain assignment titles, descriptions, course names, source URLs, and stable identifiers even though secrets are sanitized.

## 12. Force re-enrichment

Normal repeated runs reuse cached OpenAI results for unchanged content. To intentionally ignore the cache for the current run:

```bash
npm run sync -- --source canvas --force-reenrich
```

Review the resulting dry-run first. To apply it:

```bash
npm run sync -- --source canvas --force-reenrich --apply
```

Use this after changing model behavior or when you deliberately want a fresh interpretation. Prompt, schema, or configured model version changes already create new cache keys automatically.

## 13. Completion, undated-item, and missing-item behavior

The default policy is:

```json
{
  "sync": {
    "completedSourceItems": "skip",
    "undatedSourceItems": "include",
    "missingSourceItems": "retain"
  }
}
```

- Submitted or completed LMS items are skipped.
- Undated items are included unless `undatedSourceItems` is set to `skip`. In the desktop app, the setup checkbox and Settings control this behavior.
- An item disappearing from an LMS does not complete or delete its Todoist task.
- The application never creates speculative study sessions or subtasks.

Set `completedSourceItems` to `include` only if you intentionally want submitted/completed source items considered for synchronization. Automatic Todoist completion is not implemented.

The desktop appearance setting accepts `system`, `light`, or `dark`; `system` follows the operating-system preference.

## 14. Local state and backups

The default database is:

```text
data/task-sync.sqlite
```

It contains source fingerprints, stable mappings, enrichment results and provenance, saved plans, and sync outcomes. It does not contain provider access tokens.

You can override the location with:

```dotenv
TASK_SYNC_DB=./data/another-name.sqlite
```

Do not casually delete the database after a live sync. Stable markers provide conservative recovery, but preserving the database is the safest and fastest way to retain mappings and avoid unnecessary updates. Back up the database only while the CLI is not running, and protect the backup because it can contain student assignment content.

## 15. Troubleshooting

### `TODOIST_API_TOKEN is required`

Add the token to `.env`, ensure the file is in the repository root, and rerun `npm run check:todoist`.

### `No configured source adapters matched the selection`

For `--source all`, no source had all required environment variables. Configure Canvas or Classroom, or select one configured source explicitly.

### Canvas credentials or HTTP 401

Verify the Canvas base URL is the institution's HTTPS root and rotate or recreate the personal access token. Do not include `/api/v1` in `CANVAS_BASE_URL`.

### Canvas or Classroom HTTP 403

The requested capability may be blocked by an administrator, OAuth policy, role, or scope. Run the corresponding `check` command and use its reported category/details when contacting the institution. The application cannot bypass school policy.

### Google OAuth token not found

Run:

```bash
npm run cli -- auth classroom
```

Confirm that `GOOGLE_CLIENT_SECRET_FILE` points to the downloaded Desktop client JSON and `GOOGLE_TOKEN_FILE` points to a writable, gitignored location.

### OpenAI uses fallback unexpectedly

Run `npm run check:openai`. Verify `OPENAI_API_KEY`, the configured model, account access, and rate limits. In `fallback` mode, this condition is deliberately non-fatal and is visible in output.

### `Unknown destination key`

Every `destinationKey` used by `courseMappings` and `defaultDestinationKey` must exist in the top-level `destinations` object.

### A plan reports `conflict`

Do not repeatedly apply the plan hoping it will resolve itself. Inspect Todoist for duplicate tasks containing the same task-sync marker or determine why the mapped task was removed. Resolve the duplicates or restore the intended task, then rerun a dry-run.

### A write failed partway through

Rerun a dry-run. Successful mappings are stored only after successful writes, existing mappings are preserved on failures, and stable markers provide conservative recovery. Review the new plan before retrying with `--apply`.

### Course went to Inbox

Look for `No course mapping matched; default destination used`. Add an exact course ID or alias mapping, rerun the dry-run, and confirm the proposed update moves the task to the intended project or section.

## 16. Recommended operating routine

For normal manual use:

```bash
# 1. Inspect changes
npm run sync -- --source all

# 2. Apply only after review
npm run sync -- --source all --apply

# 3. Confirm idempotency
npm run sync -- --source all
```

The third command should primarily report `unchanged` or policy-driven `skip` actions. Investigate unexpected repeated updates, conflicts, or errors before scheduling the CLI externally.

## Command reference

| Command | Purpose | Writes externally? |
| --- | --- | --- |
| `npm run cli -- --help` | Show CLI help. | No |
| `npm run cli -- enrich-fixture` | Test enrichment with synthetic data. | OpenAI call only when configured; no Todoist write |
| `npm run cli -- auth classroom` | Complete Google OAuth and save a local token. | Saves local OAuth token |
| `npm run check:openai` | Test key and strict Responses API output. | OpenAI request only |
| `npm run check:canvas` | Test profile, courses, and assignment reads. | No |
| `npm run check:classroom` | Test courses, coursework, and submission reads. | No |
| `npm run check:todoist` | Test Todoist authentication/project/section reads. | No |
| `npm run check:todoist -- --mutate` | Test Todoist create/retrieve/update/delete. | Yes, temporary labeled task |
| `npm run sync -- --source canvas` | Plan Canvas synchronization. | No |
| `npm run sync -- --source classroom` | Plan Classroom synchronization. | No |
| `npm run sync -- --source all --apply` | Plan and apply all configured sources. | Yes |
