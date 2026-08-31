/**
 * The web app transpiles the local @mocap-ts/core workspace package because
 * it ships raw ESM TypeScript sources (no prebuild step needed at dev time).
 * Next handles it via transpilePackages, so the core's .js/.d.ts aren't
 * required to run `next dev`.
 */
/**
 * The web app transpiles the local @mocap-ts/core workspace package because
 * it ships raw ESM TypeScript sources (no prebuild step needed at dev time).
 * Next handles it via transpilePackages, so the core's .js/.d.ts aren't
 * required to run `next dev`.
 */
const config = {
  transpilePackages: ['@mocap-ts/core', '@mocap-ts/tailwind-config'],
  reactStrictMode: true,
  // Core depends on native tensorflow bindings and node:fs — those can never
  // run in the browser bundle. They're imported only from instrumentation.ts
  // (server boot), never from route handlers.
  serverExternalPackages: [
    '@tensorflow/tfjs-node',
    '@tensorflow-models/pose-detection',
    '@mapbox/node-pre-gyp',
  ],
  experimental: {
    externalDir: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // The native tensorflow stack (@tensorflow/tfjs-node + its transitive
      // @mapbox/node-pre-gyp) must never be bundled: it shells out to a
      // native .node binary at runtime and its pre-gyp loader does a sync
      // directory require that webpack can't parse. Mark the whole subtree
      // external so Node resolves them from node_modules at runtime instead.
      const nativeExternal = (context, request, callback) => {
        if (
          /^@tensorflow(\/|\\)/.test(request) ||
          /^@mapbox\/node-pre-gyp(\/|\\)/.test(request) ||
          ['mock-aws-s3', 'aws-sdk', 'nock'].includes(request)
        ) {
          return callback(null, `commonjs ${request}`);
        }
        return callback();
      };
      config.externals = [nativeExternal, ...(config.externals ?? [])];
    }
    return config;
  },
};

export default config;
