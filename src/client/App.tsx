import { VersionHistory } from "./VersionHistory";
import {
  Archive, ArrowLeft, CheckCheck, Copy, Download, File, FileCheck2, FilePlus2,
  FileText, FolderKanban, FolderPlus, GitBranch, GitCommitHorizontal, GitMerge,
  GitPullRequestCreateArrow, Link, LogIn, LogOut, MessageSquarePlus,
  Monitor, Moon, MoreHorizontal, PanelLeft, Pencil, Play, RefreshCw, Sun, TerminalSquare, Trash2,
  ClipboardPaste, Redo2, Scissors, ScanText, Search, Settings, Undo2, Upload, UserPlus, UserRound, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const iconButton = "icon-button size-8 p-0";
const toolButton = "tool-button h-8 px-2.5 text-xs [&.active]:bg-primary [&.active]:text-primary-foreground";
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

function ThemeButton({ id, className = "" }: { id: string; className?: string }) {
  return <Button id={id} className={cn(iconButton, "theme-trigger", className)} variant="ghost" size="icon" type="button" title="Appearance"><Monitor className="theme-system" /><Sun className="theme-light" /><Moon className="theme-dark" /></Button>;
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

function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand inline-flex shrink-0 items-center gap-2 text-primary"><Icon name="file-text" /><strong className={cn("font-serif text-lg", compact && "max-sm:hidden")}>LaTeX Coder</strong></span>;
}

export function AppShell() {
  return (
    <>
      <div id="auth-page" className="auth-page grid min-h-dvh place-items-center bg-muted/60 p-6" hidden>
        <ThemeButton id="auth-theme" className="fixed right-4 top-4" />
        <main className="w-full max-w-sm space-y-5">
          <div className="flex justify-center"><Brand /></div>
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
            <ThemeButton id="projects-theme" />
          </div>
        </header>
        <main className="projects-main mx-auto w-[min(calc(100%-2rem),65rem)] py-10">
          <div className="mb-5"><h1 className="font-serif text-3xl font-semibold">Projects</h1><p className="mt-1 text-sm text-muted-foreground">Open a paper or start a new one.</p></div>
          <div id="project-list" className="project-list overflow-visible rounded-lg border bg-card" />
        </main>
      </div>

      <div id="editor-page" className="app-shell grid h-dvh min-w-80 grid-rows-[3.5rem_minmax(0,1fr)]" hidden>
        <header className="topbar flex min-w-0 items-center gap-2 border-b bg-background px-3">
          <Button id="back-projects" className="brand-button gap-2 px-1" variant="ghost" title="All projects"><Icon name="arrow-left" /><Brand compact /></Button>
          <div className="project-context flex min-w-28 max-w-52 items-center gap-2 border-l pl-3 max-md:hidden"><Icon name="folder-kanban" /><strong id="project-name" className="truncate text-xs" /></div>
          <div className="document-name flex min-w-0 flex-1 flex-col"><span id="active-file-label" className="truncate text-sm font-medium">main.tex</span><span id="sync-state" className="text-[10px] text-muted-foreground">Connecting</span></div>
          <div id="presence" className="presence flex min-w-0" aria-label="Active collaborators" />
          <label id="guest-name-field" className="name-field flex h-9 w-36 items-center gap-2 rounded-md border bg-background px-2 max-lg:hidden"><Icon name="user-round" /><Input id="display-name" className="h-7 border-0 p-0 text-xs shadow-none focus-visible:ring-0" maxLength={28} aria-label="Display name" /></label>
          <Button id="editor-account-button" variant="outline" size="sm" hidden><Icon name="user-round" /><span id="editor-account-name" className="max-w-28 truncate max-lg:hidden" /></Button>
          <Button id="editor-login" variant="outline" size="sm" hidden><Icon name="log-in" /><span className="max-sm:hidden">Sign in</span></Button>
          <Button id="share-project" variant="outline" size="sm"><Icon name="link" /><span className="max-sm:hidden">Collaborate</span></Button>
          <Button id="git-button" variant="outline" size="sm"><Icon name="git-branch" /><span className="max-sm:hidden">History</span><span id="git-dirty" className="git-dirty size-1.5 rounded-full bg-amber-600" hidden /></Button>
          <IconButton id="project-settings" icon="settings" title="Project settings" />
          <ThemeButton id="editor-theme" />
        </header>

        <main id="workspace" className="workspace grid min-h-0 w-full max-w-full grid-cols-[13rem_0.5rem_minmax(0,1fr)_0.5rem_minmax(0,46%)] overflow-hidden max-[760px]:!grid-cols-1">
          <aside id="files-pane" className="files-pane flex min-h-0 min-w-0 flex-col border-r bg-muted/35 max-[760px]:fixed max-[760px]:inset-y-14 max-[760px]:left-0 max-[760px]:z-30 max-[760px]:w-64 max-[760px]:-translate-x-full max-[760px]:bg-background max-[760px]:shadow-xl max-[760px]:transition-transform max-[760px]:[&.mobile-open]:translate-x-0">
            <div className="pane-header flex min-h-11 shrink-0 flex-wrap items-center justify-between border-b px-1.5"><strong id="files-heading" className="text-[11px] uppercase text-muted-foreground">Files</strong><div id="files-actions" className="flex min-w-0 flex-wrap items-center gap-0.5">
              <IconButton id="project-search" icon="search" title="Search project" />
              <IconButton id="new-file" icon="file-plus-2" title="New file" />
              <IconButton id="new-folder" icon="folder-plus" title="New folder" />
              <IconButton id="upload-file" icon="upload" title="Upload" />
              <input id="upload-input" type="file" multiple hidden />
            </div></div>
            <div id="file-list" className="file-list min-h-0 flex-1 overflow-auto p-1.5" />
          </aside>
          <div id="files-resize" role="separator" aria-label="Resize files" aria-orientation="vertical" tabIndex={0} className="group flex w-2 touch-none cursor-col-resize items-center justify-center bg-muted/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary max-[760px]:hidden"><span className="h-8 w-0.5 rounded bg-border group-hover:bg-primary" /></div>

          <section className="editor-pane relative grid min-h-0 min-w-0 grid-rows-[2.75rem_minmax(0,1fr)] border-r">
            <div className="editor-toolbar flex items-center justify-between border-b bg-muted/20 px-2">
              <div id="review-actions" className="review-actions flex items-center gap-1"><IconButton id="toggle-files" icon="panel-left" title="Hide files" /><Button id="add-comment" className={toolButton} variant="ghost" size="sm"><Icon name="message-square-plus" />Comment</Button><Button id="suggest-edit" className={toolButton} variant="ghost" size="sm" aria-pressed="false"><Icon name="git-pull-request-create-arrow" /><span>Suggest</span></Button></div>
              <div className="editor-actions flex items-center gap-1"><IconButton id="editor-search" icon="search" title="Search project" /><Button id="toggle-review" data-output="review" variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs" aria-expanded="false" title="Review"><Icon name="message-square-plus" />Review <span id="review-count" className="rounded-full bg-amber-700 px-1.5 text-[9px] text-white">0</span></Button></div>
            </div>
            <div id="editor-body" className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden">
              <div className="relative grid min-h-0 min-w-0 overflow-hidden">
                <div id="editor" className="min-h-0 min-w-0 overflow-hidden" />
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
          <div id="output-resize" role="separator" aria-label="Resize editor and output" aria-orientation="vertical" tabIndex={0} className="group flex w-2 touch-none cursor-col-resize items-center justify-center bg-muted/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary max-[760px]:hidden"><span className="h-8 w-0.5 rounded bg-border group-hover:bg-primary" /></div>

          <section id="output-pane" className="output-pane grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-zinc-700 max-[760px]:hidden max-[760px]:[&.mobile-open]:fixed max-[760px]:[&.mobile-open]:inset-0 max-[760px]:[&.mobile-open]:z-30 max-[760px]:[&.mobile-open]:grid">
            <div className="pane-header output-header flex min-h-11 flex-wrap items-center justify-between border-b bg-muted px-2.5">
              <div className="flex min-w-0 items-center gap-1.5"><Button id="compile-button" className="h-8 w-28 shrink-0 px-3 text-xs" size="sm" type="button" title="Compile document"><Icon name="play" /><span>Compile</span></Button><div className="segmented grid w-32 grid-cols-2 rounded-md border bg-muted p-0.5" role="tablist"><Button className="active h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" data-output="pdf">PDF</Button><Button className="h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" data-output="log">Log <span id="log-error-count" className="text-red-700" hidden /></Button></div></div>
              <div className="flex items-center"><IconButton id="pdf-zoom-out" icon="zoom-out" title="Zoom out" /><IconButton id="pdf-zoom-in" icon="zoom-in" title="Zoom in" /><Button id="pdf-download" className={iconButton} variant="ghost" size="icon" title="Download PDF" asChild><a download="paper.pdf"><Icon name="download" /></a></Button><IconButton id="close-output" icon="x" title="Back to editor" className="mobile-output-close lg:hidden" /></div>
              <span id="pdf-freshness" className="w-full pb-1 text-[10px] text-muted-foreground" hidden />
            </div>
            <div id="pdf-view" className="pdf-view relative min-h-0 min-w-0 overflow-auto bg-zinc-700"><div id="empty-output" className="empty-output absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-zinc-300"><Icon name="file-check-2" /><span id="pdf-status">No compiled PDF</span></div><div id="pdf-document" className="pdf-document flex min-w-min flex-col items-center gap-4 p-4 [&_canvas]:block [&_canvas]:shrink-0 [&_canvas]:bg-white [&_canvas]:shadow-lg" hidden /></div>
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
      <dialog id="appearance-dialog" className={dialogClass}><div className="p-5"><DialogHeader title="Appearance" closeId="appearance-close" /><div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Color theme"><Button data-theme-option="system" variant="outline" type="button" role="radio" className="h-auto flex-col gap-2 py-3"><Icon name="monitor" />System</Button><Button data-theme-option="light" variant="outline" type="button" role="radio" className="h-auto flex-col gap-2 py-3"><Icon name="sun" />Light</Button><Button data-theme-option="dark" variant="outline" type="button" role="radio" className="h-auto flex-col gap-2 py-3"><Icon name="moon" />Dark</Button></div></div></dialog>
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

      <dialog id="access-dialog" className={dialogClass}><div className="access-dialog-body p-5"><DialogHeader title="Collaborate" subtitleId="access-project-name" closeId="access-close" /><p className="mb-4 text-xs text-muted-foreground">These are your personal links. Every registered project member has a different secret.</p><section className="space-y-2 border-t py-4"><label className="text-sm font-medium" htmlFor="share-link">Browser editing</label><p id="browser-editing-description" className="text-xs text-muted-foreground">A signed-in user who opens this link joins the project as a collaborator. Guests can edit the project without creating an account.</p><CopyRow inputId="share-link" buttonId="copy-share-link" label="Copy" /></section><section id="agent-editing-section" className="space-y-2 border-t py-4"><label className="text-sm font-medium" htmlFor="agent-command">Agent editing</label><p className="text-xs text-muted-foreground">Copy this command into your agent chat and ask the agent to run it. The response tells the agent how to inspect and edit the project.</p><CopyRow inputId="agent-command" buttonId="copy-agent-link" label="Copy" /></section><section id="clone-section" className="space-y-2 border-t py-4"><label className="text-sm font-medium" htmlFor="clone-command">Git clone and push</label><p className="text-xs text-muted-foreground">Use your personal Git URL as the remote. Pushed commits synchronize into the live document automatically.</p><CopyRow inputId="clone-command" buttonId="copy-clone-command" label="Copy" /></section><section className="space-y-2 border-t py-4"><strong className="text-sm font-medium">Project members</strong><div id="collaborator-list" className="space-y-1 text-xs" /></section><section className="flex items-center justify-between gap-4 border-t py-4 max-sm:items-start"><div className="space-y-1"><strong className="text-sm font-medium">Your access secret</strong><p id="rotate-secret-warning" className="text-xs text-muted-foreground">Rotating your secret immediately invalidates links containing your previous secret and signs out their guest sessions. Other registered collaborators and their links keep working.</p></div><Button id="rotate-share-secret" className="shrink-0" variant="outline" type="button"><Icon name="refresh-cw" />Rotate my secret</Button></section><footer className="flex justify-end gap-2"><Button id="access-download" variant="outline" asChild><a><Icon name="archive" />Download ZIP</a></Button><Button id="access-done">Done</Button></footer></div></dialog>

      <dialog id="account-dialog" className={dialogClass}><form id="account-form" className="space-y-4 p-5"><DialogHeader title="Account" closeId="account-close" /><label className="grid gap-1.5 text-sm font-medium" htmlFor="account-username">Username<Input id="account-username" readOnly /></label><label className="grid gap-1.5 text-sm font-medium" htmlFor="account-display-name">Display name<Input id="account-display-name" maxLength={28} required /></label><p className="text-xs text-muted-foreground">This name appears to collaborators in presence, comments, and suggestions.</p><footer className="flex justify-between gap-2"><Button id="account-logout" variant="outline" type="button"><Icon name="log-out" />Sign out</Button><div className="flex gap-2"><Button id="account-cancel" variant="outline" type="button">Cancel</Button><Button id="account-save" type="submit">Save</Button></div></footer></form></dialog>

      <dialog id="invite-dialog" className={dialogClass}><div className="access-dialog-body p-5"><DialogHeader title="Invite a team member" closeId="invite-close" /><section className="space-y-2 border-t py-4"><label className="text-sm font-medium" htmlFor="invite-link">Registration link</label><p className="text-xs text-muted-foreground">This single-use link expires in seven days. The new user can manage projects and invite others.</p><CopyRow inputId="invite-link" buttonId="copy-invite-link" label="Copy" /></section><footer className="flex justify-end gap-2"><Button id="invite-regenerate" variant="outline"><Icon name="refresh-cw" />New link</Button><Button id="invite-done">Done</Button></footer></div></dialog>
    </>
  );
}
