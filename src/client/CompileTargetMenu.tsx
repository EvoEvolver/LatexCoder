import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { CompileMode } from "../shared/compile-directives";
import { Message } from "./Localized";
import { scheduleLocalizedDomRefresh } from "./i18n";
import { Button } from "./components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";

export function CompileTargetMenu() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<CompileMode>("project");
  useLayoutEffect(scheduleLocalizedDomRefresh);
  useEffect(() => {
    const sync = (event: Event) => setMode((event as CustomEvent<CompileMode>).detail);
    window.addEventListener("latexcoder-compile-mode-change", sync);
    return () => window.removeEventListener("latexcoder-compile-mode-change", sync);
  }, []);
  const select = (value: CompileMode) => {
    setMode(value);
    // onSelect also runs when selecting the current mode, so chapter help can
    // be reopened after changing files without toggling to project first.
    window.dispatchEvent(new CustomEvent("latexcoder-select-compile-mode", { detail: value }));
  };
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <Button id="compile-mode" data-compile-mode={mode} type="button" size="sm"
        className="h-8 w-7 shrink-0 rounded-l-none border-l border-primary-foreground/25 px-0 shadow-none"
        aria-label={t("Compile target")} title={t("Compile target")}><ChevronDown aria-hidden="true" className="size-3.5" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuRadioGroup value={mode}>
        <DropdownMenuRadioItem id="compile-mode-project" value="project" onSelect={() => select("project")}><Message id="Top-level root" /></DropdownMenuRadioItem>
        <DropdownMenuRadioItem id="compile-mode-chapter" value="chapter" onSelect={() => select("chapter")}><Message id="Chapter root" /></DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
