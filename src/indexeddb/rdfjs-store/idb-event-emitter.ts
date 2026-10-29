import type * as rdfjs from "@rdfjs/types";

// The implementation listener is any-parameterized so the typed overloads
// below remain compatible with it (Node's own EventEmitter typings do the
// same); the overloads are what consumers see.
// deno-lint-ignore no-explicit-any
export type Listener = (...args: any[]) => void;

/**
 * IdbEventEmitter is the Node-style EventEmitter surface required by the
 * `rdfjs.Stream` interface, without depending on Node's `events` module.
 * Subclasses supply `on`, which may start the underlying source.
 */
export abstract class IdbEventEmitter {
  protected _listeners: Map<string | symbol, Listener[]> = new Map<
    string | symbol,
    Listener[]
  >();
  private _maxListeners = 10;

  public abstract on(eventName: string | symbol, listener: Listener): this;

  public addListener(eventName: string | symbol, listener: Listener): this {
    return this.on(eventName, listener);
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
}

/** IdbQuadStreamOptions customizes how raw cursor values become quads. */
export interface IdbQuadStreamOptions {
  accept?: (quad: rdfjs.Quad) => boolean;
  onRecord?: (cursor: IDBCursorWithValue) => void;
  decode?: (value: unknown) => rdfjs.Quad;
}
