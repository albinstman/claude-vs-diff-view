import * as vscode from 'vscode';

/**
 * A pending PostToolUse HTTP response. Claude Code is blocked until
 * `release()` is called. Whichever component wants to delay the release
 * must call `claim()` synchronously while the editCompleted event is
 * being dispatched; otherwise the bridge responds immediately.
 */
export interface HoldHandle {
  readonly requestId: string;
  readonly claimed: boolean;
  readonly released: boolean;
  claim(): void;
  release(reason: string): void;
}

export interface EditStartedEvent {
  requestId: string;
  filePath: string;
  toolName: string;
  sessionId?: string;
  fileExisted: boolean;
  timestamp: number;
}

export interface EditCompletedEvent {
  requestId: string;
  filePath: string;
  toolName: string;
  sessionId?: string;
  /** File did not exist at PreToolUse time (Write created it). */
  created: boolean;
  timestamp: number;
  hold: HoldHandle;
}

export interface FileCreatedEvent {
  filePath: string;
  toolName: string;
  timestamp: number;
}

export interface ExternalChangeEvent {
  filePath: string;
  changeType: 'change' | 'create' | 'delete';
  timestamp: number;
}

/** Single internal event bus. Producers: HttpBridge, FsWatcherFallback. */
export class EventBus implements vscode.Disposable {
  private readonly _editStarted = new vscode.EventEmitter<EditStartedEvent>();
  private readonly _editCompleted = new vscode.EventEmitter<EditCompletedEvent>();
  private readonly _fileCreated = new vscode.EventEmitter<FileCreatedEvent>();
  private readonly _externalChange = new vscode.EventEmitter<ExternalChangeEvent>();
  private readonly _sessionReset = new vscode.EventEmitter<void>();

  readonly onEditStarted = this._editStarted.event;
  readonly onEditCompleted = this._editCompleted.event;
  readonly onFileCreated = this._fileCreated.event;
  readonly onExternalChange = this._externalChange.event;
  readonly onSessionReset = this._sessionReset.event;

  emitEditStarted(e: EditStartedEvent): void {
    this._editStarted.fire(e);
  }
  emitEditCompleted(e: EditCompletedEvent): void {
    this._editCompleted.fire(e);
  }
  emitFileCreated(e: FileCreatedEvent): void {
    this._fileCreated.fire(e);
  }
  emitExternalChange(e: ExternalChangeEvent): void {
    this._externalChange.fire(e);
  }
  emitSessionReset(): void {
    this._sessionReset.fire();
  }

  dispose(): void {
    this._editStarted.dispose();
    this._editCompleted.dispose();
    this._fileCreated.dispose();
    this._externalChange.dispose();
    this._sessionReset.dispose();
  }
}
