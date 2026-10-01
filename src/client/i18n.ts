import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import ja from "./locales/ja.json";

export type LanguagePreference = "system" | "en" | "zh-CN" | "ja";
const storageKey = "latexcoder-language";
let sessionPreference: LanguagePreference | undefined;
export const i18n = i18next.createInstance();

export function resolveLanguage(preference: LanguagePreference, languages: readonly string[]): Exclude<LanguagePreference, "system"> {
  if (preference !== "system") return preference;
  for (const language of languages) {
    if (/^zh(?:$|-(?:CN|SG|Hans)(?:-|$))/i.test(language)) return "zh-CN";
    if (/^ja(?:-|$)/i.test(language)) return "ja";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return "en";
}

export function languagePreference(): LanguagePreference {
  if (sessionPreference) return sessionPreference;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "en" || stored === "zh-CN" || stored === "ja") return stored;
  } catch { /* The app also works when browser storage is unavailable. */ }
  return "system";
}

export async function initializeLanguage(): Promise<void> {
  await i18n.use(initReactI18next).init({
    lng: resolveLanguage(languagePreference(), navigator.languages),
    fallbackLng: "en",
    supportedLngs: ["en", "zh-CN", "ja"],
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    resources: {
      en: { translation: {
        ...Object.fromEntries(Object.keys(zhCN).map(key => [key, key])),
        pages_one: "{{count}} page", pages_other: "{{count}} pages",
        versions_one: "{{count}} version", versions_other: "{{count}} versions",
        matches_one: "{{count}} match", matches_other: "{{count}} matches",
        errors_one: "{{count}} error", errors_other: "{{count}} errors",
        warnings_one: "{{count}} warning", warnings_other: "{{count}} warnings",
        users_one: "{{count}} user", users_other: "{{count}} users",
        projects_one: "{{count}} project", projects_other: "{{count}} projects",
        comments_one: "{{name}} commented · {{count}} message",
        comments_other: "{{name}} commented · {{count}} messages",
      } },
      "zh-CN": { translation: zhCN },
      ja: { translation: ja },
    },
  });
  document.documentElement.lang = i18n.resolvedLanguage || "en";
  i18n.on("languageChanged", () => {
    document.documentElement.lang = i18n.resolvedLanguage || "en";
    refreshLocalizedDom();
  });
  window.addEventListener("languagechange", () => {
    if (languagePreference() === "system") void applyLanguage("system");
  });
  window.addEventListener("storage", event => {
    if (event.key === storageKey || event.key === null) { sessionPreference = undefined; void applyLanguage(languagePreference()); }
  });
}

async function applyLanguage(preference: LanguagePreference): Promise<void> {
  await i18n.changeLanguage(resolveLanguage(preference, navigator.languages));
  window.dispatchEvent(new Event("latexcoder-language-change"));
}

export async function setLanguagePreference(preference: LanguagePreference): Promise<void> {
  sessionPreference = preference;
  try { localStorage.setItem(storageKey, preference); } catch { /* Session-only preference. */ }
  await applyLanguage(preference);
}

// English messages are stable catalog keys. Dynamic values are interpolated,
// never looked up as translation keys (file names and user text stay intact).
export function t(message: string, values?: Record<string, unknown>): string {
  return String(i18n.t(message, { ...values, defaultValue: message }));
}

export function formatDate(value: string | number | Date, dateOnly = false): string {
  const date = new Date(value);
  return dateOnly ? date.toLocaleDateString(i18n.resolvedLanguage) : date.toLocaleString(i18n.resolvedLanguage);
}

type Binding = () => boolean;
const bindings = new WeakMap<Node, Map<string, Binding>>();
const targets = new Set<WeakRef<Node>>();

function bind(node: Node, property: string, update: Binding): void {
  let properties = bindings.get(node);
  if (!properties) {
    properties = new Map();
    bindings.set(node, properties);
    targets.add(new WeakRef(node));
  }
  properties.set(property, update);
}

function refreshLocalizedDom(): void {
  for (const reference of targets) {
    const node = reference.deref();
    if (!node) { targets.delete(reference); continue; }
    const properties = bindings.get(node)!;
    for (const [property, update] of properties) if (!update()) properties.delete(property);
    if (!properties.size) { bindings.delete(node); targets.delete(reference); }
  }
}

// Only update the text node we created. A later controller write takes ownership
// away; appended controls and editor DOM must never be replaced during a switch.
export function localizedText(node: Node, render: () => string | null): void {
  node.textContent = render();
  const text = node.firstChild || node.appendChild(document.createTextNode(""));
  bind(node, "textContent", () => {
    if (text.parentNode !== node) return false;
    text.textContent = render();
    return true;
  });
}

export function localizedAttribute(node: Element, name: string, render: () => string): void {
  node.setAttribute(name, render());
  bind(node, name, () => {
    node.setAttribute(name, render());
    return true;
  });
}

let refreshQueued = false;
export function scheduleLocalizedDomRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => { refreshQueued = false; refreshLocalizedDom(); });
}

export function localizedDocumentTitle(render: () => string): void {
  document.title = render();
  let previous = document.title;
  bind(document, "title", () => {
    if (document.title !== previous) return false;
    previous = render();
    document.title = previous;
    return true;
  });
}
