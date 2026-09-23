/// <reference lib="dom" />

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { chromium, type Page } from "playwright";

import { createPaperServer } from "../src/server/main.ts";

const execute = promisify(execFile);
const outputDir = path.resolve("docs/videos");
const mp4Output = path.join(outputDir, "latexcoder-feature-tour.mp4");

const mainSource = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue]{hyperref}

\title{Collaborative Scientific Writing}
\author{Alex Chen \and Maya Patel}
\date{September 2026}

\begin{document}
\maketitle

\begin{abstract}
We study how researchers can work together on scientific manuscripts while
preserving clear ownership of edits and reproducible source files.
\end{abstract}

\section{Introduction}
Scientific writing is an iterative process. Ideas, experiments, and explanations
evolve together as a team develops a shared account of its results.

A collaborative editor should keep \cmtbg{claim}{Alex}review metadata\cmted{Can we make this claim more specific?}
visible to people and tools. Checked edits make the workflow
\addbg{revision}{Maya}auditable and reproducible\added.

\input{sections/method}

\section{Results}\label{sec:results}
Every project remains an ordinary Git repository while browser edits synchronize
through a shared document. The workflow supports interactive writing and local tools.

\section{Next steps}
We will evaluate the workflow on longer multi-author papers. The editing protocol
is summarized in Section~\ref{sec:method}.

\end{document}
`;

const methodSource = String.raw`\section{Method}\label{sec:method}
Each checked upload includes the hash of the source it downloaded. The server
rejects stale changes and applies accepted edits to the live document.
`;

const references = String.raw`@article{collaboration2026,
  title = {Collaborative Scientific Writing with Auditable Tools},
  author = {Chen, Alex and Patel, Maya},
  journal = {Journal of Open Research},
  year = {2026}
}
`;

const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

async function caption(page: Page, eyebrow: string, title: string, detail: string, duration = 3200): Promise<void> {
  await page.evaluate(({ eyebrow, title, detail }) => {
    document.getElementById("demo-caption")?.remove();
    const panel = document.createElement("div");
    panel.id = "demo-caption";
    panel.innerHTML = `<small></small><strong></strong><p></p>`;
    panel.querySelector("small")!.textContent = eyebrow;
    panel.querySelector("strong")!.textContent = title;
    panel.querySelector("p")!.textContent = detail;
    document.body.append(panel);
    requestAnimationFrame(() => panel.classList.add("visible"));
  }, { eyebrow, title, detail });
  await wait(duration);
  await page.evaluate(() => document.getElementById("demo-caption")?.classList.remove("visible"));
  await wait(350);
}

async function splash(page: Page, closing = false): Promise<void> {
  await page.evaluate(closing => {
    document.getElementById("demo-splash")?.remove();
    const logo = document.querySelector<HTMLImageElement>(".brand img, #editor-about img")?.src || "";
    const panel = document.createElement("div");
    panel.id = "demo-splash";
    panel.innerHTML = closing
      ? `<img alt=""><h1>Write together. Own the source.</h1><p>github.com/EvoEvolver/LatexCoder</p>`
      : `<img alt=""><h1>LaTeX Coder</h1><p>Collaborative LaTeX, self-hosted.</p>`;
    panel.querySelector("img")!.setAttribute("src", logo);
    document.body.append(panel);
    requestAnimationFrame(() => panel.classList.add("visible"));
  }, closing);
  await wait(closing ? 3800 : 3000);
  if (!closing) {
    await page.evaluate(() => document.getElementById("demo-splash")?.classList.remove("visible"));
    await wait(500);
  }
}

async function api(base: string, pathname: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${base}${pathname}`, init);
  if (!response.ok) throw new Error(`${init?.method || "GET"} ${pathname}: ${response.status} ${await response.text()}`);
  return response;
}

async function main(): Promise<void> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-demo-"));
  const recordingDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-video-"));
  const compiler = ["/Library/TeX/texbin/latexmk", "/usr/bin/latexmk", "/usr/local/bin/tectonic"].find(existsSync);
  const paper = await createPaperServer({ stateDir, authDisabled: true, compiler });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      paper.server.once("error", reject);
      paper.server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(paper.server.address() as AddressInfo).port}`;
    const projects = await api(base, "/v1/projects").then(response => response.json() as Promise<{ projects: Array<{ id: string }> }>);
    const project = projects.projects[0];
    if (!project) throw new Error("Default project was not created");
    const json = { "Content-Type": "application/json" };
    await api(base, `/v1/projects/${project.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "Collaborative Research Notes" }) });
    await api(base, `/v1/projects/${project.id}/tags`, { method: "PATCH", headers: json, body: JSON.stringify({ tags: ["Research", "Draft"] }) });
    for (const [name, tags] of [["Catalyst screening", ["Chemistry", "Methods"]], ["Quantum control review", ["Review", "Physics"]]] as const) {
      const created = await api(base, "/v1/projects", { method: "POST", headers: json, body: JSON.stringify({ name }) }).then(response => response.json() as Promise<{ project: { id: string } }>);
      await api(base, `/v1/projects/${created.project.id}/tags`, { method: "PATCH", headers: json, body: JSON.stringify({ tags }) });
    }
    const projectQuery = new URLSearchParams({ project: project.id });
    const upload = (filePath: string, source: string): Promise<Response> => {
      const query = new URLSearchParams(projectQuery);
      query.set("path", filePath);
      return api(base, `/v1/files?${query}`, { method: "PUT", body: source });
    };
    await upload("main.tex", mainSource);
    await upload("sections/method.tex", methodSource);
    await upload("references.bib", references);
    await api(base, `/v1/git/commit?${projectQuery}`, { method: "POST", headers: json, body: JSON.stringify({ message: "Prepare collaborative draft" }) });
    await api(base, `/v1/compile?${projectQuery}`, { method: "POST", headers: json, body: JSON.stringify({ main: "main.tex" }) });

    await mkdir(outputDir, { recursive: true });
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 810 },
      recordVideo: { dir: recordingDir, size: { width: 1440, height: 810 } },
    });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("latexcoder-theme", "light"));
    await page.goto(`${base}/projects/${project.id}?e2e=1`);
    await page.locator("#editor-page").waitFor();
    await page.locator("#back-projects").click();
    await page.locator("#projects-page").waitFor();
    await page.addStyleTag({ content: `
      #demo-caption { position: fixed; left: 48px; bottom: 42px; z-index: 9999; width: min(520px, calc(100vw - 96px)); padding: 15px 18px; color: #f7faf8; background: rgba(18, 25, 21, .94); border: 1px solid rgba(255,255,255,.16); border-radius: 7px; box-shadow: 0 18px 48px rgba(0,0,0,.28); opacity: 0; transform: translateY(12px); transition: opacity .28s ease, transform .28s ease; pointer-events: none; font-family: ui-sans-serif, system-ui, sans-serif; }
      #demo-caption.visible { opacity: 1; transform: translateY(0); }
      #demo-caption small { display: block; margin-bottom: 4px; color: #8ee0b8; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      #demo-caption strong { display: block; font-family: Georgia, serif; font-size: 23px; letter-spacing: 0; }
      #demo-caption p { margin: 5px 0 0; color: #d3ddd7; font-size: 13px; line-height: 1.45; }
      #demo-splash { position: fixed; inset: 0; z-index: 10000; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #18201b; background: #f5f8f5; opacity: 0; transition: opacity .4s ease; pointer-events: none; font-family: ui-sans-serif, system-ui, sans-serif; }
      #demo-splash.visible { opacity: 1; }
      #demo-splash img { width: 112px; height: 112px; object-fit: contain; }
      #demo-splash h1 { max-width: 900px; margin: 22px 32px 0; text-align: center; font-family: Georgia, serif; font-size: 44px; letter-spacing: 0; }
      #demo-splash p { margin: 12px 24px 0; color: #637068; font-size: 18px; }
      #clone-command { color: transparent !important; text-shadow: 0 0 8px rgba(24,32,27,.5); }
    ` });

    await splash(page);
    await caption(page, "Projects", "Keep every paper organized", "Search by title or tag, archive projects personally, and open the entire row.", 3400);
    await page.locator("#project-search").fill("Research");
    await wait(1600);
    await page.locator("#project-search").fill("");
    await wait(700);
    await page.locator(".project-row", { hasText: "Collaborative Research Notes" }).click();
    await page.locator("#editor-page").waitFor();
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.locator("#pdf-document canvas").first().waitFor();

    await caption(page, "Source + PDF", "Write and preview side by side", "Resizable panes keep files, source, and the compiled paper in one professional workspace.", 4200);
    await page.locator('.tree-item[data-path="sections"] > .tree-row').click();
    await page.locator('.file-row[title="sections/method.tex"]').click();
    await wait(1700);
    await page.getByRole("tab", { name: "main.tex", exact: true }).click();
    await wait(700);

    await page.locator("#toggle-review").click();
    await page.locator("#review-list .review-item").first().waitFor();
    await caption(page, "Review", "Comments and tracked suggestions", "Discuss, reply, accept, or reject changes across the whole project.", 4300);
    await page.locator("#close-review").click();

    await page.locator("#collaborate-menu").click();
    await caption(page, "Collaboration", "Share with View or Edit access", "Invite registered collaborators or send a protected project link to a guest.", 3600);
    await page.keyboard.press("Escape");

    await page.locator("#history-menu").click();
    await page.locator("#toggle-blame").click();
    await page.locator(".cm-blame-author").first().waitFor();
    await caption(page, "Attribution", "See who wrote every range", "Blame follows collaborative text and connects authorship to project checkpoints.", 3600);
    await page.locator("#history-menu").click();
    await page.locator("#git-button").click();
    await page.locator("#git-history .version-row").first().waitFor();
    await caption(page, "History", "Inspect and restore persistent versions", "Browse per-file diffs and restore one file or the complete paper without rewriting history.", 3900);
    await page.locator("#git-close").click();
    await page.locator("#history-menu").click();
    await page.locator("#toggle-blame").click();

    await page.evaluate(() => {
      const state = (window as Window & { __paperE2E?: { state: { view: { state: { doc: { toString(): string } }; dispatch(spec: unknown): void; focus(): void } } } }).__paperE2E?.state;
      if (!state) throw new Error("Editor state is unavailable");
      const source = state.view.state.doc.toString();
      const position = source.lastIndexOf("\\end{document}");
      state.view.dispatch({ selection: { anchor: position }, changes: { from: position, insert: "\\undefinedDemoCommand\n" }, scrollIntoView: true });
      state.view.focus();
    });
    await wait(700);
    await page.locator("#compile-button").click();
    await page.locator("#first-fatal-error").waitFor();
    await caption(page, "Log", "Find the first fatal error immediately", "Structured diagnostics jump from the compiler output back to the exact source line.", 4800);
    await page.locator("#first-fatal-error").click();
    await wait(1200);

    await page.locator("#collaborate-menu").click();
    await page.locator("#collaborate-git").click();
    await page.locator("#git-access-dialog").waitFor();
    await caption(page, "Git", "Clone, pull, and push normally", "Each project is a real repository; live browser edits are checkpointed before Git clients pull.", 4000);
    await page.locator("#git-access-close").click();

    await splash(page, true);
    const video = page.video();
    await page.close();
    await context.close();
    if (!video) throw new Error("Playwright did not create a video");
    const recorded = await video.path();
    const ffmpeg = "/opt/homebrew/bin/ffmpeg";
    if (!existsSync(ffmpeg)) throw new Error("ffmpeg is required to produce the LinkedIn MP4");
    await execute(ffmpeg, [
      "-y", "-i", recorded,
      "-vf", "fps=30,scale=1920:1080:flags=lanczos",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4Output,
    ], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  } finally {
    await browser?.close();
    paper.shutdown();
    paper.sockets.close();
    await new Promise<void>(resolve => paper.server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
    await rm(recordingDir, { recursive: true, force: true });
  }
}

await main();
