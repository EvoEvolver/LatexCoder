import { VersionHistory } from "./VersionHistory";
import {
  Archive, ArrowLeft, CheckCheck, Copy, Download, File, FileCheck2, FilePlus2,
  FileText, FolderKanban, FolderPlus, GitBranch, GitCommitHorizontal, GitMerge,
  GitPullRequestCreateArrow, Link, LogIn, LogOut, MessageSquarePlus,
  Maximize2, Monitor, Moon, MoreHorizontal, PanelLeft, Pencil, Play, RefreshCw, StretchHorizontal, StretchVertical, Sun, TerminalSquare, Trash2,
  ClipboardPaste, Redo2, Scissors, ScanText, Search, Settings, Undo2, Upload, UserPlus, UserRound, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import keycapUrl from "../../docs/images/l-keycap.svg?url";

const iconButton = "icon-button size-8 p-0";
const toolButton = "tool-button h-8 px-2.5 text-xs [&.active]:bg-primary [&.active]:text-primary-foreground";
const paneToolbar = "pane-toolbar flex h-11 min-h-11 shrink-0 items-center border-b bg-muted px-2.5";
const dialogClass = "fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100%-1.5rem))] overflow-auto rounded-lg border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/40";

const iconComponents = {
  "archive": Archive,
  "arrow-left": ArrowLeft,
  "check-check": CheckCheck,
  "copy": Copy,
  "clipboard-paste": ClipboardPaste,
  "download": Download,
  "file": File,
  "file-check-2": FileCheck2,
  "file-plus-2": FilePlus2,
  "file-text": FileText,
  "folder-kanban": FolderKanban,
  "folder-plus": FolderPlus,
  "git-branch": GitBranch,
  "git-commit-horizontal": GitCommitHorizontal,
  "git-merge": GitMerge,
  "git-pull-request-create-arrow": GitPullRequestCreateArrow,
  "link": Link,
  "log-in": LogIn,
  "log-out": LogOut,
  "message-square-plus": MessageSquarePlus,
  "maximize-2": Maximize2,
  "monitor": Monitor,
  "moon": Moon,
  "more-horizontal": MoreHorizontal,
  "panel-left": PanelLeft,
  "pencil": Pencil,
  "play": Play,
  "refresh-cw": RefreshCw,
  "redo-2": Redo2,
  "scissors": Scissors,
  "scan-text": ScanText,
  "search": Search,
  "settings": Settings,
  "stretch-horizontal": StretchHorizontal,
  "stretch-vertical": StretchVertical,
  "sun": Sun,
  "terminal-square": TerminalSquare,
  "trash-2": Trash2,
  "upload": Upload,
  "undo-2": Undo2,
  "user-plus": UserPlus,
  "user-round": UserRound,
  "x": X,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
} as const;

function Icon({ name }: { name: keyof typeof iconComponents }) {
  const Component = iconComponents[name];
  return <Component aria-hidden="true" />;
}

function IconButton({ id, icon, title, className = "", hidden = false }: { id: string; icon: keyof typeof iconComponents; title: string; className?: string; hidden?: boolean }) {
  return <Button id={id} className={cn(iconButton, className)} variant="ghost" size="icon" type="button" title={title} hidden={hidden}><Icon name={icon} /></Button>;
}

function DialogHeader({ title, subtitleId, closeId }: { title: string; subtitleId?: string; closeId: string }) {
  return (
    <header className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0"><strong className="text-base">{title}</strong>{subtitleId && <span id={subtitleId} className="ml-2 text-xs text-muted-foreground" />}</div>
      <IconButton id={closeId} icon="x" title="Close" />
    </header>
  );
}

function CopyRow({ inputId, buttonId, label }: { inputId: string; buttonId: string; label: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 max-sm:grid-cols-1">
      <Input id={inputId} className="font-mono text-xs" readOnly />
      <Button id={buttonId} variant="outline" type="button"><Icon name="copy" />{label}</Button>
    </div>
  );
}

function Brand({ prominent = false }: { prominent?: boolean }) {
  return (
    <span className={cn("brand inline-flex shrink-0 items-center text-foreground", prominent ? "flex-col gap-2.5" : "gap-2.5")}>
      <img src={keycapUrl} alt="" className={cn("shrink-0 object-contain", prominent ? "size-[5.5rem]" : "size-10")} />
      <strong className={cn("font-serif font-semibold", prominent ? "text-2xl" : "text-lg max-sm:hidden")}>LaTeX Coder</strong>
    </span>
  );
}

export function AppShell() {
  return (
    <>
      <div id="auth-page" className="auth-page grid min-h-dvh place-items-center bg-muted/60 p-6" hidden>
        <main className="w-full max-w-sm space-y-5">
          <div className="flex justify-center"><Brand prominent /></div>
          <Card>
            <CardHeader className="pb-4">
              <h1 id="auth-title" className="font-serif text-2xl font-semibold">Sign in</h1>
              <p id="auth-description" className="text-sm text-muted-foreground">Core team members can sign in to manage projects.</p>
            </CardHeader>
            <CardContent>
              <form id="auth-form" className="space-y-4">
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="auth-username">Username<Input id="auth-username" autoComplete="username" required /></label>
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="auth-password">Password<Input id="auth-password" type="password" autoComplete="current-password" minLength={10} required /></label>
                <p id="auth-error" className="auth-error text-sm text-destructive" hidden />
                <Button id="auth-submit" className="w-full" type="submit"><Icon name="log-in" /><span>Sign in</span></Button>
              </form>
            </CardContent>
          </Card>
        </main>
      </div>

      <div id="projects-page" className="projects-page min-h-dvh overflow-auto bg-muted/40" hidden>
        <header className="projects-header flex h-16 items-center justify-between border-b bg-background px-[max(1rem,calc((100vw-65rem)/2))]">
          <Brand />
          <div className="projects-account flex items-center gap-2">
            <Button id="account-button" variant="ghost" size="sm"><Icon name="user-round" /><span id="current-user" className="max-w-36 truncate max-sm:hidden" /></Button>
            <Button id="invite-user" variant="outline" size="sm"><Icon name="user-plus" /><span className="max-sm:hidden">Invite</span></Button>
            <Button id="new-project" size="sm"><Icon name="folder-plus" /><span>New project</span></Button>
            <IconButton id="logout-button" icon="log-out" title="Sign out" />
          </div>
        </header>
        <main className="projects-main mx-auto w-[min(calc(100%-2rem),65rem)] py-10">
          <div className="mb-5"><h1 className="font-serif text-3xl font-semibold">Projects</h1><p className="mt-1 text-sm text-muted-foreground">Open a paper or start a new one.</p></div>
          <div className="mb-3 flex items-center gap-2 max-sm:items-stretch">
            <label className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="project-search" className="pl-8" type="search" placeholder="Search titles and tags" aria-label="Search projects" /></label>
            <div className="segmented grid shrink-0 grid-cols-2 rounded-md border bg-muted p-0.5" role="group" aria-label="Project archive view"><Button id="projects-active" className="active h-8 px-3 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" type="button" aria-pressed="true">Active</Button><Button id="projects-archived" className="h-8 px-3 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" type="button" aria-pressed="false">Archived</Button></div>
          </div>
          <div id="project-tag-filters" className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="Filter projects by tag" hidden />
          <div id="project-list" className="project-list overflow-visible rounded-lg border bg-card" />
        </main>
      </div>

      <div id="editor-page" className="app-shell grid h-dvh min-w-80 grid-rows-[2.5rem_minmax(0,1fr)]" hidden>
        <header id="editor-topbar" className="topbar relative flex min-w-0 items-center border-b bg-background px-1.5 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
          <div id="topbar-actions" className="flex h-full shrink-0 items-center">
            <IconButton id="back-projects" icon="arrow-left" title="All projects" className="mr-0.5 size-7" />
            <img src={keycapUrl} alt="LaTeX Coder" className="mx-0.5 size-7 shrink-0 object-contain" />
            <nav className="flex h-full shrink-0 items-center" aria-label="Application menu">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button id="project-menu" className="h-7 rounded px-2 text-xs font-medium" variant="ghost">Project</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Project</DropdownMenuLabel>
                <DropdownMenuItem id="project-search-menu"><Icon name="search" />Search Project<DropdownMenuShortcut>Shift Ctrl F</DropdownMenuShortcut></DropdownMenuItem>
                <DropdownMenuItem id="project-settings"><Icon name="settings" />Project Settings…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem id="menu-download-project"><Icon name="archive" />Download ZIP</DropdownMenuItem>
                <DropdownMenuItem id="menu-open-trash"><Icon name="trash-2" />Recently Deleted…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button id="history-menu" className="h-7 gap-1.5 rounded px-2 text-xs font-medium" variant="ghost">History<span id="git-dirty" className="git-dirty size-1.5 rounded-full bg-amber-600" hidden /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Version control</DropdownMenuLabel>
                <DropdownMenuItem id="git-button"><Icon name="git-branch" />Version History…</DropdownMenuItem>
                <DropdownMenuItem id="history-save-checkpoint"><Icon name="git-commit-horizontal" />Save Checkpoint…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled className="text-[10px] text-muted-foreground">Live edits are checkpointed automatically</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button id="account-menu" className="h-7 rounded px-2 text-xs font-medium" variant="ghost">Account</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-60">
                <DropdownMenuLabel>Account</DropdownMenuLabel>
                <DropdownMenuItem id="editor-account-button" data-user-only><Icon name="user-round" />Account Settings…</DropdownMenuItem>
                <DropdownMenuItem id="editor-invite-user" data-user-only><Icon name="user-plus" />Invite Team Member…</DropdownMenuItem>
                <DropdownMenuItem id="editor-logout" data-user-only className="text-destructive focus:text-destructive"><Icon name="log-out" />Sign Out</DropdownMenuItem>
                <DropdownMenuItem id="editor-login" data-guest-only><Icon name="log-in" />Sign In</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button id="collaborate-menu" className="h-7 rounded px-2 text-xs font-medium" variant="ghost">Collaborate</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-64">
                <DropdownMenuLabel>Share this project</DropdownMenuLabel>
                <DropdownMenuItem id="share-project"><Icon name="link" />Browser Editing…</DropdownMenuItem>
                <DropdownMenuItem id="collaborate-agent"><Icon name="terminal-square" />Agent Editing…</DropdownMenuItem>
                <DropdownMenuItem id="collaborate-git"><Icon name="git-branch" />Git Access…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem id="collaborate-members"><Icon name="user-round" />Project Members…</DropdownMenuItem>
                <DropdownMenuItem id="collaborate-secrets"><Icon name="refresh-cw" />Access Secrets…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </nav>
          </div>

          <div id="project-title" className="project-title pointer-events-none absolute left-1/2 max-w-56 -translate-x-1/2 truncate px-3 text-center max-[760px]:hidden">
            <strong id="project-name" className="truncate text-[13px] font-semibold" />
          </div>
          <span id="active-file-label" className="sr-only">main.tex</span>
          <div id="topbar-status" className="ml-auto flex min-w-0 shrink-0 items-center gap-2 px-1">
            <span id="sync-state" className="whitespace-nowrap text-[10px] text-muted-foreground max-[520px]:hidden">Connecting</span>
            <div id="presence" className="presence flex min-w-0 max-[760px]:hidden" aria-label="Active collaborators" />
            <label id="guest-name-field" className="name-field flex h-7 w-32 items-center gap-1.5 rounded border bg-background px-1.5 max-lg:hidden"><Icon name="user-round" /><Input id="display-name" className="h-6 border-0 p-0 text-[10px] shadow-none focus-visible:ring-0" maxLength={28} aria-label="Display name" /></label>
          </div>
        </header>

        <main id="workspace" className="workspace grid min-h-0 w-full max-w-full grid-cols-[13rem_0.5rem_minmax(0,1fr)_0.5rem_minmax(0,46%)] overflow-hidden max-[760px]:!grid-cols-1">
          <aside id="files-pane" className="files-pane grid min-h-0 min-w-0 grid-rows-[2.75rem_minmax(0,1fr)_0.5rem_13.75rem] border-r bg-muted/35 max-[760px]:fixed max-[760px]:bottom-0 max-[760px]:left-0 max-[760px]:top-10 max-[760px]:z-30 max-[760px]:w-64 max-[760px]:-translate-x-full max-[760px]:bg-background max-[760px]:shadow-xl max-[760px]:transition-transform max-[760px]:[&.mobile-open]:translate-x-0">
            <input id="upload-input" type="file" multiple hidden />
            <div id="files-toolbar" className={cn(paneToolbar, "justify-between")}><IconButton id="close-files" icon="x" title="Close files" className="min-[761px]:hidden" /><IconButton id="files-menu" icon="more-horizontal" title="File actions" /></div>
            <div id="file-list" className="file-list min-h-0 flex-1 overflow-auto p-1.5" />
            <div id="structure-resize" role="separator" aria-label="Resize files and tree" aria-orientation="horizontal" tabIndex={0} className="group flex h-2 touch-none cursor-row-resize items-center justify-center border-y bg-muted/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="h-0.5 w-8 rounded bg-border group-hover:bg-primary" /></div>
            <section id="structure-pane" className="grid min-h-0 grid-rows-[2.25rem_minmax(0,1fr)] bg-background/55" aria-label="Document tree">
              <header className="flex items-center justify-between border-b px-2.5"><strong className="text-[11px] font-semibold uppercase text-muted-foreground">Tree</strong><div className="flex items-center"><IconButton id="open-structure" icon="maximize-2" title="Open TreeWriter" className="size-7" /><IconButton id="refresh-structure" icon="refresh-cw" title="Refresh tree" className="size-7" /></div></header>
              <nav id="structure-list" className="min-h-0 overflow-auto p-1.5" aria-label="Document tree entries"><p className="px-2 py-3 text-xs text-muted-foreground">Loading tree…</p></nav>
            </section>
          </aside>
          <div id="files-resize" role="separator" aria-label="Resize files" aria-orientation="vertical" tabIndex={0} className="group flex w-2 touch-none cursor-col-resize items-center justify-center bg-muted/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary max-[760px]:hidden"><span className="h-8 w-0.5 rounded bg-border group-hover:bg-primary" /></div>

          <section id="editor-pane" className="editor-pane relative grid min-h-0 min-w-0 grid-rows-[2.75rem_2.75rem_minmax(0,1fr)] border-r">
            <div id="file-tabs" className="file-tabs" role="tablist" aria-label="Open files" />
            <div className={cn(paneToolbar, "editor-toolbar justify-between")}>
              <div id="review-actions" className="review-actions flex items-center gap-1"><IconButton id="toggle-files" icon="panel-left" title="Hide files" /><Button id="add-comment" className={toolButton} variant="ghost" size="sm"><Icon name="message-square-plus" /><span className="max-[480px]:hidden">Comment</span></Button><Button id="suggest-edit" className={toolButton} variant="ghost" size="sm" aria-pressed="false"><Icon name="git-pull-request-create-arrow" /><span className="max-[480px]:hidden">Suggest</span></Button></div>
              <div className="editor-actions flex items-center gap-1"><div className="segmented grid grid-cols-2 rounded-md border bg-muted p-0.5 min-[761px]:hidden" role="group" aria-label="Mobile workspace view"><Button id="mobile-code" className="active h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" type="button" aria-pressed="true">Code</Button><Button id="open-pdf" className="h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" type="button" title="Show PDF preview" aria-controls="output-pane" aria-expanded="false" aria-pressed="false">PDF</Button></div><Button id="toggle-blame" className={toolButton} variant="ghost" size="sm" type="button" aria-pressed="false" title="Show who wrote each part"><Icon name="git-commit-horizontal" /><span className="max-[520px]:hidden">Blame</span></Button><Button id="toggle-review" data-output="review" variant="ghost" size="sm" className="h-8 min-w-8 px-1.5" aria-label="Review" aria-expanded="false" title="Review"><span id="review-count" className="rounded-full bg-amber-700 px-1.5 text-[9px] text-white">0</span></Button></div>
            </div>
            <div id="editor-body" className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden">
              <div className="relative grid min-h-0 min-w-0 overflow-hidden">
                <div id="editor" className="min-h-0 min-w-0 overflow-hidden" />
                <section id="structure-view" className="absolute inset-0 min-h-0 overflow-auto bg-background" aria-label="TreeWriter" hidden><div id="structure-document" className="mx-auto w-full max-w-4xl px-8 py-10 max-sm:px-5 max-sm:py-7" /></section>
            <div id="binary-view" className="binary-view absolute inset-0 grid min-h-0 grid-rows-[2.75rem_minmax(0,1fr)] bg-background" hidden>
              <div className="flex min-w-0 items-center justify-between border-b bg-muted/20 px-2.5"><div className="min-w-0"><strong id="binary-kind" className="text-xs">File preview</strong><span id="binary-status" className="ml-2 text-[10px] text-muted-foreground" /></div><div className="flex items-center"><IconButton id="file-preview-zoom-out" icon="zoom-out" title="Zoom out" /><IconButton id="file-preview-zoom-in" icon="zoom-in" title="Zoom in" /><Button id="binary-download" className={iconButton} variant="ghost" size="icon" title="Download file" asChild><a download><Icon name="download" /></a></Button></div></div>
              <div id="file-preview-viewport" className="relative min-h-0 min-w-0 overflow-auto bg-muted/40 p-4"><img id="image-preview" className="mx-auto block max-w-none shadow-sm" alt="" hidden /><div id="file-pdf-document" className="flex min-w-min flex-col items-center gap-4 [&_canvas]:block [&_canvas]:shrink-0 [&_canvas]:bg-white [&_canvas]:shadow-lg" hidden /><div id="binary-fallback" className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><Icon name="file" /><strong id="binary-name" /><Button id="binary-fallback-download" variant="outline" asChild><a download><Icon name="download" />Download</a></Button></div></div>
            </div>
              </div>
              <aside id="review-pane" className="grid min-h-0 min-w-0 grid-rows-[2.5rem_minmax(0,1fr)] border-l bg-muted/50" hidden>
                <div className="flex items-center justify-between border-b px-2.5"><strong className="text-xs">Review</strong><IconButton id="close-review" icon="x" title="Close review" /></div>
                <div className="min-h-0 overflow-auto p-2.5"><div id="review-list" /></div>
              </aside>
            </div>
          </section>
          <div id="output-resize" role="separator" aria-label="Resize editor and PDF" aria-orientation="vertical" tabIndex={0} className="group flex w-2 touch-none cursor-col-resize items-center justify-center bg-muted/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary max-[760px]:hidden"><span className="h-8 w-0.5 rounded bg-border group-hover:bg-primary" /></div>

          <section id="output-pane" className="output-pane grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-zinc-700 max-[760px]:hidden max-[760px]:[&.mobile-open]:fixed max-[760px]:[&.mobile-open]:bottom-0 max-[760px]:[&.mobile-open]:left-0 max-[760px]:[&.mobile-open]:right-0 max-[760px]:[&.mobile-open]:top-10 max-[760px]:[&.mobile-open]:z-30 max-[760px]:[&.mobile-open]:grid">
            <div className={cn(paneToolbar, "pane-header output-header justify-between max-[760px]:grid max-[760px]:h-auto max-[760px]:min-h-0 max-[760px]:grid-cols-1 max-[760px]:gap-1 max-[760px]:py-1")}>
              <div className="flex min-w-0 items-center gap-1.5 max-[760px]:w-full"><Button id="compile-button" className="h-8 w-28 shrink-0 px-3 text-xs" size="sm" type="button" title="Compile document"><Icon name="play" /><span>Compile</span></Button><div className="segmented grid w-32 grid-cols-2 rounded-md border bg-muted p-0.5 max-[760px]:w-44 max-[760px]:grid-cols-3" role="tablist"><Button id="close-output" className="h-7 px-2 text-xs min-[761px]:hidden [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" type="button" title="Show source editor" aria-pressed="false">Code</Button><Button className="active h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" data-output="pdf">PDF</Button><Button className="h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" data-output="log">Log <span id="log-error-count" className="text-red-700" hidden /></Button></div></div>
              <div className="flex items-center max-[760px]:w-full max-[760px]:justify-end"><IconButton id="pdf-fit-width" icon="stretch-horizontal" title="Fit page width" className="[&.active]:bg-accent [&.active]:text-primary" /><IconButton id="pdf-fit-page" icon="stretch-vertical" title="Fit whole page" className="[&.active]:bg-accent [&.active]:text-primary" /><IconButton id="pdf-zoom-out" icon="zoom-out" title="Zoom out" /><IconButton id="pdf-zoom-in" icon="zoom-in" title="Zoom in" /><Button id="pdf-download" className={iconButton} variant="ghost" size="icon" title="Download PDF" asChild><a download="paper.pdf"><Icon name="download" /></a></Button></div>
            </div>
            <div id="pdf-surface" className="relative min-h-0 min-w-0 overflow-hidden bg-zinc-700">
              <div id="pdf-view" className="pdf-view relative h-full min-h-0 min-w-0 overflow-auto [scrollbar-gutter:stable]"><div id="empty-output" className="empty-output absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-zinc-300"><Icon name="file-check-2" /><span id="pdf-status">No compiled PDF</span></div><div id="pdf-document" className="pdf-document flex min-w-min flex-col items-center gap-4 p-4 [&_canvas]:block [&_canvas]:shrink-0 [&_canvas]:bg-white [&_canvas]:shadow-lg" hidden /></div>
              <span id="pdf-freshness" role="status" className="absolute bottom-3 right-3 z-10 rounded-md border border-amber-400/50 bg-amber-50/95 px-2.5 py-1.5 text-[10px] font-medium text-amber-900 shadow-md backdrop-blur-sm dark:bg-amber-950/95 dark:text-amber-200" hidden>PDF outdated</span>
            </div>
            <div id="build-log" className="min-h-0 min-w-0 overflow-auto bg-background" hidden>
              <div id="build-errors" className="border-b p-3" hidden />
              <details className="p-3" open><summary className="cursor-pointer text-xs font-medium text-muted-foreground">Full compiler log</summary><pre id="build-output" className="m-0 whitespace-pre-wrap break-words py-3 font-mono text-xs leading-relaxed">No compilation yet.</pre></details>
            </div>
          </section>
        </main>
        <div id="selection-actions" className="selection-actions fixed z-30" hidden><Button id="selection-accept" className="selection-accept h-8 shadow-lg" size="sm"><Icon name="check-check" /><span>Accept suggestion</span></Button></div>
      </div>

      <div id="toast" className="toast fixed bottom-5 left-1/2 z-50 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-md bg-foreground px-3 py-2 text-sm text-background shadow-xl" role="status" hidden />
      <div id="pdf-context-menu" role="menu" aria-label="PDF actions" className="fixed z-40 w-44 rounded-md border bg-card p-1 text-card-foreground shadow-xl" hidden>
        <Button id="pdf-go-to-source" role="menuitem" variant="ghost" size="sm" className="w-full justify-start rounded-sm px-2 text-xs"><Icon name="file-check-2" />Go to source</Button>
      </div>
      <div id="editor-context-menu" role="menu" aria-label="Edit selection" className="fixed z-40 w-52 max-h-[calc(100dvh-1rem)] overflow-auto rounded-md border bg-card p-1 text-card-foreground shadow-xl" hidden>
        {([
          ["undo", "undo-2", "Undo"], ["redo", "redo-2", "Redo"],
          ["cut", "scissors", "Cut"], ["copy", "copy", "Copy"], ["paste", "clipboard-paste", "Paste"],
          ["delete", "trash-2", "Delete"], ["select-all", "scan-text", "Select all"],
          ["comment", "message-square-plus", "Add comment"], ["pdf", "file-check-2", "Go to PDF"],
        ] as const).map(([action, icon, label]) => <Button key={action} role="menuitem" data-editor-action={action} variant="ghost" size="sm" className={cn("w-full justify-start rounded-sm px-2 text-xs disabled:pointer-events-auto disabled:opacity-40", (action === "cut" || action === "comment") && "mt-1 border-t") }><Icon name={icon} />{label}</Button>)}
      </div>
      <div id="line-context-menu" role="menu" aria-label="Line actions" className="fixed z-40 w-60 rounded-md border bg-card p-1 text-card-foreground shadow-xl" hidden>
        <code id="line-context-reference" className="block truncate border-b px-2 py-2 text-[11px] text-muted-foreground" />
        <Button id="copy-line-reference" role="menuitem" variant="ghost" size="sm" className="mt-1 w-full justify-start rounded-sm px-2 text-xs"><Icon name="copy" />Copy path and line</Button>
      </div>
      <dialog id="search-dialog" className={cn(dialogClass, "w-[min(44rem,calc(100%-1.5rem))]")}><div className="p-5"><DialogHeader title="Search and replace" closeId="search-close" /><form id="search-form" className="flex flex-wrap items-center gap-2"><Input id="search-query" className="min-w-0 flex-1" aria-label="Search project" placeholder="Search project" maxLength={512} required /><Button type="submit" size="icon" title="Search"><Icon name="search" /></Button><div className="flex w-full gap-4 text-xs"><label className="flex items-center gap-2"><input id="search-case" type="checkbox" />Match case</label><label className="flex items-center gap-2"><input id="search-regex" type="checkbox" />Regular expression</label></div></form><div className="mt-3 flex flex-wrap gap-2"><Input id="replace-text" className="min-w-0 flex-1" aria-label="Replacement text" placeholder="Replacement text" /><select id="replace-scope" aria-label="Replace scope" className="h-9 rounded-md border bg-background px-2 text-xs"><option value="file">Current file</option><option value="project">Entire project</option></select><Button id="replace-preview" variant="outline" size="sm">Preview</Button><Button id="replace-apply" size="sm" hidden>Apply replacements</Button></div><p id="search-status" className="my-3 text-xs text-muted-foreground" role="status" /><div id="search-results" className="max-h-[55dvh] overflow-auto" /></div></dialog>
      <dialog id="settings-dialog" className={dialogClass}>
        <form id="settings-form" className="space-y-4 p-5">
          <DialogHeader title="Project settings" closeId="settings-close" />
          <label className="grid gap-1.5 text-sm" htmlFor="settings-main">Main document<select id="settings-main" className="h-9 min-w-0 rounded-md border bg-background px-3" /></label>
          <label className="grid gap-1.5 text-sm" htmlFor="settings-compiler">Compiler<select id="settings-compiler" className="h-9 rounded-md border bg-background px-3"><option value="auto">Automatic</option><option value="tectonic">Tectonic</option><option value="latexmk">latexmk</option></select></label>
          <label className="flex items-center gap-2 text-sm"><input id="settings-auto" type="checkbox" />Automatic compilation</label>
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button id="open-trash" type="button" variant="outline" size="sm"><Icon name="trash-2" />Recently deleted</Button>
            <Button id="download-project" variant="outline" size="sm" title="Download project ZIP" asChild><a><Icon name="archive" />Download ZIP</a></Button>
          </div>
          <footer className="flex justify-end"><Button type="submit">Save</Button></footer>
        </form>
      </dialog>
      <dialog id="trash-dialog" className={dialogClass}><div className="p-5"><DialogHeader title="Recently deleted" closeId="trash-close" /><div id="trash-list" className="max-h-[60dvh] overflow-auto" /></div></dialog>

      <dialog id="review-dialog" className={dialogClass}><form id="review-form" className="space-y-4 p-5"><header className="flex items-center justify-between"><strong id="dialog-title">Comment</strong><Button id="review-close" className={iconButton} variant="ghost" size="icon" type="button" title="Close"><Icon name="x" /></Button></header><label id="dialog-label" className="block text-sm font-medium" htmlFor="review-text">Comment</label><Textarea id="review-text" rows={5} required /><footer className="flex justify-end gap-2"><Button id="review-cancel" variant="outline" type="button">Cancel</Button><Button id="dialog-submit" type="submit">Insert</Button></footer></form></dialog>

      <dialog id="action-dialog" className={dialogClass}><form id="action-form" className="space-y-4 p-5"><DialogHeader title="" closeId="action-close" /><strong id="action-title" className="-mt-12 block pr-10 text-base" /><p id="action-message" className="text-sm text-muted-foreground" hidden /><label id="action-label" className="grid gap-1.5 text-sm font-medium" htmlFor="action-input" /><Input id="action-input" autoComplete="off" required /><footer className="flex justify-end gap-2"><Button id="action-cancel" variant="outline" type="button">Cancel</Button><Button id="action-submit" className="[&.danger-button]:bg-destructive [&.danger-button]:text-white" type="submit" /></footer></form></dialog>

      <dialog id="git-dialog" className={cn(dialogClass, "git-dialog w-[min(72rem,calc(100%-1.5rem))]")}>
        <div className="git-dialog-body flex max-h-[calc(100dvh-2rem)] flex-col gap-3 p-5">
          <DialogHeader title="Version history" subtitleId="git-summary" closeId="git-close" />
          <div id="git-conflict" className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-destructive bg-destructive/10 p-3" hidden>
            <strong className="text-sm">Merge conflict</strong><span id="git-conflict-branch" className="col-start-1 truncate font-mono text-xs text-muted-foreground" />
            <Button id="git-resolve" className="col-start-2 row-span-2 row-start-1" variant="outline" size="sm"><Icon name="git-merge" />Mark resolved</Button>
          </div>
          <details className="git-section border-t pt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Current changes (<span id="git-change-count">0</span>)</summary><div id="git-file-list" className="max-h-28 overflow-auto" /></details>
          <VersionHistory />
          <footer className="flex flex-wrap items-center gap-2">
            <IconButton id="git-refresh" icon="refresh-cw" title="Refresh history" />
            <label className="sr-only" htmlFor="git-message">Checkpoint name</label>
            <Input id="git-message" className="min-w-32 flex-1" maxLength={500} placeholder="Name a checkpoint (optional)" />
            <Button id="git-commit"><Icon name="git-commit-horizontal" />Save checkpoint</Button>
          </footer>
        </div>
      </dialog>

      <dialog id="access-dialog" className={dialogClass}><div className="p-5"><DialogHeader title="Browser sharing" subtitleId="access-project-name" closeId="access-close" /><p className="mb-4 text-xs text-muted-foreground">Create a personal link for browser access. Other project members have their own links.</p><div className="mb-4 grid grid-cols-2 rounded-md border bg-muted p-0.5" role="radiogroup" aria-label="Link permission"><Button id="share-view" data-share-mode="view" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm">View</Button><Button id="share-edit" data-share-mode="edit" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm">Edit</Button></div><section className="space-y-2 border-t py-4"><label id="share-link-label" className="text-sm font-medium" htmlFor="share-link">Edit link</label><p id="browser-editing-description" className="text-xs text-muted-foreground" /><CopyRow inputId="share-link" buttonId="copy-share-link" label="Copy" /></section><footer className="flex justify-end"><Button id="access-done">Done</Button></footer></div></dialog>

      <dialog id="agent-access-dialog" className={dialogClass}><div className="p-5"><DialogHeader title="Agent editing" closeId="agent-access-close" /><div className="mb-4 grid grid-cols-2 rounded-md border bg-muted p-0.5" role="radiogroup" aria-label="Agent editing mode"><Button id="agent-direct" data-agent-mode="direct" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm">Direct</Button><Button id="agent-propose" data-agent-mode="propose" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm">Propose</Button></div><section className="space-y-2 border-t py-4"><label id="agent-command-label" className="text-sm font-medium" htmlFor="agent-command">Direct editing</label><p id="agent-editing-description" className="text-xs text-muted-foreground" /><CopyRow inputId="agent-command" buttonId="copy-agent-link" label="Copy" /></section><footer className="flex justify-end"><Button id="agent-access-done">Done</Button></footer></div></dialog>

      <dialog id="git-access-dialog" className={dialogClass}><div className="p-5"><DialogHeader title="Git access" closeId="git-access-close" /><p className="mb-4 text-xs text-muted-foreground">Clone with your personal Git URL. Pushed commits synchronize into the live document automatically.</p><CopyRow inputId="clone-command" buttonId="copy-clone-command" label="Copy" /><footer className="mt-5 flex justify-end"><Button id="git-access-done">Done</Button></footer></div></dialog>

      <dialog id="collaborator-dialog" className={dialogClass}><div className="p-5"><DialogHeader title="Project members" closeId="collaborator-close" /><div id="collaborator-list" className="space-y-1 text-xs" /><footer className="mt-5 flex justify-end"><Button id="collaborator-done">Done</Button></footer></div></dialog>

      <dialog id="access-secret-dialog" className={dialogClass}><div className="p-5"><DialogHeader title="Access secrets" closeId="access-secret-close" /><p id="rotate-secret-warning" className="mb-4 text-xs text-muted-foreground">Rotating your secrets immediately invalidates your previous View, Edit, Agent editing, and Git links, and signs out their guest sessions. Other registered collaborators and their links keep working.</p><Button id="rotate-share-secret" variant="outline" type="button"><Icon name="refresh-cw" />Rotate my secrets</Button><footer className="mt-5 flex justify-end"><Button id="access-secret-done">Done</Button></footer></div></dialog>

      <dialog id="account-dialog" className={dialogClass}>
        <form id="account-form" className="space-y-4 p-5">
          <DialogHeader title="Account" closeId="account-close" />
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="account-username">Username<Input id="account-username" readOnly /></label>
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="account-display-name">Display name<Input id="account-display-name" maxLength={28} required /></label>
          <p className="text-xs text-muted-foreground">This name appears to collaborators in presence, comments, and suggestions.</p>
          <section className="space-y-2 border-t pt-4">
            <strong className="text-sm font-medium">Appearance</strong>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Color theme">
              <Button data-theme-option="system" variant="outline" type="button" role="radio" className="h-auto flex-col gap-2 py-3"><Icon name="monitor" />System</Button>
              <Button data-theme-option="light" variant="outline" type="button" role="radio" className="h-auto flex-col gap-2 py-3"><Icon name="sun" />Light</Button>
              <Button data-theme-option="dark" variant="outline" type="button" role="radio" className="h-auto flex-col gap-2 py-3"><Icon name="moon" />Dark</Button>
            </div>
          </section>
          <footer className="flex justify-between gap-2"><Button id="account-logout" variant="outline" type="button"><Icon name="log-out" />Sign out</Button><div className="flex gap-2"><Button id="account-cancel" variant="outline" type="button">Cancel</Button><Button id="account-save" type="submit">Save</Button></div></footer>
        </form>
      </dialog>

      <dialog id="invite-dialog" className={dialogClass}><div className="access-dialog-body p-5"><DialogHeader title="Invite a team member" closeId="invite-close" /><section className="space-y-2 border-t py-4"><label className="text-sm font-medium" htmlFor="invite-link">Registration link</label><p className="text-xs text-muted-foreground">This single-use link expires in seven days. The new user can manage projects and invite others.</p><CopyRow inputId="invite-link" buttonId="copy-invite-link" label="Copy" /></section><footer className="flex justify-end gap-2"><Button id="invite-regenerate" variant="outline"><Icon name="refresh-cw" />New link</Button><Button id="invite-done">Done</Button></footer></div></dialog>
    </>
  );
}
