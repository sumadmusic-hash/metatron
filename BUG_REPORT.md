# Bug Report — `@audiotool/nexus`

**Title:** `SyncedDocument.modify()` leaks the transaction lock permanently on any rejected modification

**Package/Version:** `@audiotool/nexus` `0.0.17` — `dist/synced-document-ywEybIAl.js`

**Type:** blocking runtime bug (deadlock), no crash

---

## Summary

`SyncedDocument.modify()` has no `try/finally` around its transaction lifecycle. If the mutation callback throws (e.g. a `t.create` / `t.update` validation failure) or if `send()` / `finish()` fails, the exclusive document transaction lock is never released. Every subsequent `modify` / `createTransaction` call — and even `stop()` / `terminate()` — then awaits that lock forever. The document instance is permanently deadlocked, silently, until it is discarded.

## Relevant code (minified source)

```js
// SyncedDocument.modify()
async modify(t, e) {
  const n = await this.createTransaction(e), a = await t(n);
  return n.send(), a;            // no try/finally
}
```

`createTransaction()` acquires the lock here …

```js
async createTransaction(t, e = !0) {
  const n = e ? await l(this, E).acquire() : void 0;
  // ...
  return bo({
    applyModification: (d, u) => {
      const m = x(this, mt, yn).call(this, d, { local: !0, throwIfInvalid: u, actionId: c });
      // ...
    },
    finish: () => {             // ONLY lock release path
      return a.length === 0 ? (n?.release(), [])
        : (l(this, L).send(new B({ modifications: a })), n?.release(), a);
    },
    query: r
  });
}
```

… and the lock is released **only** inside `finish()`, i.e. only when `send()` is reached. Two leak paths:

1. **Callback throws** — `t.create` / `t.update` call `applyModification(…, throwIfInvalid = !0)`, so a validation failure throws `Error("modification failed validation: …")` out of the callback → `modify()` rejects → `n.send()` never runs → `n.release()` never runs.
2. **`send()` fails** — `finish()` releases the lock *after* `gateway.send()`, so a gateway / network error throws before `n.release()` → same leak.

Additionally, `terminate()` (stop) begins with `await acquire()` on the same lock, so a leaked lock makes even `document.stop()` hang — reconnect and teardown are impossible.

## Minimal reproduction (offline, no network required)

```js
import { createOfflineDocument } from "@audiotool/nexus/node";

const doc = await createOfflineDocument({ validated: true });

// Force one rejected modification (here: automationEvent.value out of range [0,1]):
await doc.modify((t) => t.create("automationEvent", {
  collection: t.create("automationCollection", {}).location,
  positionTicks: 0, value: 2.5, interpolation: 2, slope: 0,
})); // → rejects: "modification failed validation: value 2.5 out of range [0, 1]"

// Every subsequent call now hangs forever (queued on the leaked lock):
const result = await Promise.race([
  doc.modify(() => {}).then(() => "resolved"),
  new Promise((r) => setTimeout(() => r("HANGS"), 1000)),
]);
console.log(result); // -> "HANGS"  (also await doc.stop() behaves identically)
```

## Expected behavior

A rejected `modify()` (or `send()` failure) must not corrupt the document instance: the lock must be released and the document remain usable for subsequent transactions.

## Suggested fix

1. Add `try/finally` to `modify()`:

   ```js
   async modify(fn, opts) {
     const tx = await this.createTransaction(opts);
     try {
       const result = await fn(tx);
       tx.send();          // releases the lock
       return result;
     } catch (e) {
       tx.abort();         // NEW: release the lock WITHOUT sending buffered modifications
       throw e;
     }
   }
   ```

2. Add an `abort()` / discard capability to `TransactionBuilder` that calls `lock.release()` without sending the buffered modifications (currently the only release paths are an empty `finish()` or a successful send).

3. In `finish()`, release the lock *before* `gateway.send()` (or wrap send in try/finally) so a transport error can never leak the lock:

   ```js
   finish: () => {
     const mods = a.slice();
     n?.release();                     // release first
     return mods.length === 0 ? [] : (l(this, L).send(new B({ modifications: mods })), mods);
   }
   ```

4. Consider exposing a non-throwing validation path (`throwIfInvalid: false` already exists internally) so callers can pre-validate without risking a leak.

## Impact observed in our integration (Metatron)

One failed automation write (a schema validation error in a single `t.create`) rejected `modify()` and thereafter every parameter write, re-learn, and reconnect `stop()` blocked forever — bindings showed as connected ("green") but were silently dead; only discarding the document (page reload) recovered. From the API surface the wedge is a *pending* promise with no error event, making it extremely hard for downstream code to even detect it. This SDK behavior turns one routine validation error into a permanent document outage.