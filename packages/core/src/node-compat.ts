/**
 * Node.js compat shim for @tensorflow/tfjs-node on Node ≥ 23.
 *
 * tfjs-node 4.22.0 (current latest) still calls `util.isNullOrUndefined`,
 * which was deprecated for years and REMOVED in Node.js 23+. On Node 23/24
 * any TF memory call (e.g. `tf.memory()` during pose estimation) throws:
 *
 *   TypeError: (0 , util_1.isNullOrUndefined) is not a function
 *
 * Upstream issue: https://github.com/tensorflow/tfjs/issues/8609
 *
 * We patch the CJS `util` module exports in place — the same module object
 * tfjs-node's `require("util")` resolves to — with the trivial polyfill.
 * This must be imported BEFORE any @tensorflow/tfjs-node import so the
 * patch is in place when tfjs-node evaluates and calls into it.
 *
 * Safe on every Node version: if the helper exists (Node ≤ 22), this is a
 * no-op.
 */
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);

// Resolve through CJS require: the ESM namespace object for builtins is
// sealed, but the underlying CJS exports object (which is what tfjs-node's
// `require("util")` returns) is extensible and shared module-wide.
type UtilWithLegacy = { isNullOrUndefined?: (v: unknown) => boolean };
const util = req('util') as UtilWithLegacy;

if (typeof util.isNullOrUndefined !== 'function') {
  util.isNullOrUndefined = (v: unknown) => v === null || v === undefined;
}
