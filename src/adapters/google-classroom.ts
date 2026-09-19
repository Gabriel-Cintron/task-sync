import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { URL } from "node:url";
import { google } from "googleapis";
import { z } from "zod";
import { ProviderError } from "../core/errors.js";
import { externalItemFingerprint } from "../core/hash.js";
import { ExternalItemSchema, type ExternalItem } from "../core/models.js";
import type { DiagnosticReport, SourceAdapter } from "../core/ports.js";

export const CLASSROOM_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
];

const ClientSecretSchema = z.object({
  installed: z.object({
    client_id: z.string(),
    client_secret: z.string(),
    redirect_uris: z.array(z.string()).min(1),
  }),
});

const CourseSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
const CourseWorkSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  alternateLink: z.string().url().nullish(),
  updateTime: z.string().datetime({ offset: true }).nullish(),
  dueDate: z.object({ year: z.number(), month: z.number(), day: z.number() }).nullish(),
  dueTime: z.object({ hours: z.number().optional(), minutes: z.number().optional(), seconds: z.number().optional() }).nullish(),
}).passthrough();
const SubmissionSchema = z.object({ courseWorkId: z.string().optional(), state: z.string().optional() }).passthrough();

type OAuthClient = InstanceType<typeof google.auth.OAuth2>;

function dueAt(work: z.infer<typeof CourseWorkSchema>): { dueAt?: string; duePrecision?: "date" | "datetime" } {
  if (!work.dueDate) return {};
  const { year, month, day } = work.dueDate;
  const hours = work.dueTime?.hours ?? 23;
  const minutes = work.dueTime?.minutes ?? 59;
  const seconds = work.dueTime ? (work.dueTime.seconds ?? 0) : 59;
  return {
    dueAt: new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds)).toISOString(),
    duePrecision: work.dueTime ? "datetime" : "date",
  };
}

function submissionStatus(state: string | undefined): ExternalItem["status"] {
  if (state === "TURNED_IN") return "submitted";
  if (state === "RETURNED") return "completed";
  if (state === "CREATED" || state === "RECLAIMED_BY_STUDENT") return "open";
  return "unknown";
}

export function normalizeClassroomCourseWork(
  courseInput: unknown,
  courseWorkInput: unknown,
  submissionInput: unknown,
  connectionId: string,
): ExternalItem {
  const course = CourseSchema.parse(courseInput);
  const work = CourseWorkSchema.parse(courseWorkInput);
  const submission = submissionInput ? SubmissionSchema.parse(submissionInput) : undefined;
  const deadline = dueAt(work);
  const base = {
    ref: { sourceType: "google_classroom", connectionId, externalId: work.id },
    kind: "assignment" as const,
    course: { externalId: course.id, name: course.name },
    title: work.title,
    ...(work.description ? { description: work.description } : {}),
    ...deadline,
    ...(work.alternateLink ? { sourceUrl: work.alternateLink } : {}),
    status: submissionStatus(submission?.state),
    ...(work.updateTime ? { sourceUpdatedAt: work.updateTime } : {}),
    providerMetadata: { classroomSubmissionState: submission?.state ?? null },
  };
  return ExternalItemSchema.parse({ ...base, rawFingerprint: externalItemFingerprint(base) });
}

export class GoogleClassroomAdapter implements SourceAdapter {
  public readonly sourceType = "google_classroom";

  public constructor(
    public readonly connectionId: string,
    private readonly clientSecretFile: string,
    private readonly tokenFile: string,
  ) {}

  public async authorize(options: { onAuthorizationUrl?: (url: string) => void } = {}): Promise<void> {
    const { client, redirectUri } = this.createClient();
    const authUrl = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: CLASSROOM_SCOPES });
    if (options.onAuthorizationUrl) options.onAuthorizationUrl(authUrl);
    else process.stdout.write(`Open this URL to authorize Google Classroom:\n${authUrl}\n`);
    const code = await new Promise<string>((resolve, reject) => {
      const redirect = new URL(redirectUri);
      const server = createServer((request, response) => {
        const requestUrl = new URL(request.url ?? "/", redirectUri);
        const codeValue = requestUrl.searchParams.get("code");
        const error = requestUrl.searchParams.get("error");
        if (error || !codeValue) {
          response.writeHead(400).end("Authorization failed. Return to the terminal.");
          clearTimeout(timeout);
          server.close();
          reject(new ProviderError(error === "access_denied" ? "oauth_consent" : "application", error ?? "OAuth callback had no code"));
          return;
        }
        response.writeHead(200, { "Content-Type": "text/plain" }).end("Authorization complete. You can close this tab.");
        clearTimeout(timeout);
        server.close();
        resolve(codeValue);
      });
      const timeout = setTimeout(() => {
        server.close();
        reject(new ProviderError("oauth_consent", "Google authorization timed out"));
      }, 180_000).unref();
      server.on("error", reject);
      server.listen(Number(redirect.port), redirect.hostname);
    });
    const { tokens } = await client.getToken(code);
    mkdirSync(dirname(this.tokenFile), { recursive: true });
    const temporary = `${this.tokenFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    renameSync(temporary, this.tokenFile);
    chmodSync(this.tokenFile, 0o600);
  }

  public async listItems(): Promise<ExternalItem[]> {
    const classroom = google.classroom({ version: "v1", auth: this.authenticatedClient() });
    const courses = await this.listCourses(classroom);
    const result: ExternalItem[] = [];
    for (const course of courses) {
      const courseWork = await this.listCourseWork(classroom, course.id);
      const submissions = await this.listSubmissions(classroom, course.id);
      const byCourseWork = new Map(submissions.map((value) => [value.courseWorkId, value]));
      for (const work of courseWork) {
        result.push(normalizeClassroomCourseWork(course, work, byCourseWork.get(work.id), this.connectionId));
      }
    }
    return result;
  }

  public async diagnose(): Promise<DiagnosticReport> {
    const classroom = google.classroom({ version: "v1", auth: this.authenticatedClient() });
    const courses = await this.listCourses(classroom);
    let workCount = 0;
    let submissionCount = 0;
    for (const course of courses.slice(0, 5)) {
      workCount += (await this.listCourseWork(classroom, course.id)).length;
      submissionCount += (await this.listSubmissions(classroom, course.id)).length;
    }
    return {
      provider: "Google Classroom",
      ok: true,
      checks: [
        { name: "authentication", ok: true, detail: "OAuth token accepted" },
        { name: "active courses", ok: true, detail: `${courses.length} active course(s) visible` },
        { name: "coursework", ok: true, detail: `${workCount} sampled coursework item(s)` },
        { name: "own submissions", ok: true, detail: `${submissionCount} sampled submission record(s) accessible` },
      ],
    };
  }

  private createClient(): { client: OAuthClient; redirectUri: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.clientSecretFile, "utf8")) as unknown;
    } catch (error) {
      throw new ProviderError("configuration", `Cannot read Google OAuth client file: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const secret = ClientSecretSchema.parse(raw).installed;
    const redirectUri = "http://127.0.0.1:53682/oauth2callback";
    return { client: new google.auth.OAuth2(secret.client_id, secret.client_secret, redirectUri), redirectUri };
  }

  private authenticatedClient(): OAuthClient {
    const { client } = this.createClient();
    try {
      client.setCredentials(JSON.parse(readFileSync(this.tokenFile, "utf8")) as Record<string, unknown>);
    } catch {
      throw new ProviderError("configuration", `Google OAuth token not found. Run: npm run cli -- auth classroom`);
    }
    return client;
  }

  private async listCourses(classroom: ReturnType<typeof google.classroom>): Promise<Array<z.infer<typeof CourseSchema>>> {
    const all: Array<z.infer<typeof CourseSchema>> = [];
    let pageToken: string | undefined;
    do {
      const response = await classroom.courses.list({ courseStates: ["ACTIVE"], pageSize: 100, ...(pageToken ? { pageToken } : {}) });
      all.push(...z.array(CourseSchema).parse(response.data.courses ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return all;
  }

  private async listCourseWork(classroom: ReturnType<typeof google.classroom>, courseId: string): Promise<Array<z.infer<typeof CourseWorkSchema>>> {
    const all: Array<z.infer<typeof CourseWorkSchema>> = [];
    let pageToken: string | undefined;
    do {
      const response = await classroom.courses.courseWork.list({ courseId, courseWorkStates: ["PUBLISHED"], pageSize: 100, ...(pageToken ? { pageToken } : {}) });
      all.push(...z.array(CourseWorkSchema).parse(response.data.courseWork ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return all;
  }

  private async listSubmissions(classroom: ReturnType<typeof google.classroom>, courseId: string): Promise<Array<z.infer<typeof SubmissionSchema>>> {
    const all: Array<z.infer<typeof SubmissionSchema>> = [];
    let pageToken: string | undefined;
    do {
      const response = await classroom.courses.courseWork.studentSubmissions.list({
        courseId,
        courseWorkId: "-",
        userId: "me",
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      });
      all.push(...z.array(SubmissionSchema).parse(response.data.studentSubmissions ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return all;
  }
}
