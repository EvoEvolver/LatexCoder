# LaTeX Coder vs. Overleaf Community Edition

This table compares LaTeX Coder with the current self-hosted Overleaf Community
Edition (CE), not with Overleaf's hosted Free or Premium plans. Overleaf's
official comparison confirms that CE includes the LaTeX editor and full project
history, while several collaboration, administration, and isolation features
are reserved for Server Pro.

| Capability unavailable or limited in Overleaf CE | LaTeX Coder | Coverage |
| --- | --- | --- |
| Comments | Inline comments, replies, resolution, and a project-wide Review view | **Covered** |
| Real-time track changes | Suggestions can be created, accepted, or rejected; review state is stored as LaTeX macros | **Covered** |
| Internal collaboration workflow | Registered collaborators, invitation-only registration, and protected View/Edit links for guests | **Covered** |
| Git integration / Git Bridge | Every project is a real Git repository with a personal clone URL; browser edits are checkpointed before pulls, pushes merge into the live Yjs-backed `main`, and conflicts are retained on a separate branch | **Covered** |
| Templates | Projects can be created from ZIP archives and ZIP files can be imported into existing projects | **Partially covered**: no shared template gallery |
| User administration | Initial admin bootstrap, invitation links, project membership, and editable display names | **Partially covered**: no enterprise administration console |
| Automatic user registration | Registration is restricted to seven-day invitation links, single-use by default or explicitly reusable | **Not covered** |
| SAML / LDAP single sign-on | No directory-backed authentication | **Not covered** |
| Sandboxed compilation | LaTeX compilation is not sandboxed; bubblewrap is used only for ripgrep search | **Not covered** |
| Optimized, isolated TeX Live images | Tectonic can be installed automatically and latexmk can be configured explicitly | **Partially covered**: this is not equivalent to Server Pro's sandboxed TeX Live images |
| Curated internal template gallery | No organization-wide template publishing or gallery | **Not covered** |

## Capabilities Beyond the CE Gap

These LaTeX Coder features are not merely replacements for missing CE features:

| Capability | LaTeX Coder approach |
| --- | --- |
| Agent-visible review data | Comments, replies, and suggestions are source macros that people, agents, and Git can inspect and edit |
| Conflict-safe agent editing | Full-file uploads include a base hash and are rejected when the live document has changed |
| Git and live collaboration | Git commits, Yjs browser editing, and review metadata operate on the same project source |
| Character-level attribution | Blame mode connects collaborative text ranges with authors and Git checkpoints |
| Current-PDF API | PDF downloads compile current source when required and return structured diagnostics instead of a stale success artifact |
| Agent search | Project-scoped literal and ripgrep-compatible search is available through the agent API |

## Important Boundaries

- Full project history is included in current Overleaf CE; it is not a missing
  feature that LaTeX Coder restores.
- Full-project search is also present in the current CE source tree.
- Overleaf CE supports simultaneous editing. The collaboration gap described by
  Overleaf concerns commenting, tracked changes, user onboarding, and related
  managed workflows rather than basic real-time co-editing.
- LaTeX Coder's compilation security model, like Overleaf CE's, assumes trusted
  users. Sandboxed ripgrep search must not be described as sandboxed LaTeX
  compilation.

## Sources

- [Overleaf: Server Pro vs. Community Edition](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition)
- [Overleaf: Server Pro-only configuration](https://docs.overleaf.com/on-premises/configuration/overleaf-toolkit/server-pro-only-configuration)
- [Overleaf Toolkit settings](https://docs.overleaf.com/on-premises/configuration/overleaf-toolkit/toolkit-settings)
- [Overleaf Community Edition repository](https://github.com/overleaf/overleaf)
- [LaTeX Coder README](../README.md)
