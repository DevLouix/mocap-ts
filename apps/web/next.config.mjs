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
  transpilePackages: [
    '@mocap-ts/core',
    '@mocap-ts/tailwind-config',
  ],
  reactStrictMode: true,
  // Core depends on native tensorflow bindings and node:fs — those can never
  // run in the browser bundle. They're imported only from instrumentation.ts
  // (server boot), never from route handlers.
  serverExternalPackages: [
    '@tensorflow/tfjs-node',
    '@tensorflow-models/pose-detection',
    '@mapbox/node-pre-gyp',
    'pg',
    'bullmq',
    'ioredis',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
    '@mocap-ts/db',
    '@mocap-ts/queue',
    '@mocap-ts/storage',
    '@valkey/valkey-glide',
  ],
  experimental: {
    externalDir: true,
  },
  webpack: (config, { isServer, nextRuntime }) => {
    if (isServer && nextRuntime === 'nodejs') {
      // Two classes of modules must never be bundled into the server graph:
      //
      //  1. node: builtins — dev-mode webpack chokes on the "node:" URI
      //     scheme (UnhandledSchemeError) when they appear in the
      //     /instrumentation compile, so externalize them explicitly.
      //     Also use the object-form signature to avoid the webpack
      //     DEP_WEBPACK_EXTERNALS_FUNCTION_PARAMETERS deprecation.
      //  2. The native tensorflow stack (@tensorflow/tfjs-node + its
      //     transitive @mapbox/node-pre-gyp) — it loads a native .node
      //     binary at runtime and its pre-gyp loader does a sync directory
      //     require that webpack can't parse.
      // BullMQ supports an optional Valkey client, but this deployment uses
      // ioredis. Marking it absent prevents webpack from warning about an
      // intentionally uninstalled optional package.
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        '@valkey/valkey-glide': false,
      };
      config.externals = [
        ({ request }, callback) => {
          if (typeof request !== 'string') return callback();
          if (request.startsWith('node:')) {
            return callback(null, `commonjs ${request}`);
          }
          if (
            /^@tensorflow(\/|\\)/.test(request) ||
            /^@mapbox\/node-pre-gyp(\/|\\)/.test(request) ||
            ['mock-aws-s3', 'aws-sdk', 'nock'].includes(request)
          ) {
            return callback(null, `commonjs ${request}`);
          }
          return callback();
        },
        ...(config.externals ?? []),
      ];
    }
    return config;
  },
};

export default config;
