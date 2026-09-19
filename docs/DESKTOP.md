# Desktop application guide

Task Sync is a local desktop application for Windows, macOS, and Linux. It reads Canvas assignments, compares them with Todoist, and shows a preview before it writes anything. OpenAI enrichment is optional. Google Classroom is optional and lives under **Settings → Advanced**.

## Install an unsigned build

Download the artifact for your operating system from the repository's GitHub Release.

- **Windows x64:** run the Squirrel installer. Windows SmartScreen may show **Windows protected your PC** because this personal release is unsigned. Verify that the file came from this repository, choose **More info**, then **Run anyway** only if you trust it.
- **macOS Intel or Apple silicon:** open the matching DMG or ZIP. Gatekeeper may block the first launch because the app is not notarized. After verifying the download, control-click the app, choose **Open**, and confirm. Do not disable Gatekeeper globally.
- **Linux x64:** install the DEB with your normal package installer, or extract the ZIP and run `task-sync`. Your desktop environment may ask you to mark the file executable or confirm an untrusted launcher.

The release has no automatic updater. Download a newer artifact manually when a new version is published.

## First launch

Choose one of these paths:

### Start fresh

1. Click **Begin setup**.
2. Paste your Todoist API token, then click **Save and test connection**. Todoist is required because preview reads existing tasks to prevent duplicates.
3. Enter the HTTPS root URL for your school's Canvas site and your Canvas access token. Click **Save and test connection**.
4. Either add and test an OpenAI API key or click **Use deterministic fallback**. Fallback is the recommended starting mode and does not require an OpenAI account.
5. Choose which Canvas courses to include, then map each included course to a Todoist project. Clear **Include in sync** for old, advisory, or otherwise unwanted courses. Turn off **Include assignments without a due date** if those should not appear in previews. Leaving an included course in **Todoist Inbox** is valid.
6. Review the connection summary and click **Preview Canvas sync**.

The token fields are write-only. After saving, the UI reports only whether each credential is configured. A blank edit preserves the current value. Use the separate **Remove** button when you intentionally want to delete one.

### Import an existing CLI setup

On the welcome screen, click **Choose files**. You may select any combination of:

- `.env`
- `task-sync.config.json`
- a `.sqlite` or `.db` database
- a Google Desktop OAuth client JSON
- an existing Google OAuth token JSON

Task Sync validates all selected files first, copies them into desktop-owned storage, and leaves the originals unchanged. If a desktop file already exists, it is backed up before replacement. The CLI and desktop copies are independent after import.

## Preview and apply

Click **Preview Canvas Sync** on the dashboard. Preview may read Canvas and Todoist but performs zero Todoist writes.

The review screen groups rows as:

| Action | Apply behavior |
| --- | --- |
| `create` | Creates a new task after confirmation. |
| `update` | Updates the identified existing task after confirmation. |
| `unchanged` | No write. |
| `skip` | No write. |
| `conflict` | Excluded from apply. Resolve the ambiguity and preview again. |
| `error` | Excluded from apply. Check the expanded reason. |

Expand a row to review its course, Canvas submission status, due date and origin, full Todoist description, source link, warnings, and reason. The Todoist description includes useful Canvas metadata, assignment instructions, and the source link. Canvas deadlines are written as Todoist due dates/datetimes. **Apply safe changes** writes only `create` and `update` rows from that exact saved preview.

A preview expires after 15 minutes, cannot be applied after settings change, and can be attempted only once. If any of those checks fails, create a fresh preview. A partial provider failure is recorded in history; preview again before retrying.

## Recent history

The **Recent history** view shows the latest 20 preview/apply runs. Open a run to inspect per-item outcomes. History is stored in the local SQLite database; the UI limit does not delete older database records.

## Settings

Settings lets you:

- replace or explicitly remove credentials;
- choose System, Light, or Dark appearance;
- choose `fallback`, `required`, or `disabled` enrichment;
- change the OpenAI model, confidence thresholds, allowed labels, completed-item policy, and undated-assignment policy;
- review local configuration, database, and secrets locations;
- enable Google Classroom under **Advanced**.

### Optional Google Classroom setup

1. In Google Cloud, enable the Classroom API and create an OAuth client whose application type is **Desktop app**.
2. In **Settings → Advanced · Google Classroom**, click **Choose OAuth JSON** and select the downloaded file. Task Sync rejects web-client JSON that does not contain an `installed` client.
3. Click **Authorize Google**. Your system browser opens Google's consent page; sign in with the school Google account you want to read.
4. Complete consent and return to Task Sync after the local loopback callback succeeds.

Once authorized, Advanced Settings offers **Preview Classroom** and **Preview Canvas + Classroom**. These still use the same review-before-apply screen.

The Google Cloud project may belong to a personal Google account while the consent flow signs in to a school account. Whether it succeeds still depends on the school's Workspace administrator and OAuth policy. Classroom failures never block Canvas-only use.

## Local data and privacy

Desktop files live in Electron's platform-specific application-data directory under a `Task Sync` folder:

- `settings.env`
- `task-sync.config.json`
- `data/task-sync.sqlite`
- `secrets/`

Provider credentials and OAuth tokens stay in the main process and are never returned to the page UI. Task Sync has no server, background service, scheduler, tray process, telemetry, or automatic synchronization. It runs only while its window is open.

Do not casually delete the SQLite database after applying tasks. It contains deterministic mappings used to avoid duplicates. Back it up only while Task Sync is closed.

## Closing during work

Closing during preview or diagnostics shows a warning. Closing during apply is blocked unless you explicitly choose **Force quit**. Force quitting can leave a partially applied run; reopen the app and create a new preview before doing anything else.

## Developer commands

```bash
npm run ui
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run package:desktop
npm run make:desktop
```

`test:e2e` packages the app with test-only automation fuses and uses synthetic providers. Normal `package:desktop` and `make:desktop` builds disable Electron run-as-Node, `NODE_OPTIONS`, and CLI inspect, enforce ASAR integrity, and load application code only from ASAR.
