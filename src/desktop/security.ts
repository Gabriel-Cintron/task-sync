export function isTrustedRendererUrl(url: string | undefined, developmentUrl?: string): boolean {
  if (!url) return false;
  if (url.startsWith("task-sync://app/")) return true;
  if (!developmentUrl) return false;
  try {
    return new URL(url).origin === new URL(developmentUrl).origin;
  } catch {
    return false;
  }
}

export function isAllowedExternalUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
