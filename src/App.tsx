import {
  Archive, ArrowLeft, CheckCheck, Copy, Download, File, FileCheck2, FilePlus2,
  FileText, FolderKanban, FolderPlus, GitBranch, GitCommitHorizontal, GitMerge,
  GitPullRequestCreateArrow, Link, LogIn, LogOut, MessageSquarePlus,
  MoreHorizontal, PanelLeft, Pencil, Play, RefreshCw, TerminalSquare, Trash2,
  Upload, UserPlus, UserRound, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
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
  "more-horizontal": MoreHorizontal,
  "panel-left": PanelLeft,
  "pencil": Pencil,
  "play": Play,
  "refresh-cw": RefreshCw,
  "terminal-square": TerminalSquare,
  "trash-2": Trash2,
  "upload": Upload,
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

function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand inline-flex shrink-0 items-center gap-2 text-primary"><Icon name="file-text" /><strong className={cn("font-serif text-lg", compact && "max-sm:hidden")}>LaTeX Coder</strong></span>;
}

export function AppShell() {
  return (
    <>
      <div id="auth-page" className="auth-page grid min-h-dvh place-items-center bg-muted/60 p-6" hidden>
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
            <span id="current-user" className="max-w-36 truncate text-xs text-muted-foreground max-sm:hidden" />
            <Button id="invite-user" variant="outline" size="sm"><Icon name="user-plus" /><span className="max-sm:hidden">Invite</span></Button>
            <Button id="new-project" size="sm"><Icon name="folder-plus" /><span>New project</span></Button>
            <IconButton id="logout-button" icon="log-out" title="Sign out" />
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
          <label className="name-field flex h-9 w-36 items-center gap-2 rounded-md border bg-background px-2 max-lg:hidden"><Icon name="user-round" /><Input id="display-name" className="h-7 border-0 p-0 text-xs shadow-none focus-visible:ring-0" maxLength={28} aria-label="Display name" /></label>
          <Button id="editor-login" variant="outline" size="sm" hidden><Icon name="log-in" /><span className="max-sm:hidden">Sign in</span></Button>
          <Button id="share-project" variant="outline" size="sm"><Icon name="link" /><span className="max-sm:hidden">Share</span></Button>
          <Button id="download-project" variant="ghost" size="icon" title="Download project ZIP" asChild><a><Icon name="archive" /></a></Button>
          <Button id="compile-button" size="sm"><Icon name="play" /><span className="max-sm:hidden">Compile</span></Button>
        </header>

        <main className="workspace grid min-h-0 w-full max-w-full grid-cols-[13rem_minmax(21rem,1fr)_minmax(22rem,46%)] overflow-hidden max-[760px]:grid-cols-1">
          <aside id="files-pane" className="files-pane flex min-h-0 min-w-0 flex-col border-r bg-muted/35 max-[760px]:fixed max-[760px]:inset-y-14 max-[760px]:left-0 max-[760px]:z-30 max-[760px]:w-64 max-[760px]:-translate-x-full max-[760px]:bg-background max-[760px]:shadow-xl max-[760px]:transition-transform max-[760px]:[&.mobile-open]:translate-x-0">
            <div className="pane-header flex h-11 items-center justify-between border-b px-2.5"><strong className="text-[11px] uppercase text-muted-foreground">Files</strong><div className="flex items-center gap-0.5">
              <IconButton id="new-file" icon="file-plus-2" title="New file" />
              <IconButton id="upload-file" icon="upload" title="Upload" />
              <input id="upload-input" type="file" multiple hidden />
            </div></div>
            <div id="file-list" className="file-list min-h-0 flex-1 overflow-auto p-1.5" />
          </aside>

          <section className="editor-pane relative grid min-h-0 min-w-0 grid-rows-[2.75rem_minmax(0,1fr)] border-r">
            <div className="editor-toolbar flex items-center justify-between border-b bg-muted/20 px-2">
              <div className="review-actions flex items-center gap-1"><Button id="add-comment" className={toolButton} variant="ghost" size="sm"><Icon name="message-square-plus" />Comment</Button><Button id="suggest-edit" className={toolButton} variant="ghost" size="sm" aria-pressed="false"><Icon name="git-pull-request-create-arrow" /><span>Suggest</span></Button></div>
              <div className="editor-actions flex items-center gap-1"><Button id="clone-button" className={toolButton} variant="ghost" size="sm"><Icon name="copy" /><span>Clone</span></Button><Button id="git-button" className={toolButton} variant="ghost" size="sm"><Icon name="git-branch" /><span>Git</span><span id="git-dirty" className="git-dirty size-1.5 rounded-full bg-amber-600" hidden /></Button><IconButton id="toggle-files" icon="panel-left" title="Files" className="mobile-files lg:hidden" /></div>
            </div>
            <div id="editor" className="min-h-0 min-w-0 overflow-hidden" />
            <div id="binary-view" className="binary-view absolute inset-x-0 bottom-0 top-11 flex flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground" hidden><Icon name="file" /><strong id="binary-name" /><Button id="binary-download" variant="outline" asChild><a>Download</a></Button></div>
            <div id="build-log" className="build-log absolute inset-x-0 bottom-0 z-10 grid grid-rows-[2.5rem_minmax(6rem,34vh)] border-t bg-zinc-950 text-zinc-100 shadow-2xl" hidden><div className="pane-header flex items-center justify-between border-b border-zinc-800 px-2.5"><strong className="text-xs">Build log</strong><IconButton id="close-log" icon="x" title="Close" /></div><pre id="build-output" className="m-0 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed" /></div>
          </section>

          <section id="output-pane" className="output-pane grid min-h-0 min-w-0 grid-rows-[2.75rem_minmax(0,1fr)] bg-zinc-700 max-[760px]:hidden max-[760px]:[&.mobile-open]:fixed max-[760px]:[&.mobile-open]:inset-0 max-[760px]:[&.mobile-open]:z-30 max-[760px]:[&.mobile-open]:grid">
            <div className="pane-header output-header flex items-center justify-between border-b bg-muted px-2.5">
              <div className="segmented grid w-40 grid-cols-2 rounded-md border bg-muted p-0.5" role="tablist"><Button className="active h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" data-output="pdf">PDF</Button><Button className="h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" data-output="review">Review <span id="review-count" className="rounded-full bg-amber-700 px-1.5 text-[9px] text-white">0</span></Button></div>
              <div className="flex items-center"><IconButton id="pdf-zoom-out" icon="zoom-out" title="Zoom out" /><IconButton id="pdf-zoom-in" icon="zoom-in" title="Zoom in" /><Button id="pdf-download" className={iconButton} variant="ghost" size="icon" title="Download PDF" asChild><a download="paper.pdf"><Icon name="download" /></a></Button><IconButton id="show-log" icon="terminal-square" title="Build log" /><IconButton id="close-output" icon="x" title="Back to editor" className="mobile-output-close lg:hidden" /></div>
            </div>
            <div id="pdf-view" className="pdf-view relative min-h-0 min-w-0 overflow-auto bg-zinc-700"><div id="empty-output" className="empty-output absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-zinc-300"><Icon name="file-check-2" /><span id="pdf-status">No compiled PDF</span></div><div id="pdf-document" className="pdf-document flex min-w-min flex-col items-center gap-4 p-4 [&_canvas]:block [&_canvas]:shrink-0 [&_canvas]:bg-white [&_canvas]:shadow-lg" hidden /></div>
            <div id="review-pane" className="review-pane min-h-0 overflow-auto bg-muted/50 p-2.5" hidden><div id="review-list" /></div>
          </section>
        </main>
        <div id="selection-actions" className="selection-actions fixed z-30" hidden><Button id="selection-accept" className="selection-accept h-8 shadow-lg" size="sm"><Icon name="check-check" /><span>Accept suggestion</span></Button></div>
      </div>

      <div id="toast" className="toast fixed bottom-5 left-1/2 z-50 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-md bg-foreground px-3 py-2 text-sm text-background shadow-xl" role="status" hidden />

      <dialog id="review-dialog" className={dialogClass}><form id="review-form" method="dialog" className="space-y-4 p-5"><header className="flex items-center justify-between"><strong id="dialog-title">Comment</strong><Button className={iconButton} variant="ghost" size="icon" value="cancel" title="Close"><Icon name="x" /></Button></header><label id="dialog-label" className="block text-sm font-medium" htmlFor="review-text">Comment</label><Textarea id="review-text" rows={5} required /><footer className="flex justify-end gap-2"><Button variant="outline" value="cancel">Cancel</Button><Button id="dialog-submit" value="default">Insert</Button></footer></form></dialog>

      <dialog id="action-dialog" className={dialogClass}><form id="action-form" className="space-y-4 p-5"><DialogHeader title="" closeId="action-close" /><strong id="action-title" className="-mt-12 block pr-10 text-base" /><p id="action-message" className="text-sm text-muted-foreground" hidden /><label id="action-label" className="grid gap-1.5 text-sm font-medium" htmlFor="action-input" /><Input id="action-input" autoComplete="off" required /><footer className="flex justify-end gap-2"><Button id="action-cancel" variant="outline" type="button">Cancel</Button><Button id="action-submit" className="[&.danger-button]:bg-destructive [&.danger-button]:text-white" type="submit" /></footer></form></dialog>

      <dialog id="git-dialog" className={cn(dialogClass, "git-dialog w-[min(42rem,calc(100%-1.5rem))]")}><div className="git-dialog-body flex max-h-[calc(100dvh-2rem)] flex-col p-5"><DialogHeader title="Git" subtitleId="git-summary" closeId="git-close" /><div id="git-conflict" className="git-conflict mb-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-l-4 border-destructive bg-destructive/10 p-3" hidden><strong className="text-sm">Merge conflict</strong><span id="git-conflict-branch" className="col-start-1 truncate font-mono text-xs text-muted-foreground" /><Button id="git-resolve" className="col-start-2 row-span-2 row-start-1" variant="outline" size="sm"><Icon name="git-merge" />Mark resolved</Button></div><section className="git-section border-t py-3"><div className="mb-2 flex justify-between text-xs font-medium text-muted-foreground"><strong>Changes</strong><span id="git-change-count">0</span></div><div id="git-file-list" className="git-file-list max-h-36 overflow-auto" /></section><section className="git-section border-t py-3"><label className="grid gap-1.5 text-xs font-medium text-muted-foreground" htmlFor="git-message">Commit message<Input id="git-message" maxLength={500} placeholder="Describe this checkpoint" /></label></section><section className="git-section border-t py-3"><label className="grid gap-1.5 text-xs font-medium text-muted-foreground" htmlFor="git-ref">Incoming ref<Input id="git-ref" maxLength={200} placeholder="Configured upstream" /></label></section><section className="git-section min-h-0 border-t py-3"><strong className="mb-2 block text-xs text-muted-foreground">History</strong><div id="git-history" className="git-history max-h-36 overflow-auto" /></section><footer className="mt-3 flex justify-between"><IconButton id="git-refresh" icon="refresh-cw" title="Refresh" /><div className="flex gap-2"><Button id="git-sync" variant="outline"><Icon name="git-merge" />Sync</Button><Button id="git-commit"><Icon name="git-commit-horizontal" />Commit all</Button></div></footer></div></dialog>

      <dialog id="access-dialog" className={dialogClass}><div className="access-dialog-body p-5"><DialogHeader title="Share project" subtitleId="access-project-name" closeId="access-close" /><section className="space-y-2 border-t py-4"><label className="text-sm font-medium" htmlFor="share-link">Editable link</label><p className="text-xs text-muted-foreground">Anyone with this link can open and edit the project.</p><CopyRow inputId="share-link" buttonId="copy-share-link" label="Copy" /></section><section id="clone-section" className="space-y-2 border-t py-4"><label className="text-sm font-medium" htmlFor="clone-command">Git clone</label><p className="text-xs text-muted-foreground">Clone the committed history over read-only Git HTTP.</p><CopyRow inputId="clone-command" buttonId="copy-clone-command" label="Copy" /></section><footer className="flex justify-end gap-2"><Button id="access-download" variant="outline" asChild><a><Icon name="archive" />Download ZIP</a></Button><Button id="access-done">Done</Button></footer></div></dialog>

      <dialog id="invite-dialog" className={dialogClass}><div className="access-dialog-body p-5"><DialogHeader title="Invite a team member" closeId="invite-close" /><section className="space-y-2 border-t py-4"><label className="text-sm font-medium" htmlFor="invite-link">Registration link</label><p className="text-xs text-muted-foreground">This single-use link expires in seven days. The new user can manage projects and invite others.</p><CopyRow inputId="invite-link" buttonId="copy-invite-link" label="Copy" /></section><footer className="flex justify-end gap-2"><Button id="invite-regenerate" variant="outline"><Icon name="refresh-cw" />New link</Button><Button id="invite-done">Done</Button></footer></div></dialog>
    </>
  );
}
