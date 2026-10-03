# Chapter compilation

Open the small arrow on the right side of **Compile**, then choose **Top-level root**
or **Chapter root**. The menu marks the selected mode. Manual compilation,
the compile shortcut, and existing automatic compilation use the selected mode.
Compile resolves the target from the currently open `.tex` file. Opening another
file leaves the displayed PDF attached to its existing target until you compile
or change mode. The arrow's tooltip identifies the last resolved entry and template.
Selecting **Chapter root** on a file without either a `chapter-root` or `template`
directive opens a setup guide with examples. This also works when chapter mode is
already selected. The guide does not change source files; without configuration,
compilation still falls back to the top-level root.

All new configuration lives in leading comments in project `.tex` files. Paths
are relative to the project root, including paths written inside nested files.
The mode selector is a session control; it does not write project configuration.

For example, `chapters/methods/experiment.tex` can begin with:

```tex
%% latexcoder:chapter-root chapters/methods.tex
```

The chapter entry `chapters/methods.tex` can contain:

```tex
%% latexcoder:root main.tex
%% latexcoder:template templates/chapter.tex
\chapter{Methods}
\input{chapters/methods/experiment.tex}
\input{chapters/methods/analysis.tex}
```

And `templates/chapter.tex`:

```tex
\documentclass{report}
% Load your packages and shared preamble here.
\begin{document}
%% latexcoder:content
\end{document}
```

Chapter mode from either the entry or one of its marked children compiles the
whole chapter, using the entry's template. The template must have exactly one
standalone `%% latexcoder:content` line. A temporary entry substitutes an `\input`
of the chapter there. Project source files are never rewritten by compilation.
An already complete chapter document can declare `%% latexcoder:template none`.

Top-level mode uses `%% latexcoder:root` on the current file or its chapter entry,
falling back to the project's existing main document setting. Top-level builds
do not wrap the root in a chapter template. If no chapter root is declared or
the chapter entry does not exist, Chapter root mode uses the top-level root
automatically. Template errors still produce diagnostics for the selected chapter.
Root and chapter-root declarations
may point to another entry; circular chains are rejected. A self-reference
identifies the entry itself. Configuration comments must precede document content;
duplicate declarations, missing templates, and missing top-level roots produce explicit errors.

Chapter PDFs, logs, and SyncTeX data are cached separately from full-project builds.
Downloads and source navigation use the displayed target. A failed chapter build
retains only that target's previous successful PDF. Templates can set counters,
load bibliography databases, and include any other project resources. Page and
chapter numbers and references to omitted chapters do not automatically match
the full document. Update path declarations when moving or renaming source files.

API clients can submit `POST /v1/compile` with
`{"mode":"chapter","file":"chapters/methods/experiment.tex"}`. Use the same
`mode=chapter&file=chapters%2Fmethods%2Fexperiment.tex` query on `/v1/build`,
`/v1/build/pdf`, `/v1/build/position`, and `/v1/build/source`. Read
`/v1/compile-target` with that query to inspect the resolved entry and template.
Existing requests without a mode or file retain their previous behavior.
