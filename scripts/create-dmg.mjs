import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import packageJson from "../package.json" with { type: "json" };

if (process.platform !== "darwin") {
  throw new Error("DMG creation is supported only on macOS");
}

const arch = process.argv[2] ?? process.arch;
if (!new Set(["x64", "arm64"]).has(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);

const packageDirectory = resolve("desktop-out", `Task Sync-darwin-${arch}`);
const outputDirectory = resolve("desktop-out", "make", "dmg", "darwin", arch);
const output = join(outputDirectory, `Task-Sync-darwin-${arch}-${packageJson.version}.dmg`);
mkdirSync(outputDirectory, { recursive: true });

const result = spawnSync("hdiutil", [
  "create",
  "-volname", "Task Sync",
  "-srcfolder", packageDirectory,
  "-ov",
  "-format", "UDZO",
  output,
], { stdio: "inherit" });

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`hdiutil failed with exit code ${result.status ?? "unknown"}`);
