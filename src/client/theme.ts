export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "latexcoder-theme";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

export function themePreference(): ThemePreference {
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORAGE_KEY) || JSON.parse(localStorage.getItem("paper-preferences") || "{}").theme; } catch {}
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function applyTheme(preference = themePreference()): void {
  const dark = preference === "dark" || (preference === "system" && systemTheme.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function setThemePreference(preference: ThemePreference): void {
  try { localStorage.setItem(STORAGE_KEY, preference); } catch {}
  applyTheme(preference);
  window.dispatchEvent(new CustomEvent("latexcoder-theme-change", { detail: preference }));
}

export function initializeTheme(): void {
  applyTheme();
  systemTheme.addEventListener("change", () => {
    if (themePreference() === "system") applyTheme("system");
  });
}
