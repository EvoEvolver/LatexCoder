export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "latexcoder-theme";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

export function themePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function applyTheme(preference = themePreference()): void {
  const dark = preference === "dark" || (preference === "system" && systemTheme.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = preference;
}

export function setThemePreference(preference: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, preference);
  applyTheme(preference);
  window.dispatchEvent(new CustomEvent("latexcoder-theme-change", { detail: preference }));
}

export function initializeTheme(): void {
  applyTheme();
  systemTheme.addEventListener("change", () => {
    if (themePreference() === "system") applyTheme("system");
  });
}
