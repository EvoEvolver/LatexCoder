/// <reference lib="dom" />

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { chromium, type Page } from "playwright";

import { createPaperServer } from "../src/server/main.ts";

const execute = promisify(execFile);
const outputDir = path.resolve("docs/videos");
const videoOutput = path.join(outputDir, "latexcoder-hover-previews.mp4");

const mainSource = String.raw`\documentclass{article}
\usepackage{graphicx}
\input{macros}
\begin{document}

Related work: \citep{chen2026}.

Custom notation: $\braket{\psi}{\phi}$.

The dynamics follow Equation~\eqref{eq:wave}.

\includegraphics[width=.7\linewidth]{figures/spectrum}

\includegraphics[width=.7\linewidth]{figures/supplement.pdf}

\end{document}`;

const macroSource = String.raw`\newcommand{\braket}[2]{\left\langle #1 \middle| #2 \right\rangle}
\newcommand{\ket}[1]{\left|#1\right\rangle}
\newcommand{\Hamiltonian}{\hat{H}}`;

const equationSource = String.raw`\begin{equation}
i\hbar \frac{\partial}{\partial t}\ket{\psi}
= \Hamiltonian\ket{\psi}\label{eq:wave}
\end{equation}`;

const bibliography = String.raw`@article{chen2026,
  title = {Auditable Collaboration for Scientific Writing},
  author = {Chen, Alex and Patel, Maya and Rivera, Sam},
  journal = {Journal of Open Research},
  year = {2026}
}`;

const spectrumSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="400" viewBox="0 0 720 400">
  <rect width="720" height="400" fill="#f7faf8"/>
  <path d="M72 48V330H670" fill="none" stroke="#26332c" stroke-width="3"/>
  <path d="M75 306 C125 300 145 274 178 268 S228 285 258 230 S315 78 354 190 S416 300 455 244 S510 118 548 208 S610 289 666 156" fill="none" stroke="#167455" stroke-width="7" stroke-linecap="round"/>
  <path d="M75 312 C145 306 207 302 265 290 S370 252 440 263 S557 287 666 278" fill="none" stroke="#bd6541" stroke-width="4" stroke-linecap="round" opacity=".9"/>
  <g fill="#59685f" font-family="Arial, sans-serif" font-size="20"><text x="300" y="375">Frequency</text><text x="-232" y="28" transform="rotate(-90)">Intensity</text></g>
</svg>`;

const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

function previewPdf(): Buffer {
  const stream = "BT /F1 24 Tf 42 118 Td (Supplementary derivation) Tj 0 -38 Td /F1 14 Tf (First-page preview from the project PDF) Tj ET\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 520 220] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(source));
    source += object;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

async function api(base: string, pathname: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${base}${pathname}`, init);
  if (!response.ok) throw new Error(`${init?.method || "GET"} ${pathname}: ${response.status} ${await response.text()}`);
  return response;
}

async function installDemoOverlay(page: Page): Promise<void> {
  await page.addStyleTag({ content: `
    #demo-caption { position: fixed; left: 30px; bottom: 28px; z-index: 9998; width: 390px; padding: 14px 17px; color: #f7faf8; background: rgba(18,25,21,.95); border: 1px solid rgba(255,255,255,.16); border-radius: 7px; box-shadow: 0 18px 48px rgba(0,0,0,.28); opacity: 0; transform: translateY(10px); transition: opacity .24s ease, transform .24s ease; pointer-events: none; font-family: ui-sans-serif, system-ui, sans-serif; }
    #demo-caption.visible { opacity: 1; transform: translateY(0); }
    #demo-caption small { display: block; margin-bottom: 4px; color: #8ee0b8; font-size: 10px; font-weight: 700; text-transform: uppercase; }
    #demo-caption strong { display: block; font-family: Georgia, serif; font-size: 22px; letter-spacing: 0; }
    #demo-caption p { margin: 5px 0 0; color: #d3ddd7; font-size: 12px; line-height: 1.45; }
    #demo-splash { position: fixed; inset: 0; z-index: 10000; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #18201b; background: #f5f8f5; opacity: 0; transition: opacity .35s ease; pointer-events: none; font-family: ui-sans-serif, system-ui, sans-serif; }
    #demo-splash.visible { opacity: 1; }
    #demo-splash img { width: 104px; height: 104px; object-fit: contain; }
    #demo-splash h1 { margin: 20px 32px 0; font-family: Georgia, serif; font-size: 42px; letter-spacing: 0; }
    #demo-splash p { margin: 10px 24px 0; color: #637068; font-size: 17px; }
    #demo-cursor { --duration: 520ms; position: fixed; left: -4px; top: -3px; z-index: 10001; width: 28px; height: 36px; opacity: 0; transform: translate3d(1180px,90px,0); transition: transform var(--duration) cubic-bezier(.22,.78,.24,1), opacity .18s ease; pointer-events: none; }
    #demo-cursor.visible { opacity: 1; }
    #demo-cursor svg { display: block; width: 28px; height: 36px; overflow: visible; filter: drop-shadow(0 2px 2px rgba(0,0,0,.34)); }
    #demo-cursor path { fill: #fff; stroke: #111; stroke-width: 1.7; stroke-linejoin: round; }
  ` });
  await page.evaluate(() => {
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.innerHTML = '<svg viewBox="0 0 28 36" aria-hidden="true"><path d="M3 2.5V29l7.1-6 5 10.4 5-2.4-5-10.3H25L3 2.5Z"/></svg>';
    document.body.append(cursor);
  });
}

async function splash(page: Page, closing = false): Promise<void> {
  await page.evaluate(closing => {
    document.getElementById("demo-cursor")?.classList.remove("visible");
    document.getElementById("demo-splash")?.remove();
    const logo = document.querySelector<HTMLImageElement>("#editor-about img")?.src || "";
    const splash = document.createElement("div");
    splash.id = "demo-splash";
    splash.innerHTML = closing
      ? '<img alt=""><h1>Inspect the source without leaving it.</h1><p>github.com/EvoEvolver/LatexCoder</p>'
      : '<img alt=""><h1>Hover previews in LaTeX Coder</h1><p>Citations, formulas, and project graphics.</p>';
    splash.querySelector("img")!.setAttribute("src", logo);
    document.body.append(splash);
    requestAnimationFrame(() => splash.classList.add("visible"));
  }, closing);
  await wait(closing ? 3000 : 2400);
  if (closing) return;
  await page.evaluate(() => document.getElementById("demo-splash")?.classList.remove("visible"));
  await wait(400);
  await page.evaluate(() => document.getElementById("demo-cursor")?.classList.add("visible"));
}

async function showCaption(page: Page, eyebrow: string, title: string, detail: string): Promise<void> {
  await page.evaluate(({ eyebrow, title, detail }) => {
    document.getElementById("demo-caption")?.remove();
    const caption = document.createElement("div");
    caption.id = "demo-caption";
    caption.innerHTML = "<small></small><strong></strong><p></p>";
    caption.querySelector("small")!.textContent = eyebrow;
    caption.querySelector("strong")!.textContent = title;
    caption.querySelector("p")!.textContent = detail;
    document.body.append(caption);
    requestAnimationFrame(() => caption.classList.add("visible"));
  }, { eyebrow, title, detail });
}

async function hideCaption(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById("demo-caption")?.classList.remove("visible"));
  await wait(280);
}

async function sourcePoint(page: Page, needle: string): Promise<{ x: number; y: number }> {
  return page.evaluate(value => {
    const e2e = (window as Window & {
      __paperE2E?: { state: { view: {
        state: { doc: { toString(): string } };
        coordsAtPos(position: number): { left: number; right: number; top: number; bottom: number } | null;
      } } };
    }).__paperE2E;
    if (!e2e) throw new Error("Editor state is unavailable");
    const view = e2e.state.view;
    const position = view.state.doc.toString().indexOf(value) + Math.floor(value.length / 2);
    if (position < 0) throw new Error(`Source text not found: ${value}`);
    const coordinates = view.coordsAtPos(position);
    if (!coordinates) throw new Error(`Source text is outside the viewport: ${value}`);
    return { x: (coordinates.left + coordinates.right) / 2, y: (coordinates.top + coordinates.bottom) / 2 };
  }, needle);
}

async function movePointer(page: Page, point: { x: number; y: number }, duration = 520): Promise<void> {
  await page.evaluate(({ x, y, duration }) => {
    const cursor = document.getElementById("demo-cursor");
    if (!cursor) throw new Error("Demo cursor is missing");
    cursor.style.setProperty("--duration", `${duration}ms`);
    cursor.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
  }, { ...point, duration });
  await page.mouse.move(point.x, point.y, { steps: 20 });
  await wait(duration + 120);
}

async function clearHover(page: Page): Promise<void> {
  await movePointer(page, { x: 750, y: 102 }, 360);
  await wait(220);
}

async function scene(
  page: Page,
  source: string,
  tooltip: string,
  eyebrow: string,
  title: string,
  detail: string,
  ready?: () => Promise<void>,
): Promise<void> {
  await clearHover(page);
  await showCaption(page, eyebrow, title, detail);
  await movePointer(page, await sourcePoint(page, source));
  await page.locator(tooltip).waitFor();
  await ready?.();
  await wait(2600);
  await hideCaption(page);
}

async function main(): Promise<void> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-hover-demo-"));
  const recordingDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-hover-video-"));
  const paper = await createPaperServer({ stateDir, authDisabled: true });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      paper.server.once("error", reject);
      paper.server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(paper.server.address() as AddressInfo).port}`;
    const project = (await api(base, "/v1/projects").then(response => response.json()) as { projects: Array<{ id: string }> }).projects[0];
    if (!project) throw new Error("Default project was not created");
    await api(base, `/v1/projects/${project.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Quantum Collaboration Demo" }),
    });
    const upload = (filePath: string, body: string | ArrayBuffer, contentType = "text/plain"): Promise<Response> => {
      const query = new URLSearchParams({ project: project.id, path: filePath });
      return api(base, `/v1/files?${query}`, { method: "PUT", headers: { "Content-Type": contentType }, body });
    };
    await upload("main.tex", mainSource);
    await upload("macros.sty", macroSource);
    await upload("equations.tex", equationSource);
    await upload("references.bib", bibliography);
    await upload("figures/spectrum.svg", spectrumSvg, "image/svg+xml");
    const pdfBytes = previewPdf();
    const pdfBody = new Uint8Array(pdfBytes.length);
    pdfBody.set(pdfBytes);
    await upload("figures/supplement.pdf", pdfBody.buffer, "application/pdf");

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
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await installDemoOverlay(page);
    await splash(page);

    await scene(page, "chen2026", ".cm-citation-tooltip", "Citations", "Read the bibliography in place", "Hover a citation key to see its title, authors, venue, and year.");
    await scene(page, "braket", ".cm-formula-tooltip", "Custom macros", "Preview project notation", "LaTeX Coder expands project-defined macros before rendering the formula with KaTeX.");
    await scene(page, "eq:wave", ".cm-formula-tooltip", "Equation references", "Inspect formulas across files", "A reference resolves its label across the project and previews the defining equation.");
    await scene(page, "figures/spectrum", ".cm-image-tooltip", "Figures", "See project images without switching files", "Extensionless and relative graphics paths resolve to the actual project asset.", async () => {
      await page.waitForFunction(() => document.querySelector<HTMLImageElement>(".cm-image-tooltip img")?.naturalWidth === 720);
    });
    await scene(page, "figures/supplement.pdf", ".cm-image-tooltip", "PDF graphics", "Preview the first page instantly", "PDF.js renders project PDFs directly in the editor hover panel.", async () => {
      await page.waitForFunction(() => document.querySelector(".cm-image-tooltip header span")?.textContent === "1 page");
    });

    await clearHover(page);
    await splash(page, true);
    const video = page.video();
    await page.close();
    await context.close();
    if (!video) throw new Error("Playwright did not create a video");
    const recorded = await video.path();
    const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find(existsSync);
    if (!ffmpeg) throw new Error("ffmpeg is required to produce the MP4 demo");
    await execute(ffmpeg, [
      "-y", "-i", recorded,
      "-vf", "fps=30,scale=1920:1080:flags=lanczos",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", videoOutput,
    ], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    console.log(videoOutput);
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
