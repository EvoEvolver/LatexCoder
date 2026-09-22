import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

export type EditorSessionCallbacks = {
  onAwarenessChange: () => void;
  onSaved: () => void;
  onStatusChange: () => void;
  onSynced: () => void;
  onUnsavedChange: (unsaved: boolean) => void;
};

export type EditorSessionOptions = {
  authorId: string;
  authorName: string;
  editable: boolean;
  extensions: (text: Y.Text, provider: WebsocketProvider, editable: boolean) => Extension[];
  parent: HTMLElement;
  persistenceKey: string;
  room: string;
  socketUrl: string;
  callbacks: EditorSessionCallbacks;
};

/** Owns every resource associated with one open collaborative text file. */
export class EditorSession {
  readonly doc: Y.Doc;
  readonly persistence: IndexeddbPersistence | null;
  readonly provider: WebsocketProvider;
  readonly text: Y.Text;
  readonly view: EditorView;

  private disposed = false;
  private nonce = 0;

  constructor(private readonly options: EditorSessionOptions) {
    this.doc = new Y.Doc();
    this.provider = new WebsocketProvider(options.socketUrl, options.room, this.doc, {
      connect: true,
      params: {
        saved: "1",
        authorId: options.authorId,
        authorName: options.authorName,
      },
    });
    this.text = this.doc.getText("content");
    this.persistence = options.editable ? new IndexeddbPersistence(options.persistenceKey, this.doc) : null;
    this.view = new EditorView({
      state: EditorState.create({ doc: "", extensions: options.extensions(this.text, this.provider, options.editable) }),
      parent: options.parent,
    });

    this.provider.messageHandlers[3] = (_encoder, decoder) => {
      const savedNonce = decoding.readVarString(decoder);
      if (!this.disposed && savedNonce === String(this.nonce)) {
        this.options.callbacks.onUnsavedChange(false);
        this.options.callbacks.onSaved();
      }
    };
    this.doc.on("update", (_update, origin) => {
      if (this.disposed || !options.editable || origin === this.provider) return;
      this.nonce += 1;
      this.requestSave();
    });
    this.provider.on("status", this.options.callbacks.onStatusChange);
    this.provider.on("sync", this.handleSync);
    this.provider.awareness.on("change", this.options.callbacks.onAwarenessChange);
    this.options.callbacks.onUnsavedChange(options.editable);
  }

  get synced(): boolean {
    return this.provider.synced;
  }

  requestSave(): void {
    if (this.disposed || !this.options.editable) return;
    this.options.callbacks.onUnsavedChange(true);
    if (this.provider.wsconnected && this.provider.synced) {
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, 3);
      encoding.writeVarString(message, String(this.nonce));
      this.provider.ws.send(encoding.toUint8Array(message));
    }
    this.options.callbacks.onStatusChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.provider.off("status", this.options.callbacks.onStatusChange);
    this.provider.off("sync", this.handleSync);
    this.provider.awareness.off("change", this.options.callbacks.onAwarenessChange);
    this.view.destroy();
    this.provider.destroy();
    this.persistence?.destroy();
    this.doc.destroy();
  }

  private readonly handleSync = (synced: boolean): void => {
    if (this.disposed || !synced) return;
    if (this.options.editable) this.requestSave();
    else this.options.callbacks.onStatusChange();
    this.options.callbacks.onSynced();
  };
}
