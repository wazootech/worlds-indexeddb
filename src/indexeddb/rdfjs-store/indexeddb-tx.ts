/**
 * txDone resolves when an IndexedDB transaction settles — resolves on
 * `complete`, rejects on `abort`/`error`.
 */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        tx.error ?? new Error("IndexedDB transaction aborted"),
      );
    tx.onerror = () =>
      reject(
        tx.error ?? new Error("IndexedDB transaction failed"),
      );
  });
}
