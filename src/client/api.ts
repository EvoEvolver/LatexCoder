import { t } from './i18n.ts';
import { apiErrorSchema } from "../shared/api-schema.ts";

const errorMessages: Record<string, string> = {
  authentication_required: "Sign in to continue.",
  unauthenticated: "Sign in to continue.",
  unauthorized: "Sign in to continue.",
  forbidden: "You do not have permission to perform this action.",
  invalid_credentials: "Incorrect username or password.",
  stale_file: "The file changed. Refresh it before trying again.",
  invalid_password: "Enter a password between 10 and 256 characters.",
  invalid_username: "Enter a valid username.",
  invalid_display_name: "Enter a display name between 1 and 28 characters.",
  file_too_large: "The file is too large.",
  file_not_found: "Project file not found",
  review_conflict: "This action overlaps an open review. Resolve it before trying again.",
  invalid_ssh_key: "Enter a valid SSH public key.",
};

export const apiUrl = (relative: string): URL => new URL(`/${relative.replace(/^\//, "")}`, window.location.origin);

export function socketUrl(relative: string): string {
  const url = apiUrl(relative);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

export function createApiClient(currentProjectId: () => string) {
  async function request<T = unknown>(relative: string, options: RequestInit = {}): Promise<T> {
    const url = apiUrl(relative);
    if (currentProjectId() && url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/v1/projects")) {
      url.searchParams.set("project", currentProjectId());
    }
    const response = await fetch(url, options);
    const type = response.headers.get("content-type") || "";
    const body: unknown = type.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(body);
      const originalMessage = parsed.success ? parsed.data.error.message : typeof body === "string" ? body : `Request failed (${response.status})`;
      const code = parsed.success ? parsed.data.error.code : "request_failed";
      const error = Object.assign(new Error(originalMessage), {
        code, status: response.status, originalMessage,
        details: parsed.success ? parsed.data.error.details : undefined,
      });
      Object.defineProperty(error, "message", { get: () => errorMessages[code] ? t(errorMessages[code]) : originalMessage });
      throw error;
    }
    return body as T;
  }

  function projectApiUrl(relative: string): URL {
    const url = apiUrl(relative);
    if (currentProjectId()) url.searchParams.set("project", currentProjectId());
    return url;
  }

  return { request, projectApiUrl };
}
