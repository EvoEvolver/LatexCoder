import { LanguageSelector, Localized, Message } from './Localized';
import { VersionHistory } from "./VersionHistory";
import { CompileTargetMenu } from "./CompileTargetMenu";
import {
  Archive, ArrowLeft, CheckCheck, ChevronLeft, ChevronRight, Copy, Download, File, FileCheck2, FilePlus2,
  FileText, FolderKanban, FolderPlus, GitBranch, GitCommitHorizontal, GitMerge,
  GitPullRequestCreateArrow, Link, LogIn, LogOut, MessageSquarePlus,
  KeyRound, Maximize2, Monitor, Moon, MoreHorizontal, PanelLeft, Pencil, Play, RefreshCw, ShieldCheck, StretchHorizontal, StretchVertical, Sun, TerminalSquare, Trash2,
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
  "key-round": KeyRound,
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
  "shield-check": ShieldCheck,
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
      <Localized title="Close"><IconButton id={closeId} icon="x" title="Close" /></Localized>
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

function AboutDialog() {
  return (
    <dialog id="about-dialog" className={cn(dialogClass, "w-[min(27rem,calc(100%-1.5rem))]")}>
      <div className="p-5">
        <Localized title="About"><DialogHeader title="About" closeId="about-close" /></Localized>
        <div className="flex flex-col items-center px-3 pb-2 text-center">
          <img src={keycapUrl} alt="" className="size-20 object-contain" />
          <h2 className="mt-3 font-serif text-2xl font-semibold">LaTeX Coder</h2>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground"><Message id="A self-hosted LaTeX workspace where people, coding agents, and Git work on the same paper." /></p>
        </div>
        <footer className="mt-5 flex items-center justify-between border-t pt-4">
          <span className="text-xs text-muted-foreground"><Message id="Open source · MIT License" /></span>
          <Button variant="outline" size="sm" asChild><a id="about-github" href="https://github.com/EvoEvolver/LatexCoder" target="_blank" rel="noreferrer"><Icon name="git-branch" />GitHub</a></Button>
        </footer>
      </div>
    </dialog>
  );
}

export function AppShell() {
  return (
    <>
      <div id="auth-page" className="auth-page grid min-h-dvh place-items-center bg-muted/60 p-6" hidden>
        <main className="w-full max-w-sm space-y-5">
          <div className="flex justify-center"><Brand prominent /></div>
          <div className="flex justify-end"><LanguageSelector compact /></div>
          <Card>
            <CardHeader className="pb-4">
              <h1 id="auth-title" className="font-serif text-2xl font-semibold"><Message id="Sign in" /></h1>
              <p id="auth-description" className="text-sm text-muted-foreground"><Message id="Core team members can sign in to manage projects." /></p>
            </CardHeader>
            <CardContent>
              <form id="auth-form" className="space-y-4">
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="auth-username"><Message id="Username" /><Input id="auth-username" autoComplete="username" required /></label>
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="auth-password"><Message id="Password" /><Input id="auth-password" type="password" autoComplete="current-password" minLength={10} required /></label>
                <p id="auth-error" className="auth-error text-sm text-destructive" hidden />
                <Button id="auth-submit" className="w-full" type="submit"><Icon name="log-in" /><span><Message id="Sign in" /></span></Button>
              </form>
              <details id="auth-notice" className="group mt-4 border-t pt-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-1 py-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-2"><Icon name="key-round" /><Message id="Account notice" /></span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 transition-transform group-open:rotate-90" />
                </summary>
                <p className="px-1 pb-1 pt-2 text-xs leading-relaxed text-muted-foreground"><Message id="There is no self-service password recovery. If you lose or forget your password, contact an administrator to request a password reset link." /></p>
              </details>
            </CardContent>
          </Card>
        </main>
      </div>

      <div id="share-confirm-page" className="grid min-h-dvh place-items-center bg-muted/60 p-6" hidden>
        <main className="w-full max-w-md space-y-5">
          <div className="flex justify-center"><Brand prominent /></div>
          <Card>
            <CardHeader className="pb-4">
              <h1 id="share-confirm-title" className="font-serif text-2xl font-semibold"><Message id="Join project?" /></h1>
              <p id="share-confirm-project" className="text-base font-medium" />
            </CardHeader>
            <CardContent className="space-y-5">
              <p id="share-confirm-description" className="text-sm leading-relaxed text-muted-foreground" />
              <div className="flex justify-end gap-2"><Button id="share-confirm-cancel" variant="outline" type="button"><Message id="Back to projects" /></Button><Button id="share-confirm-submit" type="button"><Icon name="user-plus" /><span><Message id="Join project" /></span></Button></div>
            </CardContent>
          </Card>
        </main>
      </div>

      <div id="projects-page" className="projects-page min-h-dvh overflow-auto bg-muted/40" hidden>
        <header className="projects-header flex h-16 items-center justify-between border-b bg-background px-[max(1rem,calc((100vw-65rem)/2))]">
          <Localized title="About LaTeX Coder"><button id="projects-about" className="rounded-md p-1 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" type="button" title="About LaTeX Coder" aria-haspopup="dialog"><Brand /></button></Localized>
          <div className="projects-account flex items-center gap-2">
            <Button id="admin-button" variant="ghost" size="sm" hidden><Icon name="shield-check" /><span className="max-sm:hidden"><Message id="Admin" /></span></Button>
            <Button id="account-button" variant="ghost" size="sm"><Icon name="user-round" /><span id="current-user" className="max-w-36 truncate max-sm:hidden" /></Button>
            <Button id="invite-user" data-internal-only variant="outline" size="sm"><Icon name="user-plus" /><span className="max-sm:hidden"><Message id="Invite" /></span></Button>
            <Button id="new-project" size="sm"><Icon name="folder-plus" /><span><Message id="New project" /></span></Button>
            <Localized title="Sign out"><IconButton id="logout-button" icon="log-out" title="Sign out" /></Localized>
          </div>
        </header>
        <main className="projects-main mx-auto w-[min(calc(100%-2rem),65rem)] py-10">
          <div className="mb-5"><h1 className="font-serif text-3xl font-semibold"><Message id="Projects" /></h1><p className="mt-1 text-sm text-muted-foreground"><Message id="Open a paper or start a new one." /></p></div>
          <div className="mb-3 flex items-center gap-2 max-sm:items-stretch">
            <label className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Localized placeholder="Search titles and tags" aria-label="Search projects"><Input id="project-search" className="pl-8" type="search" placeholder="Search titles and tags" aria-label="Search projects" /></Localized></label>
            <Localized aria-label="Project archive view"><div className="segmented grid shrink-0 grid-cols-2 rounded-md border bg-muted p-0.5" role="group" aria-label="Project archive view"><Button id="projects-active" className="active h-8 px-3 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" type="button" aria-pressed="true"><Message id="Active" /></Button><Button id="projects-archived" className="h-8 px-3 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" type="button" aria-pressed="false"><Message id="Archived" /></Button></div></Localized>
          </div>
          <Localized aria-label="Filter projects by tag"><div id="project-tag-filters" className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="Filter projects by tag" hidden /></Localized>
          <div id="project-list" className="project-list overflow-visible rounded-lg border bg-card" />
        </main>
      </div>

      <div id="admin-page" className="min-h-dvh overflow-auto bg-muted/40" hidden>
        <header className="flex h-16 items-center justify-between border-b bg-background px-[max(1rem,calc((100vw-80rem)/2))]">
          <Localized title="About LaTeX Coder"><button id="admin-about" className="rounded-md p-1 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" type="button" title="About LaTeX Coder"><Brand /></button></Localized>
          <Button id="admin-back" variant="ghost" size="sm"><Icon name="arrow-left" /><Message id="Projects" /></Button>
        </header>
        <main className="mx-auto w-[min(calc(100%-2rem),80rem)] py-8 max-sm:py-5">
          <div className="mb-5"><h1 className="font-serif text-3xl font-semibold max-sm:text-2xl"><Message id="Administration" /></h1><p className="mt-1 text-sm text-muted-foreground"><Message id="Manage accounts and projects across this installation." /></p></div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Localized aria-label="Admin data"><div className="segmented grid grid-cols-2 rounded-md border bg-muted p-0.5" role="tablist" aria-label="Admin data"><Button id="admin-users-tab" className="active h-8 px-4 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" role="tab"><Message id="Users" /></Button><Button id="admin-projects-tab" className="h-8 px-4 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" role="tab"><Message id="Projects" /></Button></div></Localized>
            <label className="relative min-w-56 flex-1 max-sm:order-last max-sm:basis-full max-sm:min-w-0"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Localized placeholder="Search users" aria-label="Search admin records"><Input id="admin-search" className="pl-8" type="search" placeholder="Search users" aria-label="Search admin records" /></Localized></label>
            <span id="admin-total" className="ml-auto text-xs tabular-nums text-muted-foreground" />
          </div>
          <div id="admin-table" className="min-h-72 overflow-x-auto rounded-md border bg-card max-sm:min-h-0 max-sm:overflow-x-hidden max-sm:border-0 max-sm:bg-transparent" />
          <footer className="mt-3 flex flex-wrap items-center justify-between gap-2"><span id="admin-page-status" className="text-xs tabular-nums text-muted-foreground" /><div className="flex gap-2"><Button id="admin-previous" variant="outline" size="sm"><Message id="Previous" /></Button><Button id="admin-next" variant="outline" size="sm"><Message id="Next" /></Button></div></footer>
        </main>
      </div>

      <div id="editor-page" className="app-shell grid h-dvh min-w-80 grid-rows-[2.5rem_minmax(0,1fr)]" hidden>
        <header id="editor-topbar" className="topbar relative flex min-w-0 items-center border-b bg-background px-1.5 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
          <div id="topbar-actions" className="flex h-full shrink-0 items-center">
            <Localized title="All projects"><IconButton id="back-projects" icon="arrow-left" title="All projects" className="mr-0.5 size-7" /></Localized>
            <Localized title="About LaTeX Coder"><Button id="editor-about" className="mx-0.5 size-7 shrink-0 p-0" variant="ghost" size="icon" type="button" title="About LaTeX Coder" aria-haspopup="dialog"><img src={keycapUrl} alt="LaTeX Coder" className="size-7 object-contain" /></Button></Localized>
            <Localized aria-label="Application menu"><nav className="flex h-full shrink-0 items-center" aria-label="Application menu">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button id="project-menu" className="h-7 rounded px-2 text-xs font-medium max-[520px]:px-1" variant="ghost"><Message id="Project" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel><Message id="Project" /></DropdownMenuLabel>
                <DropdownMenuItem id="project-search-menu"><Icon name="search" /><Message id="Search Project" /><DropdownMenuShortcut>Shift Ctrl F</DropdownMenuShortcut></DropdownMenuItem>
                <DropdownMenuItem id="project-settings"><Icon name="settings" /><Message id="Project Settings…" /></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem id="menu-download-project"><Icon name="archive" /><Message id="Download ZIP" /></DropdownMenuItem>
                <DropdownMenuItem id="menu-open-trash"><Icon name="trash-2" /><Message id="Recently Deleted…" /></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button id="history-menu" className="h-7 rounded px-2 text-xs font-medium max-[520px]:px-1" variant="ghost"><Message id="History" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel><Message id="Version control" /></DropdownMenuLabel>
                <DropdownMenuItem id="git-button"><Icon name="git-branch" /><Message id="Version History…" /></DropdownMenuItem>
                <DropdownMenuItem id="history-save-checkpoint"><Icon name="git-commit-horizontal" /><Message id="Save Checkpoint…" /></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem id="toggle-blame"><Icon name="scan-text" /><Message id="Blame" /><span id="blame-menu-state" className="ml-auto text-[10px] text-muted-foreground"><Message id="Off" /></span></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled className="text-[10px] text-muted-foreground"><Message id="Live edits are checkpointed automatically" /></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button id="account-menu" className="h-7 rounded px-2 text-xs font-medium max-[520px]:px-1" variant="ghost"><Message id="Account" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-60">
                <DropdownMenuLabel><Message id="Account" /></DropdownMenuLabel>
                <DropdownMenuItem id="editor-admin-button" data-admin-only><Icon name="shield-check" /><Message id="Administration…" /></DropdownMenuItem>
                <DropdownMenuItem id="editor-account-button" data-user-only><Icon name="user-round" /><Message id="Account Settings…" /></DropdownMenuItem>
                <DropdownMenuItem id="editor-invite-user" data-internal-only><Icon name="user-plus" /><Message id="Invite User…" /></DropdownMenuItem>
                <DropdownMenuItem id="editor-logout" data-user-only className="text-destructive focus:text-destructive"><Icon name="log-out" /><Message id="Sign Out" /></DropdownMenuItem>
                <DropdownMenuItem id="editor-login" data-guest-only><Icon name="log-in" /><Message id="Sign In" /></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button id="collaborate-menu" className="h-7 rounded px-2 text-xs font-medium max-[520px]:px-1" variant="ghost"><Message id="Collaborate" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-64">
                <DropdownMenuLabel><Message id="Share this project" /></DropdownMenuLabel>
                <DropdownMenuItem id="share-project"><Icon name="link" /><Message id="Browser Editing…" /></DropdownMenuItem>
                <DropdownMenuItem id="collaborate-agent"><Icon name="terminal-square" /><Message id="Agent Editing…" /></DropdownMenuItem>
                <DropdownMenuItem id="collaborate-git"><Icon name="git-branch" /><Message id="Git Access…" /></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem id="collaborate-members"><Icon name="user-round" /><Message id="Project Members…" /></DropdownMenuItem>
                <DropdownMenuItem id="collaborate-secrets"><Icon name="refresh-cw" /><Message id="Access Secrets…" /></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </nav></Localized>
          </div>

          <div id="project-title" className="project-title pointer-events-none absolute left-1/2 max-w-56 -translate-x-1/2 truncate px-3 text-center max-[760px]:hidden">
            <strong id="project-name" className="truncate text-[13px] font-semibold" />
          </div>
          <span id="active-file-label" className="sr-only">main.tex</span>
          <div id="topbar-status" className="ml-auto flex min-w-0 shrink-0 items-center gap-2 px-1">
            <span id="sync-state" className="whitespace-nowrap text-[10px] text-muted-foreground max-[520px]:hidden"><Message id="Connecting" /></span>
            <Localized aria-label="Active collaborators"><div id="presence" className="presence flex min-w-0 max-[760px]:hidden" aria-label="Active collaborators" /></Localized>
            <label id="guest-name-field" className="name-field flex h-7 w-32 items-center gap-1.5 rounded border bg-background px-1.5 max-lg:hidden"><Icon name="user-round" /><Localized aria-label="Display name"><Input id="display-name" className="h-6 border-0 p-0 text-[10px] shadow-none focus-visible:ring-0" maxLength={28} aria-label="Display name" /></Localized></label>
          </div>
        </header>

        <main id="workspace" className="workspace grid min-h-0 w-full max-w-full grid-cols-[13rem_0.5rem_minmax(0,1fr)_0.5rem_minmax(0,46%)] overflow-hidden max-[760px]:!grid-cols-1">
          <aside id="files-pane" className="files-pane grid min-h-0 min-w-0 grid-rows-[2.75rem_minmax(0,1fr)_0.5rem_13.75rem] border-r bg-muted/35 max-[760px]:fixed max-[760px]:bottom-0 max-[760px]:left-0 max-[760px]:top-10 max-[760px]:z-30 max-[760px]:w-64 max-[760px]:-translate-x-full max-[760px]:bg-background max-[760px]:shadow-xl max-[760px]:transition-transform max-[760px]:[&.mobile-open]:translate-x-0">
            <input id="upload-input" type="file" multiple hidden />
            <div id="files-toolbar" className={cn(paneToolbar, "justify-between")}><Localized title="Close files"><IconButton id="close-files" icon="x" title="Close files" className="min-[761px]:hidden" /></Localized><Localized title="File actions"><IconButton id="files-menu" icon="more-horizontal" title="File actions" /></Localized></div>
            <div id="file-list" className="file-list min-h-0 flex-1 overflow-auto p-1.5" />
            <Localized aria-label="Resize files and tree"><div id="structure-resize" role="separator" aria-label="Resize files and tree" aria-orientation="horizontal" tabIndex={0} className="group flex h-2 touch-none cursor-row-resize items-center justify-center border-y bg-muted/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="h-0.5 w-8 rounded bg-border group-hover:bg-primary" /></div></Localized>
            <Localized aria-label="Document tree"><section id="structure-pane" className="grid min-h-0 grid-rows-[2.25rem_minmax(0,1fr)] bg-background/55" aria-label="Document tree">
              <header className="flex items-center justify-between border-b px-2.5"><strong className="text-[11px] font-semibold uppercase text-muted-foreground"><Message id="Tree" /></strong><div className="flex items-center"><Localized title="Open TreeWriter"><IconButton id="open-structure" icon="maximize-2" title="Open TreeWriter" className="size-7" /></Localized><Localized title="Refresh tree"><IconButton id="refresh-structure" icon="refresh-cw" title="Refresh tree" className="size-7" /></Localized></div></header>
              <Localized aria-label="Document tree entries"><nav id="structure-list" className="min-h-0 overflow-auto p-1.5" aria-label="Document tree entries"><p className="px-2 py-3 text-xs text-muted-foreground"><Message id="Loading tree…" /></p></nav></Localized>
            </section></Localized>
          </aside>
          <Localized aria-label="Resize files"><div id="files-resize" role="separator" aria-label="Resize files" aria-orientation="vertical" tabIndex={0} className="group relative z-10 flex w-2 touch-none cursor-col-resize items-center justify-center bg-muted/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary max-[760px]:hidden">
            <Localized title="Hide files"><Button id="toggle-files-column" className="z-10 h-5 w-3 shrink-0 p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground" variant="ghost" size="icon" type="button" title="Hide files" aria-controls="files-pane" aria-expanded="true"><span data-collapse-icon><ChevronLeft className="size-2.5" aria-hidden="true" /></span><span data-expand-icon hidden><ChevronRight className="size-2.5" aria-hidden="true" /></span></Button></Localized>
          </div></Localized>

          <section id="editor-pane" className="editor-pane relative grid min-h-0 min-w-0 grid-rows-[2.75rem_2.75rem_minmax(0,1fr)] border-r">
            <Localized aria-label="Open files"><div id="file-tabs" className="file-tabs" role="tablist" aria-label="Open files" /></Localized>
            <div className={cn(paneToolbar, "editor-toolbar justify-between")}>
              <div id="review-actions" className="review-actions flex items-center gap-1"><Localized title="Files"><IconButton id="toggle-files" icon="panel-left" title="Files" className="min-[761px]:hidden" /></Localized><Button id="suggest-edit" className={toolButton} variant="ghost" size="sm" aria-pressed="false"><Icon name="git-pull-request-create-arrow" /><span className="max-[480px]:hidden"><Message id="Suggest" /></span></Button><Localized aria-label="Markdown view"><div id="markdown-view-switch" className="segmented ml-1 grid grid-cols-2 rounded-md border bg-muted p-0.5" role="tablist" aria-label="Markdown view" hidden><Button id="markdown-source" className="active h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" type="button" role="tab" aria-selected="true"><Message id="Source" /></Button><Button id="markdown-rendered" className="h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" type="button" role="tab" aria-selected="false"><Message id="Preview" /></Button></div></Localized></div>
              <div className="editor-actions flex items-center gap-1"><div id="workspace-view-switch"><Localized title="Show PDF preview"><Button id="open-pdf" className="h-8 px-2.5 text-xs" variant="ghost" type="button" title="Show PDF preview" aria-controls="output-pane" aria-expanded="false"><Message id="Switch to PDF" /></Button></Localized></div><Localized aria-label="Review" title="Review"><Button id="toggle-review" data-output="review" variant="ghost" size="sm" className="h-8 min-w-8 px-1.5" aria-label="Review" aria-expanded="false" title="Review"><span id="review-count" className="rounded-full bg-amber-700 px-1.5 text-[9px] text-white">0</span></Button></Localized></div>
            </div>
            <div id="editor-body" className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden">
              <div className="relative grid min-h-0 min-w-0 overflow-hidden">
                <div id="editor" className="min-h-0 min-w-0 overflow-hidden" />
                <Localized aria-label="Markdown preview"><section id="markdown-preview" className="absolute inset-0 min-h-0 overflow-auto bg-background" aria-label="Markdown preview" hidden><article id="markdown-preview-content" className="mx-auto max-w-4xl px-8 py-8 text-sm leading-7 text-foreground max-sm:px-5 [&>*:first-child]:mt-0 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:my-5 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:mb-4 [&_h1]:mt-8 [&_h1]:border-b [&_h1]:pb-2 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:border-b [&_h2]:pb-1.5 [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_hr]:my-7 [&_hr]:border-border [&_img]:my-5 [&_img]:max-w-full [&_img]:rounded [&_img]:border [&_img]:shadow-sm [&_li]:my-1 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-7 [&_p]:my-4 [&_pre]:my-5 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-5 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-7" /></section></Localized>
                <section id="structure-view" className="absolute inset-0 min-h-0 overflow-auto bg-background" aria-label="TreeWriter" hidden><div id="structure-document" className="mx-auto w-full max-w-4xl px-8 py-10 max-sm:px-5 max-sm:py-7" /></section>
            <div id="binary-view" className="binary-view absolute inset-0 grid min-h-0 grid-rows-[2.75rem_minmax(0,1fr)] bg-background" hidden>
              <div className="flex min-w-0 items-center justify-between border-b bg-muted/20 px-2.5"><div className="min-w-0"><strong id="binary-kind" className="text-xs"><Message id="File preview" /></strong><span id="binary-status" className="ml-2 text-[10px] text-muted-foreground" /></div><div className="flex items-center"><Localized title="Zoom out"><IconButton id="file-preview-zoom-out" icon="zoom-out" title="Zoom out" /></Localized><Localized title="Zoom in"><IconButton id="file-preview-zoom-in" icon="zoom-in" title="Zoom in" /></Localized><Localized title="Download file"><Button id="binary-download" className={iconButton} variant="ghost" size="icon" title="Download file" asChild><a download><Icon name="download" /></a></Button></Localized></div></div>
              <div id="file-preview-viewport" className="relative min-h-0 min-w-0 overflow-auto bg-muted/40 p-4"><img id="image-preview" className="mx-auto block max-w-none shadow-sm" alt="" hidden /><div id="file-pdf-document" className="flex min-w-min flex-col items-center gap-4 [&_canvas]:block [&_canvas]:shrink-0 [&_canvas]:bg-white [&_canvas]:shadow-lg" hidden /><div id="binary-fallback" className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><Icon name="file" /><strong id="binary-name" /><Button id="binary-fallback-download" variant="outline" asChild><a download><Icon name="download" /><Message id="Download" /></a></Button></div></div>
            </div>
              </div>
              <aside id="review-pane" className="grid min-h-0 min-w-0 grid-rows-[2.5rem_minmax(0,1fr)] border-l bg-muted/50" hidden>
                <div className="flex items-center justify-between border-b px-2.5"><strong className="text-xs"><Message id="Review" /></strong><Localized title="Close review"><IconButton id="close-review" icon="x" title="Close review" /></Localized></div>
                <div className="min-h-0 overflow-auto p-2.5"><div id="review-list" /></div>
              </aside>
            </div>
          </section>
          <Localized aria-label="Resize editor and PDF"><div id="output-resize" role="separator" aria-label="Resize editor and PDF" aria-orientation="vertical" tabIndex={0} className="group relative z-10 flex w-2 touch-none cursor-col-resize items-center justify-center bg-muted/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary max-[760px]:hidden">
            <Localized title="Hide PDF"><Button id="toggle-output-column" className="z-10 h-5 w-3 shrink-0 p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground" variant="ghost" size="icon" type="button" title="Hide PDF" aria-controls="output-pane" aria-expanded="true"><span data-collapse-icon><ChevronRight className="size-2.5" aria-hidden="true" /></span><span data-expand-icon hidden><ChevronLeft className="size-2.5" aria-hidden="true" /></span></Button></Localized>
          </div></Localized>

          <section id="output-pane" className="output-pane grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-zinc-700 max-[760px]:hidden max-[760px]:[&.mobile-open]:fixed max-[760px]:[&.mobile-open]:bottom-0 max-[760px]:[&.mobile-open]:left-0 max-[760px]:[&.mobile-open]:right-0 max-[760px]:[&.mobile-open]:top-10 max-[760px]:[&.mobile-open]:z-30 max-[760px]:[&.mobile-open]:grid">
            <div className={cn(paneToolbar, "pane-header output-header h-auto flex-wrap justify-between gap-1 py-1 max-[760px]:grid max-[760px]:min-h-0 max-[760px]:grid-cols-1")}>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 max-[760px]:w-full">
                <div id="compile-control" className="inline-flex shrink-0 rounded-md shadow-xs">
                  <Localized title="Compile document"><Button id="compile-button" className="h-8 w-28 shrink-0 rounded-r-none px-3 text-xs shadow-none" size="sm" type="button" title="Compile document"><Icon name="play" /><span><Message id="Compile" /></span></Button></Localized>
                  <CompileTargetMenu />
                </div>
                <div id="output-view-tabs" className="segmented grid w-32 grid-cols-2 rounded-md border bg-muted p-0.5" role="tablist"><Button className="active h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" data-output="pdf">PDF</Button><Button className="h-7 px-2 text-xs [&.active]:bg-background [&.active]:shadow-sm" variant="ghost" data-output="log"><Message id="Log" /> <span id="log-error-count" className="text-red-700" hidden /></Button></div>
              </div>
              <div className="ml-auto flex items-center max-[760px]:w-full max-[760px]:justify-end"><Localized title="Fit page width"><IconButton id="pdf-fit-width" icon="stretch-horizontal" title="Fit page width" className="[&.active]:bg-accent [&.active]:text-primary" /></Localized><Localized title="Fit whole page"><IconButton id="pdf-fit-page" icon="stretch-vertical" title="Fit whole page" className="[&.active]:bg-accent [&.active]:text-primary" /></Localized><Localized title="Zoom out"><IconButton id="pdf-zoom-out" icon="zoom-out" title="Zoom out" /></Localized><Localized title="Zoom in"><IconButton id="pdf-zoom-in" icon="zoom-in" title="Zoom in" /></Localized><Localized title="Download PDF"><Button id="pdf-download" className={iconButton} variant="ghost" size="icon" title="Download PDF" asChild><a download="paper.pdf"><Icon name="download" /></a></Button></Localized><Localized title="Show source editor"><Button id="close-output" className="ml-1 h-8 px-2.5 text-xs" variant="ghost" type="button" title="Show source editor"><Message id="Switch to source" /></Button></Localized></div>
            </div>
            <div id="pdf-surface" className="relative min-h-0 min-w-0 overflow-hidden bg-zinc-700">
              <div id="pdf-view" className="pdf-view relative h-full min-h-0 min-w-0 overflow-auto [scrollbar-gutter:stable]"><div id="empty-output" className="empty-output absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-zinc-300"><Icon name="file-check-2" /><span id="pdf-status"><Message id="No compiled PDF" /></span></div><div id="pdf-document" className="pdf-document flex min-w-min flex-col items-center gap-4 p-4 [&_canvas]:block [&_canvas]:shrink-0 [&_canvas]:bg-white [&_canvas]:shadow-lg" hidden /></div>
              <span id="pdf-freshness" role="status" className="absolute bottom-3 right-3 z-10 rounded-md border border-amber-400/50 bg-amber-50/95 px-2.5 py-1.5 text-[10px] font-medium text-amber-900 shadow-md backdrop-blur-sm dark:bg-amber-950/95 dark:text-amber-200" hidden><Message id="PDF outdated" /></span>
            </div>
            <div id="build-log" className="min-h-0 min-w-0 overflow-auto bg-background" hidden>
              <div id="build-errors" className="border-b p-3" hidden />
              <details className="p-3" open><summary className="cursor-pointer text-xs font-medium text-muted-foreground"><Message id="Full compiler log" /></summary><pre id="build-output" className="m-0 whitespace-pre-wrap break-words py-3 font-mono text-xs leading-relaxed"><Message id="No compilation yet." /></pre></details>
            </div>
          </section>
        </main>
        <div id="selection-actions" className="selection-actions fixed z-30 flex items-center gap-1" hidden><Localized title="Add comment"><IconButton id="selection-comment" icon="message-square-plus" title="Add comment" className="size-8 shadow-lg" /></Localized><Button id="selection-accept" className="selection-accept h-8 shadow-lg" size="sm"><Icon name="check-check" /><span><Message id="Accept suggestion" /></span></Button></div>
      </div>

      <div id="toast" className="toast fixed bottom-5 left-1/2 z-50 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-md bg-foreground px-3 py-2 text-sm text-background shadow-xl" role="status" hidden />
      <Localized aria-label="PDF actions"><div id="pdf-context-menu" role="menu" aria-label="PDF actions" className="fixed z-40 w-44 rounded-md border bg-card p-1 text-card-foreground shadow-xl" hidden>
        <Button id="pdf-go-to-source" role="menuitem" variant="ghost" size="sm" className="w-full justify-start rounded-sm px-2 text-xs"><Icon name="file-check-2" /><Message id="Go to source" /></Button>
      </div></Localized>
      <Localized aria-label="Edit selection"><div id="editor-context-menu" role="menu" aria-label="Edit selection" className="fixed z-40 w-52 max-h-[calc(100dvh-1rem)] overflow-auto rounded-md border bg-card p-1 text-card-foreground shadow-xl" hidden>
        {([
          ["undo", "undo-2", "Undo"], ["redo", "redo-2", "Redo"],
          ["cut", "scissors", "Cut"], ["copy", "copy", "Copy"], ["paste", "clipboard-paste", "Paste"],
          ["delete", "trash-2", "Delete"], ["select-all", "scan-text", "Select all"],
          ["comment", "message-square-plus", "Add comment"], ["pdf", "file-check-2", "Go to PDF"],
        ] as const).map(([action, icon, label]) => <Button key={action} role="menuitem" data-editor-action={action} variant="ghost" size="sm" className={cn("w-full justify-start rounded-sm px-2 text-xs disabled:pointer-events-auto disabled:opacity-40", (action === "cut" || action === "comment") && "mt-1 border-t") }><Icon name={icon} /><Message id={label} /></Button>)}
      </div></Localized>
      <Localized aria-label="Line actions"><div id="line-context-menu" role="menu" aria-label="Line actions" className="fixed z-40 w-60 rounded-md border bg-card p-1 text-card-foreground shadow-xl" hidden>
        <code id="line-context-reference" className="block truncate border-b px-2 py-2 text-[11px] text-muted-foreground" />
        <Button id="copy-line-reference" role="menuitem" variant="ghost" size="sm" className="mt-1 w-full justify-start rounded-sm px-2 text-xs"><Icon name="copy" /><Message id="Copy path and line" /></Button>
      </div></Localized>
      <AboutDialog />
      <dialog id="search-dialog" className={cn(dialogClass, "w-[min(44rem,calc(100%-1.5rem))]")}><div className="p-5"><Localized title="Search and replace"><DialogHeader title="Search and replace" closeId="search-close" /></Localized><form id="search-form" className="flex flex-wrap items-center gap-2"><Localized aria-label="Search project" placeholder="Search project"><Input id="search-query" className="min-w-0 flex-1" aria-label="Search project" placeholder="Search project" maxLength={512} required /></Localized><Localized title="Search"><Button type="submit" size="icon" title="Search"><Icon name="search" /></Button></Localized><div className="flex w-full gap-4 text-xs"><label className="flex items-center gap-2"><input id="search-case" type="checkbox" /><Message id="Match case" /></label><label className="flex items-center gap-2"><input id="search-regex" type="checkbox" /><Message id="Regular expression" /></label></div></form><div className="mt-3 flex flex-wrap gap-2"><Localized aria-label="Replacement text" placeholder="Replacement text"><Input id="replace-text" className="min-w-0 flex-1" aria-label="Replacement text" placeholder="Replacement text" /></Localized><Localized aria-label="Replace scope"><select id="replace-scope" aria-label="Replace scope" className="h-9 rounded-md border bg-background px-2 text-xs"><Localized text="Current file"><option value="file">Current file</option></Localized><Localized text="Entire project"><option value="project">Entire project</option></Localized></select></Localized><Button id="replace-preview" variant="outline" size="sm"><Message id="Preview" /></Button><Button id="replace-apply" size="sm" hidden><Message id="Apply replacements" /></Button></div><p id="search-status" className="my-3 text-xs text-muted-foreground" role="status" /><div id="search-results" className="max-h-[55dvh] overflow-auto" /></div></dialog>
      <dialog id="settings-dialog" className={dialogClass}>
        <form id="settings-form" className="space-y-4 p-5">
          <Localized title="Project settings"><DialogHeader title="Project settings" closeId="settings-close" /></Localized>
          <label className="grid gap-1.5 text-sm" htmlFor="settings-main"><Message id="Main document" /><select id="settings-main" className="h-9 min-w-0 rounded-md border bg-background px-3" /></label>
          <label className="grid gap-1.5 text-sm" htmlFor="settings-compiler"><Message id="Compiler" /><select id="settings-compiler" className="h-9 rounded-md border bg-background px-3"><Localized text="Automatic"><option value="auto">Automatic</option></Localized><option value="tectonic">Tectonic</option><option value="latexmk">latexmk</option></select></label>
          <label className="flex items-center gap-2 text-sm"><input id="settings-auto" type="checkbox" /><Message id="Automatic compilation" /></label>
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button id="open-trash" type="button" variant="outline" size="sm"><Icon name="trash-2" /><Message id="Recently deleted" /></Button>
            <Localized title="Download project ZIP"><Button id="download-project" variant="outline" size="sm" title="Download project ZIP" asChild><a><Icon name="archive" /><Message id="Download ZIP" /></a></Button></Localized>
          </div>
          <footer className="flex justify-end"><Button type="submit"><Message id="Save" /></Button></footer>
        </form>
      </dialog>
      <dialog id="trash-dialog" className={dialogClass}><div className="p-5"><Localized title="Recently deleted"><DialogHeader title="Recently deleted" closeId="trash-close" /></Localized><div id="trash-list" className="max-h-[60dvh] overflow-auto" /></div></dialog>

      <dialog id="review-dialog" className={dialogClass}><form id="review-form" className="space-y-4 p-5"><header className="flex items-center justify-between"><strong id="dialog-title"><Message id="Comment" /></strong><Localized title="Close"><Button id="review-close" className={iconButton} variant="ghost" size="icon" type="button" title="Close"><Icon name="x" /></Button></Localized></header><label id="dialog-label" className="block text-sm font-medium" htmlFor="review-text"><Message id="Comment" /></label><Textarea id="review-text" rows={5} required /><footer className="flex justify-end gap-2"><Button id="review-cancel" variant="outline" type="button"><Message id="Cancel" /></Button><Button id="dialog-submit" type="submit"><Message id="Insert" /></Button></footer></form></dialog>

      <dialog id="action-dialog" className={dialogClass}><form id="action-form" className="space-y-4 p-5"><DialogHeader title="" closeId="action-close" /><strong id="action-title" className="-mt-12 block pr-10 text-base" /><p id="action-message" className="text-sm text-muted-foreground" hidden /><label id="action-label" className="grid gap-1.5 text-sm font-medium" htmlFor="action-input" /><Input id="action-input" autoComplete="off" required /><footer className="flex justify-end gap-2"><Button id="action-cancel" variant="outline" type="button"><Message id="Cancel" /></Button><Button id="action-submit" className="[&.danger-button]:bg-destructive [&.danger-button]:text-white" type="submit" /></footer></form></dialog>

      <dialog id="git-dialog" className={cn(dialogClass, "git-dialog w-[min(72rem,calc(100%-1.5rem))]")}>
        <div className="git-dialog-body flex max-h-[calc(100dvh-2rem)] flex-col gap-3 p-5">
          <Localized title="Version history"><DialogHeader title="Version history" subtitleId="git-summary" closeId="git-close" /></Localized>
          <div id="git-conflict" className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-destructive bg-destructive/10 p-3" hidden>
            <strong className="text-sm"><Message id="Merge conflict" /></strong><span id="git-conflict-branch" className="col-start-1 truncate font-mono text-xs text-muted-foreground" />
            <Button id="git-resolve" className="col-start-2 row-span-2 row-start-1" variant="outline" size="sm"><Icon name="git-merge" /><Message id="Mark resolved" /></Button>
          </div>
          <details className="git-section border-t pt-2 text-xs text-muted-foreground"><summary className="cursor-pointer"><Message id="Current changes (" /><span id="git-change-count">0</span>)</summary><div id="git-file-list" className="max-h-28 overflow-auto" /></details>
          <VersionHistory />
          <footer className="flex flex-wrap items-center gap-2">
            <Localized title="Refresh history"><IconButton id="git-refresh" icon="refresh-cw" title="Refresh history" /></Localized>
            <label className="sr-only" htmlFor="git-message"><Message id="Checkpoint name" /></label>
            <Localized placeholder="Name a checkpoint (optional)"><Input id="git-message" className="min-w-32 flex-1" maxLength={500} placeholder="Name a checkpoint (optional)" /></Localized>
            <Button id="git-commit"><Icon name="git-commit-horizontal" /><Message id="Save checkpoint" /></Button>
          </footer>
        </div>
      </dialog>

      <dialog id="access-dialog" className={dialogClass}><div className="p-5"><Localized title="Browser sharing"><DialogHeader title="Browser sharing" subtitleId="access-project-name" closeId="access-close" /></Localized><p className="mb-4 text-xs text-muted-foreground"><Message id="Create a personal link for browser access. Other project members have their own links." /></p><Localized aria-label="Link permission"><div className="mb-4 grid grid-cols-2 rounded-md border bg-muted p-0.5" role="radiogroup" aria-label="Link permission"><Button id="share-view" data-share-mode="view" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm"><Message id="View" /></Button><Button id="share-edit" data-share-mode="edit" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm"><Message id="Edit" /></Button></div></Localized><section className="space-y-2 border-t py-4"><label id="share-link-label" className="text-sm font-medium" htmlFor="share-link"><Message id="Edit link" /></label><p id="browser-editing-description" className="text-xs text-muted-foreground" /><Localized label="Copy"><CopyRow inputId="share-link" buttonId="copy-share-link" label="Copy" /></Localized></section><footer className="flex justify-end"><Button id="access-done"><Message id="Done" /></Button></footer></div></dialog>

      <dialog id="agent-access-dialog" className={dialogClass}><div className="p-5"><Localized title="Agent editing"><DialogHeader title="Agent editing" closeId="agent-access-close" /></Localized><Localized aria-label="Agent editing mode"><div className="mb-4 grid grid-cols-2 rounded-md border bg-muted p-0.5" role="radiogroup" aria-label="Agent editing mode"><Button id="agent-direct" data-agent-mode="direct" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm"><Message id="Direct" /></Button><Button id="agent-propose" data-agent-mode="propose" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm"><Message id="Propose" /></Button></div></Localized><section className="space-y-2 border-t py-4"><label id="agent-command-label" className="text-sm font-medium" htmlFor="agent-command"><Message id="Direct editing" /></label><p id="agent-editing-description" className="text-xs text-muted-foreground" /><Localized label="Copy"><CopyRow inputId="agent-command" buttonId="copy-agent-link" label="Copy" /></Localized></section><footer className="flex justify-end"><Button id="agent-access-done"><Message id="Done" /></Button></footer></div></dialog>

      <dialog id="git-access-dialog" className={dialogClass}><div className="space-y-4 p-5">
        <Localized title="Git access"><DialogHeader title="Git access" closeId="git-access-close" /></Localized>
        <Localized aria-label="Git authentication"><div id="git-auth-options" hidden className="grid grid-cols-2 gap-1 rounded-md border bg-muted p-1" role="radiogroup" aria-label="Git authentication">
          <Button id="git-mode-ssh" variant="ghost" role="radio" aria-checked="true" className="[&.active]:bg-background"><Message id="SSH key" /></Button>
          <Button id="git-mode-link" variant="ghost" role="radio" aria-checked="false" className="[&.active]:bg-background"><Message id="Access link" /></Button>
        </div></Localized>
        <p id="git-access-description" className="text-xs text-muted-foreground" />
        <Localized label="Copy"><CopyRow inputId="clone-command" buttonId="copy-clone-command" label="Copy" /></Localized>
        <p id="git-host-fingerprint" hidden className="break-all font-mono text-xs text-muted-foreground" />
        <Button id="git-manage-keys" hidden variant="outline" size="sm"><Message id="Manage SSH keys" /></Button>
        <p className="text-xs text-muted-foreground"><Message id="Pushed commits synchronize into the live document automatically." /></p>
        <footer className="flex justify-end"><Button id="git-access-done"><Message id="Done" /></Button></footer>
      </div></dialog>

      <dialog id="collaborator-dialog" className={dialogClass}><div className="p-5"><Localized title="Project members"><DialogHeader title="Project members" closeId="collaborator-close" /></Localized><div id="collaborator-list" className="space-y-1 text-xs" /><footer className="mt-5 flex justify-end"><Button id="collaborator-done"><Message id="Done" /></Button></footer></div></dialog>

      <dialog id="access-secret-dialog" className={dialogClass}><div className="p-5"><Localized title="Access secrets"><DialogHeader title="Access secrets" closeId="access-secret-close" /></Localized><p id="rotate-secret-warning" className="mb-4 text-xs text-muted-foreground"><Message id="Rotating your secrets immediately invalidates your previous View, Edit, Agent editing, and Git access links, and signs out their guest sessions. Other collaborators’ links keep working." /></p><Button id="rotate-share-secret" variant="outline" type="button"><Icon name="refresh-cw" /><Message id="Rotate my secrets" /></Button><footer className="mt-5 flex justify-end"><Button id="access-secret-done"><Message id="Done" /></Button></footer></div></dialog>

      <dialog id="chapter-help-dialog" aria-labelledby="chapter-help-title" className={cn(dialogClass, "w-[min(38rem,calc(100%-1.5rem))]")}>
        <div className="space-y-4 p-5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <h2 id="chapter-help-title" className="text-base font-semibold"><Message id="Compile a chapter" /></h2>
            <Localized title="Close"><IconButton id="chapter-help-close" icon="x" title="Close" /></Localized>
          </div>
          <p id="chapter-help-description" className="text-muted-foreground" />
          <ol className="list-decimal space-y-4 pl-5">
            <li><p><Message id="At the top of each child file, point to the chapter entry:" /></p><pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs"><code>{"%% latexcoder:chapter-root chapters/methods.tex"}</code></pre></li>
            <li><p><Message id="At the top of the chapter entry, specify its template:" /></p><pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs"><code>{"%% latexcoder:root main.tex\n%% latexcoder:template templates/chapter.tex\n\\chapter{Methods}\n\\input{chapters/child.tex}"}</code></pre></li>
            <li><p><Message id="Create the template with the document setup and one content marker:" /></p><pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs"><code>{"\\documentclass{report}\n\\begin{document}\n%% latexcoder:content\n\\end{document}"}</code></pre></li>
          </ol>
          <p className="text-xs text-muted-foreground"><Message id="Paths are relative to the project root. Keep directives in the leading comment block." /></p>
          <p className="text-xs text-muted-foreground"><Message id="For a complete chapter document, use %% latexcoder:template none." /></p>
          <p className="text-xs text-muted-foreground"><Message id="Until configured, Chapter root uses the top-level root." /></p>
          <footer className="flex justify-end"><Button id="chapter-help-done" type="button"><Message id="Done" /></Button></footer>
        </div>
      </dialog>

      <dialog id="account-dialog" className={dialogClass}>
        <form id="account-form" className="space-y-4 p-5">
          <Localized title="Account"><DialogHeader title="Account" closeId="account-close" /></Localized>
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="account-username"><Message id="Username" /><Input id="account-username" readOnly /></label>
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="account-display-name"><Message id="Display name" /><Input id="account-display-name" maxLength={28} required /></label>
          <p className="text-xs text-muted-foreground"><Message id="This name appears to collaborators in presence, comments, and suggestions." /></p>
          <section className="space-y-2 border-t pt-4">
            <strong className="text-sm font-medium"><Message id="Appearance" /></strong>
            <Localized aria-label="Color theme"><div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Color theme">
              <Button data-theme-option="system" variant="outline" type="button" role="radio" className="h-auto flex-col gap-2 py-3"><Icon name="monitor" /><Message id="System" /></Button>
              <Button data-theme-option="light" variant="outline" type="button" role="radio" className="h-auto flex-col gap-2 py-3"><Icon name="sun" /><Message id="Light" /></Button>
              <Button data-theme-option="dark" variant="outline" type="button" role="radio" className="h-auto flex-col gap-2 py-3"><Icon name="moon" /><Message id="Dark" /></Button>
            </div></Localized>
          </section>
          <LanguageSelector />
          <Localized aria-label="SSH keys"><section id="account-ssh-keys" hidden className="space-y-3 border-t pt-4" aria-label="SSH keys">
            <strong className="text-sm font-medium"><Message id="SSH keys" /></strong>
            <p className="text-xs text-muted-foreground"><Message id="Add a public key to clone and push your projects over SSH. Keep the private key on your device." /></p>
            <div id="ssh-key-list" className="max-h-36 space-y-2 overflow-y-auto" aria-live="polite" />
            <label className="grid gap-1 text-sm" htmlFor="ssh-key-title">Key name<Localized placeholder="My laptop"><Input id="ssh-key-title" maxLength={80} placeholder="My laptop" /></Localized></label>
            <label className="grid gap-1 text-sm" htmlFor="ssh-key-public"><Message id="Public key" /><textarea id="ssh-key-public" rows={3} maxLength={16384} placeholder="ssh-ed25519 AAAA…" className="w-full rounded-md border bg-background p-2 font-mono text-xs" /></label>
            <Button id="ssh-key-add" type="button" variant="outline" size="sm"><Message id="Add SSH key" /></Button>
          </section></Localized>
          <footer className="flex justify-between gap-2"><Button id="account-logout" variant="outline" type="button"><Icon name="log-out" /><Message id="Sign out" /></Button><div className="flex gap-2"><Button id="account-cancel" variant="outline" type="button"><Message id="Cancel" /></Button><Button id="account-save" type="submit"><Message id="Save" /></Button></div></footer>
        </form>
      </dialog>

      <dialog id="invite-dialog" className={dialogClass}><div className="access-dialog-body p-5"><Localized title="Invite a user"><DialogHeader title="Invite a user" closeId="invite-close" /></Localized><p className="mb-1 text-xs font-medium text-muted-foreground"><Message id="Account type" /></p><Localized aria-label="Invited user type"><div className="mb-4 grid grid-cols-2 rounded-md border bg-muted p-0.5" role="radiogroup" aria-label="Invited user type"><Button id="invite-external" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm"><Message id="External" /></Button><Button id="invite-internal" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm"><Message id="Internal" /></Button></div></Localized><p className="mb-1 text-xs font-medium text-muted-foreground"><Message id="Link use" /></p><Localized aria-label="Invitation use"><div className="mb-4 grid grid-cols-2 rounded-md border bg-muted p-0.5" role="radiogroup" aria-label="Invitation use"><Button id="invite-single" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm"><Message id="Single use" /></Button><Button id="invite-reusable" variant="ghost" size="sm" role="radio" className="h-8 [&.active]:bg-background [&.active]:shadow-sm"><Message id="Reusable for 7 days" /></Button></div></Localized><section className="space-y-2 border-t py-4"><label className="text-sm font-medium" htmlFor="invite-link"><Message id="Registration link" /></label><p id="invite-description" className="text-xs text-muted-foreground" /><Localized label="Copy"><CopyRow inputId="invite-link" buttonId="copy-invite-link" label="Copy" /></Localized></section><footer className="flex justify-end gap-2"><Button id="invite-regenerate" variant="outline"><Icon name="refresh-cw" /><Message id="New link" /></Button><Button id="invite-done"><Message id="Done" /></Button></footer></div></dialog>
      <dialog id="password-reset-link-dialog" className={dialogClass}><div className="p-5"><Localized title="Password reset link"><DialogHeader title="Password reset link" closeId="password-reset-link-close" /></Localized><p className="mb-4 text-sm text-muted-foreground"><Message id="Send this single-use link to the user. It expires in 7 days. Creating another link invalidates this one." /></p><Localized label="Copy"><CopyRow inputId="password-reset-link" buttonId="copy-password-reset-link" label="Copy" /></Localized><footer className="mt-5 flex justify-end"><Button id="password-reset-link-done"><Message id="Done" /></Button></footer></div></dialog>
    </>
  );
}
