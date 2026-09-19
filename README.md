# School obligations → Todoist sync

A personal-use TypeScript CLI that reads real assignments from Canvas and Google Classroom, optionally uses OpenAI to clean and classify them, and plans safe Todoist creates or updates. External writes are deterministic and opt-in.

For installation, credential setup, first-run instructions, output interpretation, and troubleshooting, see the [complete usage guide](docs/USAGE.md).

## What is implemented

- Canvas active-course and assignment reads, including current-user submission state and opaque `Link` pagination.
- Google Classroom active-course, coursework, and current-student submission reads using read-only OAuth scopes.
- OpenAI Responses API enrichment with strict Zod Structured Outputs, a versioned prompt/schema, privacy-conscious truncation, SQLite caching, provenance, and configurable failure policy.
- Todoist API v1 reads, creates, updates, project/section moves, stable-marker recovery, and a separately gated compatibility write test.
- SQLite source records, identity mappings, applied fingerprints, enrichment cache, saved plans, runs, and per-item outcomes.
- Deterministic project mapping, deadline authority/confidence rules, completed-item policy, dry-run by default, and JSON output.
- Unit/integration coverage with only synthetic data and fake third-party APIs.

No live account was used during repository construction. Run the compatibility commands below to establish what each of your accounts and school policies permit.

## Architecture

```text
Canvas / Google Classroom / test fake
                 │
        normalized ExternalItem
                 │
     cached optional LLM enrichment
                 │
 deterministic policy + course mapping
                 │
        inspectable SyncPlan
                 │ --apply only
          Todoist adapter
                 │
       SQLite mapping + audit state
```

Provider payloads are validated and normalized at the boundary. The sync engine depends only on `SourceAdapter`, `EnrichmentService`, `TodoistDestination`, and `SyncRepository`; it has no Canvas, Classroom, OpenAI, or raw Todoist branches.

Stable identity is `sourceType + connectionId + externalId`. The `connectionId` is deliberately required so identical provider IDs from two schools or accounts cannot collide.

## Requirements and installation

- Node.js 22.13 or later (Node 24 is used in development).
- npm.

```bash
npm install
Copy-Item .env.example .env
Copy-Item task-sync.config.example.json task-sync.config.json
```

On macOS/Linux, use `cp` instead of `Copy-Item`. Never commit `.env`, `secrets/`, OAuth tokens, databases, logs, or diagnostic dumps; all are ignored.

## Configuration

Edit `task-sync.config.json`. Destination keys are stable local names; their `projectId` and optional `sectionId` are Todoist IDs. An empty destination sends tasks to the Inbox.

Course mapping precedence is:

1. Matching source type/connection and exact course external ID.
2. A configured normalized course-name alias.
3. An allowlisted LLM destination suggestion above `mappingConfidence`.
4. `defaultDestinationKey`, with a warning.

There is no silent fuzzy matching. Labels and LLM project suggestions are restricted to configured allowlists.

Enrichment modes:

- `fallback` (default): use deterministic source fields if OpenAI is absent or fails.
- `required`: report an item error and do not write it if enrichment fails.
- `disabled`: never call OpenAI.

Set `--force-reenrich` to bypass the versioned cache. Cached keys combine a content fingerprint, prompt version, schema version, and model.

## Credentials

### OpenAI

Set `OPENAI_API_KEY`. The app uses the official SDK, Responses API, `store: false`, and strict Structured Outputs. Only title, bounded description, course name, source deadline, and configured allowlists are sent. It does not log prompts or raw student data.

### Canvas

Set an HTTPS `CANVAS_BASE_URL` and a personal `CANVAS_ACCESS_TOKEN`. Tokens are only possible when the institution permits them. A future multi-user OAuth integration may require an institution-approved developer key; the application does not bypass that restriction.

### Google Classroom

Create an OAuth **Desktop app** client in a Google Cloud project with the Classroom API enabled. Save the downloaded JSON at the path in `GOOGLE_CLIENT_SECRET_FILE`, then run:

```bash
npm run cli -- auth classroom
```

The command prints a Google consent URL and listens only on the loopback redirect URI from the client file. It requests these minimum read-only scopes:

- `classroom.courses.readonly`
- `classroom.coursework.me.readonly`

The refresh token is written to the gitignored `GOOGLE_TOKEN_FILE`. A school Workspace administrator may block the app or scopes; if so, the CLI reports the observed restriction and stops. It never requests a school password.

### Todoist

Set `TODOIST_API_TOKEN`. LMS deadlines map to Todoist's date-only `deadline_date`, not Todoist's personal scheduling/due-date fields. The full authoritative timestamp and whether it was source-provided or inferred remain visible in the task description and SQLite audit data.

## Commands

Run safe compatibility checks first:

```bash
npm run check:openai
npm run check:canvas
npm run check:classroom
npm run check:todoist
```

The Todoist check is read-only by default. To explicitly test create → retrieve → update → cleanup with a clearly labeled temporary task:

```bash
npm run check:todoist -- --mutate
```

Exercise the OpenAI/fallback pipeline with synthetic data:

```bash
npm run cli -- enrich-fixture
```

Plan and inspect a sync (the default is always dry-run):

```bash
npm run sync -- --source canvas
npm run sync -- --source classroom --json
npm run sync -- --source all --dry-run
```

Apply the plan generated in the same invocation:

```bash
npm run sync -- --source canvas --apply
npm run sync -- --source all --apply
```

`--apply` and `--dry-run` are mutually exclusive. A plan may read Todoist to verify mappings and markers, but only apply performs writes.

## Safety and synchronization behavior

- Source deadlines always override inferred deadlines. Inferences are accepted only when no source deadline exists and confidence meets the configured threshold.
- The LLM never receives credentials, calls Todoist, chooses arbitrary labels/projects, or determines identity/deduplication.
- Every task description contains a stable machine marker and source link. One marker match can recover a lost local mapping; multiple matches are a conflict. A missing mapped task is also a conflict, never an automatic duplicate create.
- The destination fingerprint covers title, description, destination, labels, and date-only deadline. Local source changes and manual Todoist drift cause an update; unchanged items cause neither an LLM call nor a write.
- A failed write leaves the existing mapping intact for retry.
- Submitted/completed items default to `skip`. Missing LMS items are retained. The app never auto-completes or deletes a Todoist task.
- Todoist request IDs are deterministic per saved plan action for provider-side retry safety.

## Diagnostics

Failures are reported as configuration, credentials, OAuth consent, administrator policy, rate limit, provider outage, malformed data, unsupported behavior, or application errors when the available evidence permits. Output is sanitized and does not print keys or bearer tokens.

The app cannot grant institution permissions. If Canvas personal tokens or Google Classroom scopes are blocked, record the CLI result and ask the appropriate administrator; do not use password-based workarounds.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run cli -- enrich-fixture
```

Tests mock all third-party behavior. Live checks are separate and opt-in.

To add a future source, implement `SourceAdapter`, normalize every record into `ExternalItem`, validate raw provider payloads, and register the adapter in `src/composition.ts`. The sync engine does not need modification. A test-only fake proves this extension path.

## Local data and future deployment

The SQLite file is local and gitignored. Access tokens are not stored in sync tables. Back it up or remove it according to your own privacy needs.

A future scheduler can invoke the same dry-run/apply CLI, but scheduling is intentionally not included. A future multi-user service would require encrypted token storage, per-user connections, OAuth callbacks, tenant isolation, audit controls, and a dedicated security review.

## API references used

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Canvas assignments](https://canvas.instructure.com/doc/api/assignments.html) and [pagination](https://developerdocs.instructure.com/services/canvas/basics/file.pagination)
- [Google Classroom coursework/submissions](https://developers.google.com/workspace/classroom/guides/manage-coursework)
- [Todoist API v1](https://developer.todoist.com/api/v1/)
