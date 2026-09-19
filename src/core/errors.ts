export type FailureCategory =
  | "configuration"
  | "credentials"
  | "oauth_consent"
  | "admin_policy"
  | "rate_limit"
  | "provider_outage"
  | "malformed_data"
  | "unsupported"
  | "application";

export class ProviderError extends Error {
  public constructor(
    public readonly category: FailureCategory,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) return `${error.category}: ${error.message}`;
  if (error instanceof Error) {
    const record = error as Error & { status?: unknown; code?: unknown };
    const rawStatus = typeof record.status === "number" ? record.status : record.code;
    const status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
    const message = error.message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    if (status === 401) return `credentials: ${message}`;
    if (status === 403 && /admin|policy|blocked|restricted/i.test(message)) return `admin_policy: ${message}`;
    if (status === 403) return `oauth_consent: ${message}`;
    if (status === 429) return `rate_limit: ${message}`;
    if (status >= 500) return `provider_outage: ${message}`;
    return `application: ${message}`;
  }
  return "Unknown error";
}

export function classifyHttpFailure(provider: string, status: number, body = ""): ProviderError {
  const normalized = body.toLowerCase();
  if (status === 401) return new ProviderError("credentials", `${provider} rejected the configured credentials`, status);
  if (status === 403 && /admin|policy|blocked|restricted|access_denied/.test(normalized)) {
    return new ProviderError("admin_policy", `${provider} access is restricted by an administrator or policy`, status);
  }
  if (status === 403) return new ProviderError("oauth_consent", `${provider} denied the requested permission`, status);
  if (status === 429) return new ProviderError("rate_limit", `${provider} rate limit reached`, status);
  if (status >= 500) return new ProviderError("provider_outage", `${provider} returned HTTP ${status}`, status);
  return new ProviderError("unsupported", `${provider} returned HTTP ${status}`, status);
}
