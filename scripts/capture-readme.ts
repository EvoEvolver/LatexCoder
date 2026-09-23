import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { createPaperServer } from "../src/server/main.ts";

const mainSource = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage[colorlinks=true,linkcolor=blue]{hyperref}

\title{Writing Papers with Humans and Agents}
\author{Research Team}
\date{September 2026}

\begin{document}
\maketitle

\begin{abstract}
LaTeX Coder keeps collaborators, coding agents, and Git working on the same
auditable source tree while the paper remains readable and easy to review.
\end{abstract}

\section{Introduction}
Scientific writing is an iterative process. Ideas, experiments, and explanations
evolve together as a team develops a shared account of its results.

The workspace connects live editing, checked agent changes, and project history
without hiding review metadata outside the source.

\input{sections/method}

\section{Results}\label{sec:results}
Every project remains an ordinary Git repository while browser edits synchronize
through a shared document. The resulting workflow supports both interactive
writing and reproducible automation.

\section{Next steps}
We will evaluate the workflow on longer multi-author papers and agent-assisted
review. The editing protocol is summarized in Section~\ref{sec:results}.

\end{document}
`;

const methodSource = String.raw`\section{Method}
Each checked agent upload includes the hash of the source it downloaded. The
server rejects stale changes, computes the textual update, and applies it to the
same live document used by browser collaborators.
`;

const references = String.raw`@article{collaboration2026,
  title = {Collaborative Scientific Writing},
  author = {Research Team},
  year = {2026}
}
`;

async function main(): Promise<void> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-readme-"));
  const compiler = ["/Library/TeX/texbin/latexmk", "/usr/bin/latexmk", "/usr/local/bin/tectonic"].find(existsSync);
  const paper = await createPaperServer({ stateDir, authDisabled: true, compiler });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      paper.server.once("error", reject);
      paper.server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(paper.server.address() as AddressInfo).port}`;
    const project = (await (await fetch(`${base}/v1/projects`)).json() as { projects: Array<{ id: string }> }).projects[0];
    if (!project) throw new Error("Default project was not created");
    const projectQuery = new URLSearchParams({ project: project.id });
    const upload = async (filePath: string, source: string): Promise<void> => {
      const query = new URLSearchParams(projectQuery);
      query.set("path", filePath);
      const response = await fetch(`${base}/v1/files?${query}`, { method: "PUT", body: source });
      if (!response.ok) throw new Error(`Could not create ${filePath}: ${response.status} ${await response.text()}`);
    };
    await upload("main.tex", mainSource);
    await upload("sections/method.tex", methodSource);
    await upload("references.bib", references);
    const compile = await fetch(`${base}/v1/compile?${projectQuery}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ main: "main.tex" }),
    });
    if (!compile.ok) throw new Error(`Could not compile screenshot project: ${compile.status} ${await compile.text()}`);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/?e2e=1`);
    await page.locator("#editor-page").waitFor();
    await page.locator("#pdf-document canvas").first().waitFor();
    await page.locator("#sync-state", { hasText: "Saved live" }).waitFor();
    await page.screenshot({ path: path.resolve("docs/images/workspace.png") });
    await page.close();
  } finally {
    await browser?.close();
    paper.shutdown();
    paper.sockets.close();
    await new Promise<void>(resolve => paper.server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
}

await main();
