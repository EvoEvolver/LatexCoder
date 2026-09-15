# LaTeX Coder

LaTeX Coder is a small, collaborative, filesystem-backed LaTeX editor. One
Node process serves the browser editor, project APIs, and Yjs WebSocket rooms.
Each project keeps ordinary source files, collaboration snapshots, and build
artifacts in an isolated directory. There is no account system or database.

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

Projects can be created, renamed, selected, and deleted from the toolbar. Their
state is stored beneath:

```text
.latexcoder/projects/<project-id>/
  project/       canonical source files
  yjs/           collaborative editing snapshots
  build/         latest build metadata and PDF
  project.json   display metadata
```

An existing single-project state root containing `project/`, `yjs/`, and
`build/` is migrated automatically to `projects/paper/` on first startup.

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
