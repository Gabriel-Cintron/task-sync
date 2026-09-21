import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { parse } from "dotenv";
import { z } from "zod";
import { AppConfigSchema, loadConfig, saveConfig, type AppConfig } from "../config.js";
import { SqliteSyncRepository } from "../persistence/sqlite-repository.js";
import { AppPathsSchema, ImportRequestSchema, SetupInputSchema, type AppPaths, type CredentialStatus, type ImportRequest, type ImportResult, type SetupInput, type SetupStatus } from "./contracts.js";

const ENV_KEYS = {
  todoistApiToken: "TODOIST_API_TOKEN",
  canvasBaseUrl: "CANVAS_BASE_URL",
  canvasAccessToken: "CANVAS_ACCESS_TOKEN",
  openaiApiKey: "OPENAI_API_KEY",
  googleClientSecretFile: "GOOGLE_CLIENT_SECRET_FILE",
  googleTokenFile: "GOOGLE_TOKEN_FILE",
} as const;

function quoteEnv(value: string): string {
  return `"${value.replaceAll('"', '\\"').replaceAll("\r", "").replaceAll("\n", "\\n")}"`;
}

type FileMutation = { destination: string; backup?: string };

const GoogleClientSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    redirect_uris: z.array(z.string().url()).min(1),
  }).passthrough(),
}).passthrough();

const GoogleTokenSchema = z.object({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
}).passthrough().refine((value) => Boolean(value.access_token || value.refresh_token), "Google OAuth token must contain an access or refresh token");

function safeChmod(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* Windows ACLs do not always expose POSIX modes. */ }
}

function assertFile(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error(`Import file does not exist: ${path}`);
  return resolved;
}

function atomicCopy(source: string, destination: string, backups: string[], mutations: FileMutation[]): void {
  const resolved = resolve(source);
  assertFile(resolved);
  if (resolved === resolve(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });
  let backup: string | undefined;
  if (existsSync(destination)) {
    backup = `${destination}.${Date.now()}.bak`;
    copyFileSync(destination, backup);
    safeChmod(backup, 0o600);
    backups.push(backup);
  }
  const temporary = `${destination}.${process.pid}.tmp`;
  copyFileSync(resolved, temporary);
  renameSync(temporary, destination);
  safeChmod(destination, 0o600);
  mutations.push({ destination, ...(backup ? { backup } : {}) });
}

function activatePreparedFile(prepared: string, destination: string, backups: string[], mutations: FileMutation[]): void {
  let existingBackup: string | undefined;
  if (existsSync(destination)) {
    existingBackup = `${destination}.${Date.now()}.bak`;
    copyFileSync(destination, existingBackup);
    safeChmod(existingBackup, 0o600);
    backups.push(existingBackup);
  }
  mutations.push({ destination, ...(existingBackup ? { backup: existingBackup } : {}) });
  if (existsSync(destination)) unlinkSync(destination);
  renameSync(prepared, destination);
  safeChmod(destination, 0o600);
}

function rollback(mutations: FileMutation[]): void {
  for (const mutation of [...mutations].reverse()) {
    if (mutation.backup) copyFileSync(mutation.backup, mutation.destination);
    else if (existsSync(mutation.destination)) unlinkSync(mutation.destination);
  }
}

export class SettingsStore {
  public readonly paths: AppPaths;

  public constructor(paths: AppPaths) {
    this.paths = AppPathsSchema.parse(paths);
    mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.paths.database), { recursive: true, mode: 0o700 });
    mkdirSync(this.paths.secrets, { recursive: true, mode: 0o700 });
    safeChmod(this.paths.root, 0o700);
    safeChmod(dirname(this.paths.database), 0o700);
    safeChmod(this.paths.secrets, 0o700);
  }

  public environment(): Record<string, string | undefined> {
    return { ...process.env, ...this.fileEnvironment() };
  }

  public config(): AppConfig {
    const parsed = loadConfig(this.paths.config);
    return AppConfigSchema.parse({ ...parsed, databasePath: this.paths.database });
  }

  public status(): SetupStatus {
    const env = this.environment();
    return {
      credentials: this.credentialStatus(env),
      config: this.config(),
      paths: this.paths,
    };
  }

  public save(input: SetupInput): SetupStatus {
    const parsed = SetupInputSchema.parse(input);
    if (parsed.credentials) {
      const env = this.fileEnvironment();
      for (const [field, envKey] of Object.entries(ENV_KEYS) as Array<[keyof typeof ENV_KEYS, string]>) {
        const value = parsed.credentials[field];
        if (value?.trim()) env[envKey] = value.trim();
      }
      this.writeEnvironment(env);
    }
    if (parsed.config) saveConfig(this.paths.config, { ...parsed.config, databasePath: this.paths.database });
    else if (!existsSync(this.paths.config)) saveConfig(this.paths.config, this.config());
    return this.status();
  }

  public removeCredential(provider: "todoist" | "canvas" | "openai" | "classroom"): SetupStatus {
    const env = this.fileEnvironment();
    const keys = provider === "todoist" ? ["TODOIST_API_TOKEN"]
      : provider === "canvas" ? ["CANVAS_BASE_URL", "CANVAS_ACCESS_TOKEN"]
        : provider === "openai" ? ["OPENAI_API_KEY"]
          : ["GOOGLE_CLIENT_SECRET_FILE", "GOOGLE_TOKEN_FILE"];
    for (const key of keys) delete env[key];
    const envBackupPrefix = `${this.paths.env.split(/[\\/]/).pop()}.`;
    for (const name of readdirSync(dirname(this.paths.env))) {
      if (!name.startsWith(envBackupPrefix) || !name.endsWith(".bak")) continue;
      const backupPath = join(dirname(this.paths.env), name);
      const backupEnvironment = parse(readFileSync(backupPath));
      for (const key of keys) delete backupEnvironment[key];
      this.writeEnvironmentFile(backupPath, backupEnvironment);
    }
    if (provider === "classroom") {
      for (const name of readdirSync(this.paths.secrets)) {
        if (!name.startsWith("google-oauth-client.json") && !name.startsWith("google-oauth-token.json")) continue;
        const file = join(this.paths.secrets, name);
        if (statSync(file).isFile()) unlinkSync(file);
      }
    }
    this.writeEnvironment(env);
    return this.status();
  }

  public async importExisting(request: ImportRequest): Promise<ImportResult> {
    const parsed = ImportRequestSchema.parse(request);
    const imported: string[] = [];
    const backups: string[] = [];
    const mutations: FileMutation[] = [];

    // Validate every selected input before changing desktop-owned state.
    const importedEnvironment = parsed.envFile ? parse(readFileSync(assertFile(parsed.envFile))) : undefined;
    if (parsed.configFile) AppConfigSchema.parse(JSON.parse(readFileSync(assertFile(parsed.configFile), "utf8")) as unknown);
    let preparedDatabase: string | undefined;
    if (parsed.databaseFile) {
      const source = assertFile(parsed.databaseFile);
      if (![".sqlite", ".db"].includes(extname(parsed.databaseFile).toLowerCase())) throw new Error("Imported database must be a .sqlite or .db file");
      preparedDatabase = `${this.paths.database}.${process.pid}.import`;
      if (existsSync(preparedDatabase)) unlinkSync(preparedDatabase);
      try {
        const sourceDatabase = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
        try {
          const quickCheck = sourceDatabase.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
          if (quickCheck.length !== 1 || !Object.values(quickCheck[0] ?? {}).includes("ok")) throw new Error("Imported database failed SQLite integrity validation");
          const foreignKeyProblems = sourceDatabase.prepare("PRAGMA foreign_key_check").all();
          if (foreignKeyProblems.length) throw new Error("Imported database has invalid foreign-key references");
          await backup(sourceDatabase, preparedDatabase);
        } finally {
          sourceDatabase.close();
        }
        const repository = new SqliteSyncRepository(preparedDatabase);
        repository.close();
      } catch (error) {
        if (existsSync(preparedDatabase)) unlinkSync(preparedDatabase);
        throw error;
      }
    }
    const importedPath = (value: string | undefined): string | undefined => value
      ? assertFile(isAbsolute(value) || !parsed.envFile ? value : resolve(dirname(parsed.envFile), value))
      : undefined;
    const googleClientSource = importedPath(parsed.googleClientFile ?? importedEnvironment?.GOOGLE_CLIENT_SECRET_FILE);
    const googleTokenSource = importedPath(parsed.googleTokenFile ?? importedEnvironment?.GOOGLE_TOKEN_FILE);
    try {
      if (googleClientSource) GoogleClientSchema.parse(JSON.parse(readFileSync(googleClientSource, "utf8")) as unknown);
      if (googleTokenSource) GoogleTokenSchema.parse(JSON.parse(readFileSync(googleTokenSource, "utf8")) as unknown);
    } catch (error) {
      if (preparedDatabase && existsSync(preparedDatabase)) unlinkSync(preparedDatabase);
      throw error;
    }

    try {
      if (parsed.configFile) {
        atomicCopy(parsed.configFile, this.paths.config, backups, mutations);
        imported.push("configuration");
      }
      if (preparedDatabase) {
        activatePreparedFile(preparedDatabase, this.paths.database, backups, mutations);
        preparedDatabase = undefined;
        imported.push("database");
      }
      const environment = { ...this.fileEnvironment(), ...importedEnvironment };
      delete environment.GOOGLE_CLIENT_SECRET_FILE;
      delete environment.GOOGLE_TOKEN_FILE;
      if (googleClientSource) {
        const destination = join(this.paths.secrets, "google-oauth-client.json");
        atomicCopy(googleClientSource, destination, backups, mutations);
        environment.GOOGLE_CLIENT_SECRET_FILE = destination;
        environment.GOOGLE_TOKEN_FILE = join(this.paths.secrets, "google-oauth-token.json");
        imported.push("google-client");
      }
      if (googleTokenSource) {
        const destination = join(this.paths.secrets, "google-oauth-token.json");
        atomicCopy(googleTokenSource, destination, backups, mutations);
        environment.GOOGLE_TOKEN_FILE = destination;
        imported.push("google-token");
      }
      if (parsed.envFile || googleClientSource || googleTokenSource) {
        this.writeEnvironment(environment, backups, mutations);
        if (parsed.envFile) imported.unshift("environment");
      }
      return { imported, backups };
    } catch (error) {
      if (preparedDatabase && existsSync(preparedDatabase)) unlinkSync(preparedDatabase);
      rollback(mutations);
      throw error;
    }
  }

  private credentialStatus(env: Record<string, string | undefined>): CredentialStatus {
    return {
      todoist: Boolean(env.TODOIST_API_TOKEN),
      canvas: Boolean(env.CANVAS_BASE_URL && env.CANVAS_ACCESS_TOKEN),
      openai: Boolean(env.OPENAI_API_KEY),
      classroom: Boolean(env.GOOGLE_CLIENT_SECRET_FILE && env.GOOGLE_TOKEN_FILE && existsSync(env.GOOGLE_TOKEN_FILE)),
    };
  }

  private fileEnvironment(): Record<string, string | undefined> {
    return existsSync(this.paths.env) ? parse(readFileSync(this.paths.env)) : {};
  }

  private writeEnvironment(values: Record<string, string | undefined>, backups: string[] = [], mutations?: FileMutation[]): void {
    if (mutations && existsSync(this.paths.env)) {
      const backup = `${this.paths.env}.${Date.now()}.bak`;
      copyFileSync(this.paths.env, backup);
      safeChmod(backup, 0o600);
      backups.push(backup);
      mutations.push({ destination: this.paths.env, backup });
    }
    this.writeEnvironmentFile(this.paths.env, values);
    if (mutations && !mutations.some((mutation) => mutation.destination === this.paths.env)) mutations.push({ destination: this.paths.env });
  }

  private writeEnvironmentFile(path: string, values: Record<string, string | undefined>): void {
    const managed = new Set<string>(Object.values(ENV_KEYS));
    const lines = Object.keys(values)
      .filter((key) => managed.has(key) && values[key])
      .sort()
      .map((key) => `${key}=${quoteEnv(values[key]!)}`);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    safeChmod(path, 0o600);
  }
}

export function desktopPaths(root: string): AppPaths {
  const resolved = resolve(root);
  return {
    root: resolved,
    env: join(resolved, "settings.env"),
    config: join(resolved, "task-sync.config.json"),
    database: join(resolved, "data", "task-sync.sqlite"),
    secrets: join(resolved, "secrets"),
  };
}
