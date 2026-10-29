import type * as rdfjs from "@rdfjs/types";
import type { IdbQuadStreamOptions } from "@/indexeddb/rdfjs-store/idb-event-emitter.ts";

/** CursorSink receives the events of a wired cursor request. */
export interface CursorSink {
  isEnded(): boolean;
  onDone(): void;
  onQuad(quad: rdfjs.Quad): void;
  onError(error: Error): void;
}

/**
 * wireCursorRequest drives an IDB cursor request to exhaustion: each record
 * is decoded, filtered by `accept`, passed to `onRecord`, delivered to the
 * sink, and the cursor advances.
 */
export function wireCursorRequest(
  request: IDBRequest<IDBCursorWithValue | null>,
  options: IdbQuadStreamOptions,
  sink: CursorSink,
): void {
  request.onsuccess = () => {
    if (sink.isEnded()) {
      return;
    }
    const cursor = request.result;
    if (cursor === null) {
      sink.onDone();
      return;
    }
    const quad = options.decode
      ? options.decode(cursor.value)
      : cursor.value as unknown as rdfjs.Quad;
    if (options.accept && !options.accept(quad)) {
      cursor.continue();
      return;
    }
    options.onRecord?.(cursor);
    sink.onQuad(quad);
    cursor.continue();
  };
  request.onerror = () => {
    if (!sink.isEnded()) {
      sink.onError(
        request.error ?? new Error("IndexedDB cursor request failed"),
      );
    }
  };
}
