import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AppShell } from "@/App";
import "@/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing application root");

flushSync(() => createRoot(root).render(<AppShell />));
void import("@/controller");
