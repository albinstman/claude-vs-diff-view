import * as vscode from 'vscode';
import * as http from 'http';
import { EventBus, HoldHandle } from '../core/events';
import { Config } from '../core/config';
import { SessionStore } from '../core/sessionStore';

const MAX_BODY_BYTES = 64 * 1024 * 1024; // hook payloads carry file contents
const PORT_PROBE_RANGE = 10;
const PRE_SNAPSHOT_TIMEOUT_MS = 2000;

interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  session_id?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Tools whose PostToolUse response we may delay (the hold point). */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

class PendingHold implements HoldHandle {
  claimed = false;
  released = false;
  private safetyTimer?: NodeJS.Timeout;

  constructor(
    readonly requestId: string,
    private readonly res: http.ServerResponse,
    private readonly log: vscode.OutputChannel,
    safetyMs: number
  ) {
    // Absolute backstop independent of DiffController logic: never let a
    // wedged response outlive the hook timeout.
    if (safetyMs > 0) {
      this.safetyTimer = setTimeout(() => this.release('bridge safety timeout'), safetyMs);
    }
  }

  claim(): void {
    this.claimed = true;
  }

  release(reason: string): void {
    if (this.released) {
      return;
    }
    this.released = true;
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
    }
    try {
      this.res.writeHead(200, { 'Content-Type': 'application/json' });
      this.res.end('{}');
    } catch (err) {
      this.log.appendLine(`[bridge] failed to respond (${this.requestId}): ${String(err)}`);
    }
    this.log.appendLine(`[bridge] released ${this.requestId} (${reason})`);
  }
}

/**
 * Localhost HTTP server receiving Claude Code hook events. PreToolUse is
 * answered as fast as possible (after snapshotting); PostToolUse responses
 * are handed to whoever claims the hold (DiffController).
 */
export class HttpBridge implements vscode.Disposable {
  private server?: http.Server;
  private _port?: number;
  private requestCounter = 0;
  private readonly pending = new Map<string, PendingHold>();
  private restartQueued = false;

  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this._onDidChangeState.event;
  lastEventAt = 0;
  lastError = '';

  constructor(
    private readonly bus: EventBus,
    private readonly config: Config,
    private readonly store: SessionStore,
    private readonly storageUri: vscode.Uri,
    private readonly log: vscode.OutputChannel
  ) {}

  get port(): number | undefined {
    return this._port;
  }

  get running(): boolean {
    return !!this.server?.listening;
  }

  async start(): Promise<void> {
    await this.stop();
    const basePort = this.config.port;
    for (let candidate = basePort; candidate <= basePort + PORT_PROBE_RANGE; candidate++) {
      try {
        await this.listenOn(candidate);
        this._port = candidate;
        if (candidate !== basePort) {
          this.log.appendLine(
            `[bridge] port ${basePort} busy — listening on ${candidate} instead`
          );
          void vscode.window.showWarningMessage(
            `Claude Bridge: port ${basePort} was busy; listening on ${candidate}. Update your hooks URL or free the port.`
          );
        } else {
          this.log.appendLine(`[bridge] listening on 127.0.0.1:${candidate}`);
        }
        await this.writePortFile(candidate);
        this._onDidChangeState.fire();
        return;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          throw err;
        }
      }
    }
    this.lastError = `all ports ${basePort}–${basePort + PORT_PROBE_RANGE} busy`;
    this.log.appendLine(`[bridge] ERROR: ${this.lastError}`);
    void vscode.window.showErrorMessage(`Claude Bridge: ${this.lastError}`);
    this._onDidChangeState.fire();
  }

  /** Restart on port setting change (debounced to one restart per tick). */
  queueRestart(): void {
    if (this.restartQueued) {
      return;
    }
    this.restartQueued = true;
    setImmediate(() => {
      this.restartQueued = false;
      void this.start();
    });
  }

  private listenOn(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.once('error', (err) => {
        server.close();
        reject(err);
      });
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        server.on('error', (err) => {
          this.lastError = String(err);
          this.log.appendLine(`[bridge] server error: ${this.lastError}`);
          this._onDidChangeState.fire();
        });
        this.server = server;
        resolve();
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Top-level guard: never let a bug wedge the response.
    const failSafe = setTimeout(() => {
      if (!res.headersSent && !res.writableEnded) {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{}');
        } catch {
          /* socket gone */
        }
      }
    }, 100);

    try {
      if (req.method !== 'POST' || !req.url?.startsWith('/event')) {
        clearTimeout(failSafe);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      clearTimeout(failSafe); // body streaming legitimately takes time
      this.readBody(req)
        .then((body) => this.routeEvent(body, res))
        .catch((err) => {
          this.log.appendLine(`[bridge] request error: ${String(err)}`);
          this.respondNow(res, 400);
        });
    } catch (err) {
      clearTimeout(failSafe);
      this.log.appendLine(`[bridge] handler error: ${String(err)}`);
      this.respondNow(res, 500);
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private async routeEvent(body: string, res: http.ServerResponse): Promise<void> {
    let payload: HookPayload;
    try {
      payload = JSON.parse(body) as HookPayload;
    } catch {
      this.respondNow(res, 400);
      return;
    }

    this.lastEventAt = Date.now();
    this._onDidChangeState.fire();

    const eventName = payload.hook_event_name ?? '';
    const toolName = payload.tool_name ?? '';
    const filePath = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
    // Log paths only — payloads contain file contents.
    this.log.appendLine(`[bridge] ${eventName} ${toolName} ${filePath ?? '(no path)'}`);

    if (!filePath || !EDIT_TOOLS.has(toolName)) {
      this.respondNow(res, 200);
      return;
    }

    const requestId = `r${++this.requestCounter}`;

    if (eventName === 'PreToolUse') {
      // Snapshot BEFORE responding (the edit runs only once we answer), but
      // never stall Claude: fail open after a short timeout.
      let existed = true;
      try {
        const result = await Promise.race([
          this.store.snapshotFile(filePath),
          new Promise<{ existed: boolean }>((resolve) =>
            setTimeout(() => resolve({ existed: true }), PRE_SNAPSHOT_TIMEOUT_MS)
          ),
        ]);
        existed = result.existed;
      } catch (err) {
        this.log.appendLine(`[bridge] snapshot failed for ${filePath}: ${String(err)}`);
      }
      this.bus.emitEditStarted({
        requestId,
        filePath,
        toolName,
        sessionId: payload.session_id,
        fileExisted: existed,
        timestamp: Date.now(),
      });
      this.respondNow(res, 200);
      return;
    }

    if (eventName === 'PostToolUse') {
      const record = this.store.getRecord(filePath);
      const created =
        !!record &&
        record.snapshots.length > 0 &&
        record.snapshots[record.snapshots.length - 1].isNull &&
        record.editCount === 0;

      const safetyMs =
        this.config.holdHookTimeoutSeconds * 1000 - this.config.holdTimeoutSafetyMs;
      const hold = new PendingHold(requestId, res, this.log, safetyMs);
      this.pending.set(requestId, hold);
      res.on('close', () => this.pending.delete(requestId));

      try {
        this.bus.emitEditCompleted({
          requestId,
          filePath,
          toolName,
          sessionId: payload.session_id,
          created,
          timestamp: Date.now(),
          hold,
        });
        if (created) {
          this.bus.emitFileCreated({ filePath, toolName, timestamp: Date.now() });
        }
      } finally {
        // Nobody claimed the hold (holds disabled / controller error) →
        // respond immediately so Claude is never blocked by accident.
        if (!hold.claimed) {
          hold.release('unclaimed');
        }
      }
      return;
    }

    this.respondNow(res, 200);
  }

  private respondNow(res: http.ServerResponse, status: number): void {
    if (res.headersSent || res.writableEnded) {
      return;
    }
    try {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{}');
    } catch {
      /* socket gone */
    }
  }

  private async writePortFile(port: number): Promise<void> {
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(this.storageUri, 'port'),
        new TextEncoder().encode(String(port))
      );
    } catch (err) {
      this.log.appendLine(`[bridge] could not write port file: ${String(err)}`);
    }
  }

  async stop(): Promise<void> {
    for (const hold of this.pending.values()) {
      hold.release('bridge stopping');
    }
    this.pending.clear();
    const server = this.server;
    this.server = undefined;
    this._port = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close() waits for open sockets; force-resolve quickly.
        setTimeout(resolve, 500);
        server.closeAllConnections?.();
      });
    }
  }

  dispose(): void {
    void this.stop();
    this._onDidChangeState.dispose();
  }
}
