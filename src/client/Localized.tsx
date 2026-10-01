import { cloneElement, useEffect, useLayoutEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { languagePreference, scheduleLocalizedDomRefresh, setLanguagePreference, type LanguagePreference } from "./i18n";

/** Keep translation subscriptions in leaves: the controller owns the shell DOM. */
export function Message({ id }: { id: string }) {
  const { t } = useTranslation();
  return <>{t(id)}</>;
}

export function Localized({ children, text, ...messages }: { children: ReactElement; text?: string; title?: string; placeholder?: string; "aria-label"?: string; label?: string }) {
  const { t } = useTranslation();
  // Controller-owned attributes take precedence over scaffold defaults.
  useLayoutEffect(scheduleLocalizedDomRefresh);
  const props = Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, t(value)]));
  return text ? cloneElement(children, props, t(text)) : cloneElement(children, props);
}

export function LanguageSelector({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const [preference, setPreference] = useState(languagePreference);
  useEffect(() => {
    const update = () => setPreference(languagePreference());
    window.addEventListener("latexcoder-language-change", update);
    return () => window.removeEventListener("latexcoder-language-change", update);
  }, []);
  return <label className={`inline-flex items-center gap-2 text-xs ${compact ? "" : "w-full justify-between"}`}>
    {!compact && <span>{t("Language")}</span>}
    <select data-language-select aria-label={t("Language")} value={preference}
      className={`h-7 rounded border bg-background px-1 text-xs text-foreground ${compact ? "w-16" : "max-w-36"}`}
      onChange={event => { const value = event.target.value as LanguagePreference; setPreference(value); void setLanguagePreference(value); }}>
      <option value="system">{t(compact ? "Auto" : "Follow browser")}</option>
      <option value="en">{compact ? "EN" : "English"}</option>
      <option value="zh-CN">{compact ? "中文" : "简体中文"}</option>
      <option value="ja">日本語</option>
    </select>
  </label>;
}
