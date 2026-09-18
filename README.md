# LaTeX Coder

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/latexcoder?referralCode=4KUZ4o&utm_medium=integration&utm_source=template&utm_campaign=generic)

LaTeX Coder is a small, collaborative, filesystem-backed LaTeX editor. One
Node process serves the browser editor, project APIs, and Yjs WebSocket rooms.
Each project keeps ordinary source files and build artifacts in an isolated
directory, while SQLite stores structured application state. A small invite-only user system protects
the project dashboard, while capability links give guests access to individual
projects without requiring an account.

The application is TypeScript end to end. The browser UI is React built by
Vite, with shadcn-style components and Tailwind CSS v4 utilities. The Node
server is executed with `tsx` and serves the Vite production build alongside
the JSON, Git HTTP, and WebSocket endpoints.

![LaTeX Coder workspace with project files, collaborative source editing, and PDF preview](docs/images/workspace.png)

Licensed under the [MIT License](LICENSE).

## Features

- A user-scoped project dashboard with stable, shareable editor URLs.
- Invite-only core-team accounts for project creation and management, plus
  password-bearing share links that establish scoped guest sessions.
- Persistent member profiles with editable display names used in presence,
  comments, and suggestions.
- System-aware Light and Dark themes with a persistent per-browser preference,
  including the source editor, reviews, logs, dialogs, and project dashboard.
- Real-time Yjs collaboration over WebSockets, with presence indicators.
- Threaded inline comments, replies, and tracked suggestions encoded as explicit
  LaTeX macros. Humans and agents see and edit the same review state through
  ordinary source reads and hash-checked full-file uploads, including replying, accepting,
  rejecting, and resolving it.
- An independent Git repository for every project. The collaborative document
  always represents `main`; incoming changes are merged in a temporary worktree.
- Conflict isolation on `conflict/<UTC timestamp>` branches, leaving the live
  Yjs document and `main` untouched until the content is resolved.
- Git status, history, checkpoints, and a copy-ready personal Git remote for
  ordinary `clone`, `pull`, and `push` workflows.
- On-demand LaTeX compilation with content-addressed caching, PDF preview,
  build logs, and an always-current PDF download endpoint.
- In-editor previews for project images and PDF files, with zoom and download.
- Command-click (Mac) or Ctrl-click compiled PDF content to open its LaTeX source via SyncTeX,
  including included files and review-aware line mapping.
- Selection context menus with common editing commands, inline comments, and
  forward SyncTeX navigation from source to the matching PDF position.
- Project-wide text search with highlighted matches and cross-file navigation;
  optional case-sensitive and sandboxed ripgrep regular-expression search.
- Whole-project ZIP export, including the current uncommitted working tree.
- A Markdown manual and full-file editing API for coding agents. Agents upload
  raw UTF-8 files with their downloaded base SHA-256; the server computes Yjs
  changes and rejects stale uploads without overwriting collaborators' edits.
- A project-scoped ripgrep API with native regex, glob, line-number, and output
  options for coding agents.
- Project-scoped plain-text Agent workspace links that can submit checked edits
  directly into the same Yjs documents used by browser collaborators.

## LaTeX Coder vs. Overleaf

| LaTeX Coder | Overleaf |
| --- | --- |
| **Deployment:** Small, self-hosted Node service for trusted teams; project data stays in ordinary local directories. | **Deployment:** Mature hosted collaboration platform, with separate on-premises editions. |
| **Access:** Invite-only members see projects they own or have joined. Each member has a personal project secret; guests exchange a member's high-entropy link for a scoped HttpOnly session. | **Access:** Account-based sharing with collaborator roles and managed permissions. |
| **Real-time model:** Yjs documents synchronize over WebSockets and always represent the project's `main` branch. | **Real-time model:** Uses Operational Transformation and WebSockets for simultaneous editing. |
| **Review workflow:** Comments and revisions are explicit LaTeX macros, so they are visible and editable to both humans and agents through the same source and patch APIs. | **Review workflow:** Comments and Track Changes are managed by the platform UI; Track Changes is premium, and Overleaf warns that mixing active Git use with comments or tracked changes can lose or displace that review state. |
| **Git model:** Every project directory is the actual Git working tree. Clean incoming commits are imported into Yjs; conflicts are retained on generic conflict branches. | **Git model:** Overleaf history is separate from Git and translated through a Git bridge, which supports one linear `master` history. Git integration is a premium feature. |
| **Git transport:** Each registered collaborator gets a personal smart HTTP URL for clone, pull, and push. A push is checkpointed and merged into the live Yjs-backed `main` automatically. | **Git transport:** Its Git bridge supports authenticated clone, pull, and push. GitHub synchronization is a separate integration. |
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
pnpm install
pnpm check
pnpm test
LATEXCODER_ADMIN_PASSWORD='use-a-long-random-password' pnpm start
```

For development, `pnpm dev` starts the TypeScript server on port 8090 and
the Vite development server on `http://127.0.0.1:5173/`; Vite proxies API, Git,
share-link, and collaboration traffic to the backend.

The codebase is split into `src/client`, `src/server`, and `src/shared`. The
backend has a thin process entry point in `src/server/main.ts`; `app.ts` composes HTTP routes and
project runtimes, `collaboration.ts` owns Yjs documents and persistence,
`compile-service.ts` owns compilation and cache updates, `compile-queue.ts`
applies a process-wide concurrency limit,
`project-files.ts` owns project-tree access, `search.ts` implements the search
service, `process.ts` contains bounded subprocess and bubblewrap execution, and
`core.ts` contains shared validation and authentication primitives. Domain
contracts live in `types.ts`; request schemas shared by the browser and server
live in `src/shared/api-schema.ts`. Persistent records remain in `database.ts`,
with ordered transactional migrations in `src/server/database/migrations.ts`.
The browser app and its UI components live in `src/client`, while environment-neutral
parsers and mapping utilities live in `src/shared`. Separate TypeScript projects
prevent client code from depending on Node APIs and server code from depending on
browser APIs. Production TypeScript is checked with `noImplicitAny` and
unused-symbol checks.

Open `http://127.0.0.1:8090/`. Set `LATEXCODER_PORT` or `LATEXCODER_HOST` to
change the listener. State defaults to `.latexcoder/`; set
`LATEXCODER_STATE_DIR` to move it. `LATEXCODER_LATEX_BIN` may point to Tectonic
or `latexmk`. `LATEXCODER_COMPILE_CONCURRENCY` controls the process-wide compile
limit and defaults to `2`. The install helper at
`scripts/install-tectonic.sh` installs a local compiler beneath the state root.

The server emits one-line JSON request and compile logs in production. Use
`GET /health/live` for a liveness probe and `GET /health/ready` for readiness;
the readiness payload includes the SQLite schema version, compile queue state,
and detected external tools. Missing optional tools are reported without making
the editor itself unready.

PDF source navigation requires the `synctex` executable (included in the Docker
image). Recompile existing PDFs once to generate synchronization data.

The agent ripgrep API and regular-expression project search require Linux
bubblewrap (`bwrap`) and ripgrep (`rg`). Literal project search also works on macOS.
Every ripgrep
search runs without network access, with the project mounted read-only, a 15
second timeout, and a 4 MiB output limit. `LATEXCODER_BWRAP_BIN` and
`LATEXCODER_RG_BIN` may point to explicit binaries.

On an empty state directory, `LATEXCODER_ADMIN_PASSWORD` creates the initial
`admin` user. The password must contain at least 10 characters. It is hashed
with `scrypt` in `.latexcoder/state.sqlite` and is ignored after the first user has
been created. Signed-in users can generate single-use registration links for
additional team members; invitations expire after seven days.

## Docker

The image stores all persistent state beneath `/data`, including SQLite,
projects, Git repositories, Yjs snapshots, compiler caches, and generated PDFs.
It does not declare a Docker `VOLUME`; configure the deployment platform's
persistent volume mount at `/data`. The image also includes Tectonic, ripgrep,
and bubblewrap.

```sh
docker build -t latexcoder .
docker volume create latexcoder-data
docker run --rm \
  --name latexcoder \
  --publish 8090:8090 \
  --security-opt seccomp=unconfined \
  --env LATEXCODER_ADMIN_PASSWORD='use-a-long-random-password' \
  --volume latexcoder-data:/data \
  latexcoder
```

The seccomp setting lets bubblewrap create the Linux namespaces used by the
project search sandbox; no additional Linux capabilities are required. The
setting is not needed if search is not used.

On Railway, attach a persistent volume with mount path `/data` and set
`LATEXCODER_ADMIN_PASSWORD`. The server accepts Railway's injected `PORT`
automatically; no Docker `VOLUME` declaration or custom start command is used.

## Projects

New project accepts an optional ZIP archive. Uploading a ZIP from the editor
extracts it into the current project without overwriting existing files. A
single enclosing directory is removed automatically. Imports reject unsafe
paths and Git metadata, and are limited to 20 MiB compressed, 100 MiB extracted,
and 1,000 entries.

Signed-in users open on a dedicated dashboard containing projects they own or
have joined as registered collaborators, and can create new projects under their
account. Being signed in alone does not grant access to another user's projects.
Project URLs use generated 12-character IDs that are independent of display names,
so renaming a project never changes its URL.
Guests enter through `/share/<project-id>/<secret>`; the server exchanges that
secret for a 24-hour, project-scoped HttpOnly session and redirects to the clean
editor URL `/projects/<project-id>`. Guests can edit that project but cannot list
or create projects. A signed-in member opening the same link joins the project as
a persistent collaborator. Every registered project member receives a distinct
personal Browser, Agent, and Git secret in the Collaborate panel. Rotating it
invalidates only that member's old links and their guest sessions; the other
members keep access. Only the owner can rename or delete the project. Project
state is stored beneath:

```text
.latexcoder/
  state.sqlite   users, invitations, sessions, project/build state, Yjs snapshots
  projects/<project-id>/
    project/     canonical source files and independent Git repository
      .git/
    build/       latest compiled PDF
```

SQLite is authoritative for structured state; the server does not infer or
migrate projects from legacy JSON files or stray directories. Source files and
each project's Git repository remain directly accessible on the filesystem.

## Git And Collaboration

Every project is initialized on `main`. Yjs always represents that branch;
the service never checks another branch out into the collaborative working
tree. Changes are checkpointed automatically after 30 seconds of inactivity,
or at most every five minutes during continuous editing. Unchanged content does
not create a commit. Automatic and manual checkpoints flush Yjs and serialize
Git index/ref writes without disconnecting editors. Incoming Git merges briefly
suspend live synchronization while importing their result.

Clone and fetch checkpoint the latest Yjs content before advertising Git refs,
so browser users do not need to commit or push before someone pulls their work.

The **History** button opens persistent, paginated versions with per-file diffs,
line numbers, and an **Agent edits** filter. Each version can restore the entire
project or one changed file, including binary assets. A custom confirmation
explains that current work is checkpointed first; restoring creates a new commit
without rewriting history. Restore the preceding checkpoint to undo a restore.
The server rejects a restore if the project changed after its preview, including
review-only edits. New checkpoints also remember the main file and empty folders.
Older Git commits without this metadata retain their file contents but cannot
reconstruct empty folders that Git never tracked.

Checked full-file and patch API edits save an isolated before/after version
immediately. Pass `agentId` and `agentName` to full-file edits (or `agent` to the
patch API) to label the record. Upload, move, delete, and folder requests made
with an Agent link's `access` query parameter or explicit `agentId` are recorded
as agent operations too. Names are supplied by the caller, not verified identities.
Ordinary browser edits continue to use automatic checkpoints. Versions represent
individual API operations, not an atomic multi-file agent task. Git-pushed commits
appear in the complete timeline with their original messages.

History APIs (project/session authentication applies to every route):

- `GET /v1/history?project=ID[&before=COMMIT][&agent=1]`: 30 versions and a cursor.
- `GET /v1/history/COMMIT?project=ID`: metadata, changed files and `currentRevision`.
- `GET /v1/history/COMMIT?project=ID&path=FILE`: textual diff or binary-change notice.
- `POST /v1/history/COMMIT/restore?project=ID`: JSON `{ "currentRevision": "...", "path": "optional-file.tex" }`.

Diffs are relative to the previous first-parent version; large textual diffs are
explicitly truncated for display. Full content remains in Git. History survives
service restarts but is local to the project repository, not an off-site backup;
deleting the project also deletes its history.

Each
registered collaborator's personal Git URL is a normal smart HTTP remote:

```sh
git clone http://127.0.0.1:8090/git/<project-id>/<share-secret>
cd <project-id>
# edit and commit normally
git push origin main
```

No upstream or server-side ref configuration is required. Before accepting a
push, the service checkpoints current Yjs changes. It then merges the pushed
commit in a temporary detached worktree and imports a clean result into the live
Yjs documents. If Git or review-storage validation finds a conflict, the pushed
commit is kept on `conflict/<UTC timestamp>` while `main` and Yjs remain
unchanged. Resolve the content on `main`, then use **Mark resolved** to create
the two-parent merge commit and remove the quarantine branch.

**Download ZIP** packages the live working tree, including current uncommitted
files, without changing the Git index or creating a commit.

## Agent API

### Editing and workspace tools

- Project settings select the main TeX document, Tectonic or latexmk, and optional
  debounced automatic compilation.
- Source/PDF navigation uses SyncTeX regions; source selections are highlighted
  in the PDF and remain aligned when zooming.
- Compile errors link back to source. Failed builds retain the last successful
  PDF with an out-of-date indicator; the default Agent PDF endpoint remains fresh.
  If current compilation fails, `GET /v1/build/pdf` returns HTTP 422 JSON with
  `error.details.log`, `diagnostics`, and `firstFatalError` (including source
  path/line when available), not a stale PDF. Successful downloads include
  `X-Build-Error-Count`, `X-Build-Warning-Count`, and a `Link` to the log API.
  `GET /v1/build` exposes the same diagnostics alongside build state. Agents can
  inspect the failure, submit a checked source edit, then request the PDF again
  without explicitly managing compilation. Check HTTP status before saving the
  response as a PDF; the Agent workspace includes a status-aware curl example.
- Files and folders can be moved or renamed, including drag-and-drop. Deleted
  items and their collaborative snapshots are stored in SQLite and can be restored.
- Search and replace supports the current file or whole project. A diff preview
  precedes applying changes; stale hashes reject the entire batch without editing.
- Browser edits are cached in IndexedDB for recovery and synchronize on reconnect.
  Saved status is acknowledged after server persistence; undo affects only your edits.
- `POST /v1/files/edit/conflict` accepts the rejected raw upload and original
  `X-Base-SHA256`, returning current source, its hash, and a read-only unified diff.
  This is not a three-way merge or permission to overwrite another collaborator.

Replace APIs: `POST /v1/search/replace/preview` accepts `query`, literal
`replacement`, optional `path`, `regex`, and `caseSensitive`. Its returned files
contain `path`, `baseSha256`, and `source`; submit those to
`POST /v1/search/replace` as `{ "files": [...] }`. Replacement text is literal,
including when matching with a regular expression.

`GET /` with `Accept: text/markdown` returns the live API manual. Project file
and build routes take a `project=<id>` query parameter. Agents must provide a
member session or exchange a project share link for a scoped cookie. For example:

```sh
curl -c session.txt -L 'http://127.0.0.1:8090/share/<project-id>/<share-secret>'
curl -b session.txt 'http://127.0.0.1:8090/v1/project?project=<project-id>'
```

Agents download a file using `GET /v1/files` and keep its `X-Content-SHA256`
header. After editing that file locally, upload the complete UTF-8 file to
`POST /v1/files/edit?project=<id>&path=main.tex` using `--data-binary @file.tex`
and the header `X-Base-SHA256: <downloaded-hash>`. No JSON escaping or offsets
are needed. The server computes and applies the diff in one Yjs transaction.
If the live file changed, it returns HTTP 409 without modifying anything.
Download the latest version and reapply the edits; never attach a new hash to
an old edited file. Direct mode is the default; `mode=suggesting` with
`agentId` and `agentName` query parameters creates inline review suggestions.

Registered project members can copy their own capability-bearing Agent workspace URL from the
**Collaborate** dialog. Opening `/agent/<project-id>/<share-secret>` returns a
plain-text project file listing and project-specific read and checked-upload
URLs. These URLs do not require an account or cookie; possession of the link
grants edit access to that project.

The Agent workspace also documents its capability-bearing Git status, commit,
clone, and push interfaces. It explicitly tells agents not to use Git unless
the user requests a Git operation; routine live-document edits continue to use
checked Yjs patches.

## Trust Boundary

Member passwords are hashed, invitation tokens are single-use, and share links
are high-entropy bearer secrets exchanged for project-scoped sessions. This is
basic access control, not a hardened multi-tenant security boundary: anyone who
has a share link can edit and reshare that project. Sessions are persisted in
SQLite and remain valid across restarts until they expire or the user logs out.
LaTeX compilation is not a security sandbox;
run the service for trusted teams and do not place unrelated secrets in project
directories.
