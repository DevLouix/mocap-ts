/**
 * Ambient declarations for optional @tensorflow/tfjs backend packages.
 *
 * These packages are NOT installed by default (the core only depends on
 * @tensorflow/tfjs-node). They are loaded dynamically at runtime only when a
 * caller requests a non-CPU backend (e.g. `backend: 'webgpu'`). Declaring
 * them here lets the dynamic import typecheck whether or not they're
 * installed; a missing package fails at runtime, gracefully.
 */
declare module '@tensorflow/tfjs-webgpu' {
  export const registerWebGPUBackend: () => void;
}
