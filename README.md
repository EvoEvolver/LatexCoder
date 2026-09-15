# LaTeX Coder

LaTeX Coder is a small, collaborative, filesystem-backed LaTeX editor. One
Node process serves the browser editor, project APIs, and Yjs WebSocket rooms.
Each project keeps ordinary source files, collaboration snapshots, and build
artifacts in an isolated directory. There is no account system or database.

## Features

- A multi-project dashboard with stable, shareable editor URLs.
- Real-time Yjs collaboration over WebSockets, with presence indicators.
- Inline comments and tracked suggestions that can be accepted, rejected, or
  resolved without leaving the source editor.
- An independent Git repository for every project. The collaborative document
  always represents `main`; incoming changes are merged in a temporary worktree.
- Conflict isolation on `conflict/<UTC timestamp>` branches, leaving the live
  Yjs document and `main` untouched until the content is resolved.
- Git status, history, checkpoints, upstream/ref synchronization, and a
  copy-ready read-only `git clone` command in the editor.
- Local LaTeX compilation with PDF preview, build logs, and PDF download.
- Whole-project ZIP export, including the current uncommitted working tree.
- A Markdown manual and checked file/patch APIs for coding agents.

## LaTeX Coder vs. Overleaf

| LaTeX Coder | Overleaf |
| --- | --- |
| **Deployment:** Small, self-hosted Node service for trusted teams; project data stays in ordinary local directories. | **Deployment:** Mature hosted collaboration platform, with separate on-premises editions. |
| **Access:** A project link grants edit access to anyone who can reach the server. There are currently no accounts, roles, or private share tokens. | **Access:** Account-based sharing with collaborator roles and managed permissions. |
| **Real-time model:** Yjs documents synchronize over WebSockets and always represent the project's `main` branch. | **Real-time model:** Uses Operational Transformation and WebSockets for simultaneous editing. |
| **Review workflow:** Inline comments and suggestions are stored with the LaTeX source and are available without a paid plan. | **Review workflow:** Comments and reviewing are integrated into the platform; real-time Track Changes is a premium feature. |
| **Git model:** Every project directory is the actual Git working tree. Clean incoming commits are imported into Yjs; conflicts are retained on generic conflict branches. | **Git model:** Overleaf history is separate from Git and translated through a Git bridge, which supports one linear `master` history. Git integration is a premium feature. |
| **Git transport:** Provides read-only smart HTTP clone. Commits and sync operations are performed from the web UI or API against server-visible refs and upstreams. | **Git transport:** Its Git bridge supports authenticated clone, pull, and push. GitHub synchronization is a separate integration. |
| **Export:** Downloads the live working tree as a ZIP, including uncommitted files, without changing the index. | **Export:** Downloads the current project source as a ZIP; generated PDF and most generated files are downloaded separately. |
| **Automation:** Exposes a concise Markdown manual plus file, checked-patch, build, review, and Git APIs for agents. | **Automation:** Emphasizes the hosted editor and integrations such as Git, GitHub, and reference managers. |

The Overleaf descriptions above follow its official documentation for
[collaboration][overleaf-collaboration], [Track Changes][overleaf-track-changes],
[Git integration][overleaf-git], [advanced Git behavior][overleaf-git-advanced],
and [project downloads][overleaf-download].

[overleaf-collaboration]: https://docs.overleaf.com/collaborating/collaborating-in-overleaf
[overleaf-track-changes]: https://docs.overleaf.com/collaborating/track-changes
[overleaf-git]: https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git
[overleaf-git-advanced]: https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/advanced-git-operations
[overleaf-download]: https://docs.overleaf.com/managing-projects-and-files/downloading-a-project

## Development

```sh
npm install
npm test
npm start
```

Open `http://127.0.0.1:8090/`. Set `LATEXCODER_PORT` or `LATEXCODER_HOST` to
change the listener. State defaults to `.latexcoder/`; set
`LATEXCODER_STATE_DIR` to move it. `LATEXCODER_LATEX_BIN` may point to Tectonic
or `latexmk`. The older `PAPER_*` names remain supported as fallbacks. The install helper at
`scripts/install-tectonic.sh` installs a local compiler beneath the state root.

## Projects

The browser opens on a dedicated project page. Opening a project uses the
shareable URL `/projects/<project-id>`; anyone who can reach the server can use
that URL to edit. Rename, download, and delete actions live in each project's
overflow menu so destructive actions are not primary controls. Project state
is stored beneath:

```text
.latexcoder/projects/<project-id>/
  project/       canonical source files and independent Git repository
    .git/
  yjs/           collaborative editing snapshots
  build/         latest build metadata and PDF
  project.json   display metadata
```

An existing single-project state root containing `project/`, `yjs/`, and
`build/` is migrated automatically to `projects/paper/` on first startup.

## Git And Collaboration

Every project is initialized on `main`. Yjs always represents that branch;
the service never checks another branch out into the collaborative working
tree. Git operations briefly flush and suspend live synchronization so a
commit sees one coherent source snapshot.

The Git panel supports status, history, commits, and synchronization from an
explicit ref or configured upstream. Incoming updates are merged in a temporary
detached worktree. A clean result is imported into the live Yjs documents. If
Git or review-storage validation finds a conflict, the incoming commit is kept
on `conflict/<UTC timestamp>` while `main` and Yjs remain unchanged. Resolve the
content on `main`, then use **Mark resolved** to create the two-parent merge
commit and remove the quarantine branch.

The editor's **Clone** action exposes a read-only smart HTTP endpoint:

```sh
git clone http://127.0.0.1:8090/git/<project-id>
```

Cloning returns committed history. **Download ZIP** instead packages the live
working tree, including current uncommitted files, without changing the Git
index or creating a commit.

## Agent API

`GET /` with `Accept: text/markdown` returns the live API manual. Project file
and build routes take a `project=<id>` query parameter. For example:

```sh
curl http://127.0.0.1:8090/v1/projects
curl 'http://127.0.0.1:8090/v1/project?project=my-paper'
```

Agents can submit checked UTF-16 edits through
`POST /v1/files/patch?project=<id>&path=main.tex`. Suggesting mode records the
edit as inline review storage; direct mode bypasses review creation.

## Trust Boundary

LaTeX Coder has no application authentication. Any caller able to reach it can
read or modify every project. Compilation is not a security sandbox. Run it
only for trusted users and do not place secrets in project directories.
