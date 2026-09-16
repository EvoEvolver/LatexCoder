# LaTeX Coder

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

## Features

- A user-scoped project dashboard with stable, shareable editor URLs.
- Invite-only core-team accounts for project creation and management, plus
  password-bearing share links that establish scoped guest sessions.
- Real-time Yjs collaboration over WebSockets, with presence indicators.
- Inline comments and tracked suggestions encoded as explicit LaTeX macros.
  Humans and agents see and edit the same review state through ordinary source
  reads and checked patches, including accepting, rejecting, and resolving it.
- An independent Git repository for every project. The collaborative document
  always represents `main`; incoming changes are merged in a temporary worktree.
- Conflict isolation on `conflict/<UTC timestamp>` branches, leaving the live
  Yjs document and `main` untouched until the content is resolved.
- Git status, history, checkpoints, upstream/ref synchronization, and a
  copy-ready read-only `git clone` command in the editor.
- Local LaTeX compilation with PDF preview, build logs, and PDF download.
- Whole-project ZIP export, including the current uncommitted working tree.
- A Markdown manual and checked file/patch APIs for coding agents.
- Project-scoped plain-text Agent workspace links that can submit checked edits
  directly into the same Yjs documents used by browser collaborators.

## LaTeX Coder vs. Overleaf

| LaTeX Coder | Overleaf |
| --- | --- |
| **Deployment:** Small, self-hosted Node service for trusted teams; project data stays in ordinary local directories. | **Deployment:** Mature hosted collaboration platform, with separate on-premises editions. |
| **Access:** Invite-only members manage only their own projects. Guests exchange a high-entropy project link for a scoped HttpOnly session and never see the owner's project dashboard. | **Access:** Account-based sharing with collaborator roles and managed permissions. |
| **Real-time model:** Yjs documents synchronize over WebSockets and always represent the project's `main` branch. | **Real-time model:** Uses Operational Transformation and WebSockets for simultaneous editing. |
| **Review workflow:** Comments and revisions are explicit LaTeX macros, so they are visible and editable to both humans and agents through the same source and patch APIs. | **Review workflow:** Comments and Track Changes are managed by the platform UI; Track Changes is premium, and Overleaf warns that mixing active Git use with comments or tracked changes can lose or displace that review state. |
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
pnpm install
pnpm check
pnpm test
LATEXCODER_ADMIN_PASSWORD='use-a-long-random-password' pnpm start
```

For development, `pnpm dev` starts the TypeScript server on port 8090 and
the Vite development server on `http://127.0.0.1:5173/`; Vite proxies API, Git,
share-link, and collaboration traffic to the backend.

Open `http://127.0.0.1:8090/`. Set `LATEXCODER_PORT` or `LATEXCODER_HOST` to
change the listener. State defaults to `.latexcoder/`; set
`LATEXCODER_STATE_DIR` to move it. `LATEXCODER_LATEX_BIN` may point to Tectonic
or `latexmk`. The install helper at
`scripts/install-tectonic.sh` installs a local compiler beneath the state root.

On an empty state directory, `LATEXCODER_ADMIN_PASSWORD` creates the initial
`admin` user. The password must contain at least 10 characters. It is hashed
with `scrypt` in `.latexcoder/state.sqlite` and is ignored after the first user has
been created. Signed-in users can generate single-use registration links for
additional team members; invitations expire after seven days.

## Projects

Signed-in users open on a dedicated dashboard containing only projects they own
and can create new projects under their account. Being signed in does not grant
access to another user's projects. Project URLs use generated 12-character IDs
that are independent of display names, so renaming a project never changes its URL.
Guests enter through `/share/<project-id>/<secret>`; the server exchanges that
secret for a 24-hour, project-scoped HttpOnly session and redirects to the clean
editor URL `/projects/<project-id>`. Guests can edit that project but cannot list
or create projects. Only the owner can rename or delete a project and retrieve
its share and clone URLs. Project state is stored beneath:

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
git clone http://127.0.0.1:8090/git/<project-id>/<share-secret>
```

Cloning returns committed history. **Download ZIP** instead packages the live
working tree, including current uncommitted files, without changing the Git
index or creating a commit.

## Agent API

`GET /` with `Accept: text/markdown` returns the live API manual. Project file
and build routes take a `project=<id>` query parameter. Agents must provide a
member session or exchange a project share link for a scoped cookie. For example:

```sh
curl -c session.txt -L 'http://127.0.0.1:8090/share/<project-id>/<share-secret>'
curl -b session.txt 'http://127.0.0.1:8090/v1/project?project=<project-id>'
```

Agents can submit checked UTF-16 edits through
`POST /v1/files/patch?project=<id>&path=main.tex`. Suggesting mode records the
edit as inline review storage; direct mode bypasses review creation.

Project owners can copy a capability-bearing Agent workspace URL from the
**Collaborate** dialog. Opening `/agent/<project-id>/<share-secret>` returns a
plain-text project file listing and project-specific read and checked-patch
URLs. These URLs do not require an account or cookie; possession of the link
grants edit access to that project.

## Trust Boundary

Member passwords are hashed, invitation tokens are single-use, and share links
are high-entropy bearer secrets exchanged for project-scoped sessions. This is
basic access control, not a hardened multi-tenant security boundary: anyone who
has a share link can edit and reshare that project. Sessions are persisted in
SQLite and remain valid across restarts until they expire or the user logs out.
LaTeX compilation is not a security sandbox;
run the service for trusted teams and do not place unrelated secrets in project
directories.
