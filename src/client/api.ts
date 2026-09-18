import { apiErrorSchema } from "../shared/api-schema.ts";

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
      throw Object.assign(
        new Error(parsed.success ? parsed.data.error.message : typeof body === "string" ? body : `Request failed (${response.status})`),
        { code: parsed.success ? parsed.data.error.code : "request_failed", status: response.status },
      );
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
