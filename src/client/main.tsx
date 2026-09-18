import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AppShell } from "@/App";
import { initializeTheme } from "@/theme";
import "@/index.css";

initializeTheme();

const root = document.getElementById("root");
if (!root) throw new Error("missing application root");

flushSync(() => createRoot(root).render(<AppShell />));
void import("@/controller");
