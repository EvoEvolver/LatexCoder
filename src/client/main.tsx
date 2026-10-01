import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AppShell } from "@/App";
import { initializeTheme } from "@/theme";
import { initializeLanguage } from "@/i18n";
import "@/index.css";

initializeTheme();

const root = document.getElementById("root");
if (!root) throw new Error("missing application root");

void initializeLanguage().then(() => {
  flushSync(() => createRoot(root).render(<AppShell />));
  void import("@/controller");
});
