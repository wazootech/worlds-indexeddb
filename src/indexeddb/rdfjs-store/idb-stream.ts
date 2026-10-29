import type * as rdfjs from "@rdfjs/types";

import {
  IdbEventEmitter,
  type IdbQuadStreamOptions,
  type Listener,
} from "@/indexeddb/rdfjs-store/idb-event-emitter.ts";
import { wireCursorRequest } from "@/indexeddb/rdfjs-store/idb-cursor.ts";

/**
 * IdbQuadStream is a minimal RDF/JS Stream backed by an IndexedDB cursor,
 * with the same listener semantics as `@worlds/sqlite`'s MemoryStream but
 * driven asynchronously by IDB request events:
 *
 * - attaching a `data` listener switches to flow mode and emits each quad as
 *   the cursor advances,
 * - attaching a `readable` listener (or calling `read()`) enables pull mode,
 * - attaching only `end`/`error` listeners (a bare completion signal) runs
 *   the cursor to exhaustion and ends,
 * - `end` is only emitted after the cursor is exhausted and every quad has
 *   been consumed.
 *
 * It implements the full EventEmitter surface required by the `rdfjs.Stream`
 * interface without depending on Node's `events` module, keeping the package
 * runtime dependency-free and browser-friendly.
 */
export class IdbQuadStream extends IdbEventEmitter
  implements rdfjs.Stream<rdfjs.Quad> {
  private _ended = false;
  private _flowing = false;
  private _readStarted = false;
  private _started = false;
  private _cursorDone = false;
  private _buffer: rdfjs.Quad[] = [];

  /**
   * open opens the IDB cursor. It is invoked lazily — after listeners attach
   * — and must resolve to the request whose `onsuccess`/`onerror` the stream
   * wires. The request's result is the cursor (or null when exhausted). The
   * opener may be async (e.g. to run count-based access-path selection
   * first); the stream assigns handlers before any IDB event can fire, since
   * IDB events are macrotasks.
   *
   * accept filters decoded quads before they are emitted or buffered (used
   * to apply unindexed match() positions after cursor access-path selection).
   *
   * onRecord runs against the live cursor before it advances (used to
   * `delete()` in a readwrite cursor, as removeMatches does).
   *
   * decode converts each raw cursor value into a quad (defaults to identity
   * for stores whose records already are quads).
   */
  public constructor(
    private readonly open: () => Promise<IDBRequest<IDBCursorWithValue | null>>,
    private readonly options: IdbQuadStreamOptions = {},
  ) {
    super();
  }

  public read(): rdfjs.Quad | null {
    this._readStarted = true;
    this._ensureStarted();
    const quad = this._buffer.shift();
    if (quad === undefined) {
      if (this._cursorDone) {
        this._end();
      }
      return null;
    }
    return quad;
  }

  public [Symbol.iterator](): Iterator<rdfjs.Quad> {
    return this._buffer[Symbol.iterator]();
  }

  public destroy(error?: Error): void {
    if (error) {
      this.emit("error", error);
    }
    this._ended = true;
    this.removeAllListeners();
  }

  /** Typed overloads mirror the Node-style surface of rdfjs.Stream. */
  public on(eventName: "data", listener: (quad: rdfjs.Quad) => void): this;
  public on(eventName: "readable", listener: () => void): this;
  public on(eventName: "end", listener: () => void): this;
  public on(eventName: "error", listener: (error: Error) => void): this;
  public on(eventName: string | symbol, listener: Listener): this;
  public on(eventName: string | symbol, listener: Listener): this {
    const list = this._listeners.get(eventName);
    if (list) {
      list.push(listener);
    } else {
      this._listeners.set(eventName, [listener]);
    }
    if (eventName === "data" && !this._ended && !this._flowing) {
      this._flowing = true;
      this._ensureStarted();
    }
    if (eventName === "readable" && !this._ended) {
      this._readStarted = true;
      this._ensureStarted();
    }
    if (eventName === "end" && !this._ended) {
      this._ensureStarted();
    }
    return this;
  }

  /**
   * _ensureStarted lazily opens the cursor on a microtask — after listeners
   * attach synchronously — then drives it to completion.
   */
  private _ensureStarted(): void {
    if (this._started || this._ended) {
      return;
    }
    this._started = true;
    queueMicrotask(() => {
      if (this._ended) {
        return;
      }
      this.open().then((request) => {
        if (this._ended) {
          return;
        }
        wireCursorRequest(request, this.options, {
          isEnded: () => this._ended,
          onDone: () => {
            this._cursorDone = true;
            this._maybeEnd();
          },
          onQuad: (quad) => {
            if (this._flowing) {
              this.emit("data", quad);
            } else if (this._readStarted) {
              // Pull mode: buffer for read().
              this._buffer.push(quad);
              this.emit("readable");
            }
            // Bare completion mode (end/error listeners only): quads are
            // skipped — the cursor still runs to exhaustion so the delete
            // hook and end signal fire.
          },
          onError: (error) => this.emit("error", error),
        });
      }).catch((error: unknown) => {
        if (!this._ended) {
          this.emit(
            "error",
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    });
  }

  /**
   * _maybeEnd ends the stream once the cursor is exhausted and every quad
   * has been consumed (or nothing is consuming — a bare completion signal).
   */
  private _maybeEnd(): void {
    if (this._cursorDone && this._buffer.length === 0) {
      this._end();
    }
  }

  private _end(): void {
    if (this._ended) {
      return;
    }
    this._ended = true;
    this.emit("end");
  }
}
