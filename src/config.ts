import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const DestinationSchema = z.object({
  projectId: z.string().min(1).optional(),
  sectionId: z.string().min(1).optional(),
}).strict();

export const CourseMappingSchema = z.object({
  sourceType: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  courseExternalId: z.string().min(1).optional(),
  courseAlias: z.string().min(1).transform((value) => value.toLowerCase()).optional(),
  destinationKey: z.string().min(1),
  enabled: z.boolean().default(true),
}).strict().refine((value) => value.courseExternalId ?? value.courseAlias, {
  message: "A course mapping needs courseExternalId or courseAlias",
});

export const AppConfigSchema = z.object({
  databasePath: z.string().min(1).default("./data/task-sync.sqlite"),
  enrichment: z.object({
    mode: z.enum(["required", "fallback", "disabled"]).default("fallback"),
    model: z.string().min(1).default("gpt-4.1-mini"),
    inferredDueConfidence: z.number().min(0).max(1).default(0.85),
    mappingConfidence: z.number().min(0).max(1).default(0.8),
    maxDescriptionCharacters: z.number().int().positive().max(50000).default(8000),
    allowedLabels: z.array(z.string()).default([]),
  }).strict().default({}),
  sync: z.object({
    completedSourceItems: z.enum(["skip", "include"]).default("skip"),
    undatedSourceItems: z.enum(["skip", "include"]).default("include"),
    missingSourceItems: z.literal("retain").default("retain"),
  }).strict().default({}),
  appearance: z.object({
    theme: z.enum(["system", "light", "dark"]).default("system"),
  }).strict().default({}),
  destinations: z.record(DestinationSchema).default({ inbox: {} }),
  defaultDestinationKey: z.string().min(1).default("inbox"),
  courseMappings: z.array(CourseMappingSchema).default([]),
  sources: z.object({
    canvas: z.object({ connectionId: z.string().min(1).default("canvas") }).strict().default({}),
    googleClassroom: z.object({ connectionId: z.string().min(1).default("google-classroom") }).strict().default({}),
  }).strict().default({}),
}).strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type DestinationConfig = z.infer<typeof DestinationSchema>;
export type CourseMappingConfig = z.infer<typeof CourseMappingSchema>;

export function loadConfig(path = process.env.TASK_SYNC_CONFIG ?? "./task-sync.config.json"): AppConfig {
  let input: unknown = {};
  try {
    input = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parsed = AppConfigSchema.parse(input);
  return {
    ...parsed,
    databasePath: process.env.TASK_SYNC_DB ?? parsed.databasePath,
    enrichment: {
      ...parsed.enrichment,
      model: process.env.OPENAI_MODEL ?? parsed.enrichment.model,
    },
  };
}

export function saveConfig(path: string, value: unknown): AppConfig {
  const parsed = AppConfigSchema.parse(value);
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
  return parsed;
}
