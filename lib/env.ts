type RequiredEnvKey =
  | "GOOGLE_CLIENT_EMAIL"
  | "GOOGLE_PRIVATE_KEY"
  | "GOOGLE_CALENDAR_ID"
  | "TWILIO_ACCOUNT_SID"
  | "TWILIO_AUTH_TOKEN"
  | "TWILIO_WHATSAPP_FROM";

export function requireEnv(key: RequiredEnvKey) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return value;
}

export function getGooglePrivateKey() {
  return requireEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");
}

function normalizeBaseUrl(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/+$/, "");
  }

  return `https://${trimmed.replace(/\/+$/, "")}`;
}

export function isDemoStateless() {
  return process.env.DEMO_STATELESS?.trim().toLowerCase() === "true";
}

export function getConfiguredAppBaseUrl() {
  return (
    normalizeBaseUrl(process.env.APP_BASE_URL) ||
    normalizeBaseUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) ||
    normalizeBaseUrl(process.env.VERCEL_BRANCH_URL) ||
    normalizeBaseUrl(process.env.VERCEL_URL)
  );
}

export function getRequestBaseUrl(request?: Request) {
  if (!request) {
    return "";
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  if (forwardedHost) {
    const forwardedProto = request.headers.get("x-forwarded-proto")?.trim() || "https";
    return normalizeBaseUrl(`${forwardedProto}://${forwardedHost}`);
  }

  try {
    return normalizeBaseUrl(new URL(request.url).origin);
  } catch {
    return "";
  }
}

export function resolveAppBaseUrl(request?: Request) {
  return getConfiguredAppBaseUrl() || getRequestBaseUrl(request);
}

export function buildPublicUrl(pathname: string, request?: Request) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const baseUrl = resolveAppBaseUrl(request);
  return baseUrl ? `${baseUrl}${normalizedPath}` : normalizedPath;
}

export function getRuntimeEnvDiagnostics() {
  return {
    GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL ? "present" : "missing",
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? "present" : "missing",
    GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID ? "present" : "missing",
    APP_BASE_URL: getConfiguredAppBaseUrl() ? "present" : "missing",
    DEMO_STATELESS: isDemoStateless() ? "true" : "false",
    VERCEL_URL: process.env.VERCEL_URL ? "present" : "missing",
    cwd: process.cwd()
  } as const;
}

export function logRuntimeEnvDiagnostics(context: string) {
  console.info(`[env-diagnostic:${context}]`, getRuntimeEnvDiagnostics());
}
