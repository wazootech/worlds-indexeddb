import type * as rdfjs from "@rdfjs/types";

// The implementation listener is any-parameterized so the typed overloads
// below remain compatible with it (Node's own EventEmitter typings do the
// same); the overloads are what consumers see.
// deno-lint-ignore no-explicit-any
type Listener = (...args: any[]) => void;

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
export class IdbQuadStream implements rdfjs.Stream<rdfjs.Quad> {
  private _listeners = new Map<string | symbol, Listener[]>();
  private _maxListeners = 10;
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
    private readonly options: {
      accept?: (quad: rdfjs.Quad) => boolean;
      onRecord?: (cursor: IDBCursorWithValue) => void;
      decode?: (value: unknown) => rdfjs.Quad;
    } = {},
  ) {}

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

  public addListener(eventName: string | symbol, listener: Listener): this {
    return this.on(eventName, listener);
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

  public once(eventName: "data", listener: (quad: rdfjs.Quad) => void): this;
  public once(eventName: "readable", listener: () => void): this;
  public once(eventName: "end", listener: () => void): this;
  public once(eventName: "error", listener: (error: Error) => void): this;
  public once(eventName: string | symbol, listener: Listener): this;
  public once(eventName: string | symbol, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.removeListener(eventName, wrapper);
      listener(...args);
    };
    return this.on(eventName, wrapper);
  }

  public prependListener(
    eventName: "data",
    listener: (quad: rdfjs.Quad) => void,
  ): this;
  public prependListener(eventName: "readable", listener: () => void): this;
  public prependListener(eventName: "end", listener: () => void): this;
  public prependListener(
    eventName: "error",
    listener: (error: Error) => void,
  ): this;
  public prependListener(eventName: string | symbol, listener: Listener): this;
  public prependListener(eventName: string | symbol, listener: Listener): this {
    const list = this._listeners.get(eventName);
    if (list) {
      list.unshift(listener);
    } else {
      this._listeners.set(eventName, [listener]);
    }
    return this;
  }

  public prependOnceListener(
    eventName: "data",
    listener: (quad: rdfjs.Quad) => void,
  ): this;
  public prependOnceListener(eventName: "readable", listener: () => void): this;
  public prependOnceListener(eventName: "end", listener: () => void): this;
  public prependOnceListener(
    eventName: "error",
    listener: (error: Error) => void,
  ): this;
  public prependOnceListener(
    eventName: string | symbol,
    listener: Listener,
  ): this {
    const wrapper: Listener = (...args) => {
      this.removeListener(eventName, wrapper);
      listener(...args);
    };
    return this.prependListener(eventName, wrapper);
  }

  public removeListener(eventName: string | symbol, listener: Listener): this {
    const list = this._listeners.get(eventName);
    if (list) {
      const index = list.indexOf(listener);
      if (index >= 0) {
        list.splice(index, 1);
      }
    }
    return this;
  }

  public off(eventName: string | symbol, listener: Listener): this {
    return this.removeListener(eventName, listener);
  }

  public removeAllListeners(eventName?: string | symbol): this {
    if (eventName === undefined) {
      this._listeners.clear();
    } else {
      this._listeners.delete(eventName);
    }
    return this;
  }

  public setMaxListeners(n: number): this {
    this._maxListeners = n;
    return this;
  }

  public getMaxListeners(): number {
    return this._maxListeners;
  }

  public listeners(eventName: string | symbol): Listener[] {
    return [...(this._listeners.get(eventName) ?? [])];
  }

  public rawListeners(eventName: string | symbol): Listener[] {
    return [...(this._listeners.get(eventName) ?? [])];
  }

  public emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const list = this._listeners.get(eventName);
    if (!list || list.length === 0) {
      return false;
    }
    for (const fn of [...list]) {
      fn.apply(this, args);
    }
    return true;
  }

  public listenerCount(eventName: string | symbol): number {
    return this._listeners.get(eventName)?.length ?? 0;
  }

  public eventNames(): Array<string | symbol> {
    return [...this._listeners.keys()];
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
        request.onsuccess = () => {
          if (this._ended) {
            return;
          }
          const cursor = request.result;
          if (cursor === null) {
            this._cursorDone = true;
            this._maybeEnd();
            return;
          }
          const quad = this.options.decode
            ? this.options.decode(cursor.value)
            : cursor.value as unknown as rdfjs.Quad;
          if (this.options.accept && !this.options.accept(quad)) {
            cursor.continue();
            return;
          }
          this.options.onRecord?.(cursor);
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
          cursor.continue();
        };
        request.onerror = () => {
          if (!this._ended) {
            this.emit(
              "error",
              request.error ?? new Error("IndexedDB cursor request failed"),
            );
          }
        };
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
