import { defineConfig, type Options } from "tsup";

const shared: Options = {
  format: ["esm", "cjs"],
  target: "es2022",
  sourcemap: true,
  clean: false,
  // Declarations come from `tsc -p tsconfig.build.json`, not from tsup.
  // tsup's generator (rollup-plugin-dts) drives the TypeScript compiler API
  // directly and does not work with TypeScript 7.
  dts: false,
  // Deliberately off. `treeshake` makes tsup run a rollup pass after
  // esbuild, and that pass drops the "use client" banner below — the exact
  // bug this package would break on first. The package sets
  // `sideEffects: false`, so consumers' bundlers shake it anyway.
  treeshake: false,
  // Never bundle a provider SDK into paykit. They are optional peers and must
  // stay external so an app that installs only Stripe does not pay for PayPal.
  external: [
    "react",
    "react-dom",
    "@stripe/stripe-js",
    "@paypal/paypal-js",
    "stripe",
    "server-only",
  ],
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
    clean: true,
    // tsup strips directives from the bundle. Without this banner the
    // "use client" marker is lost and every import breaks in the App Router.
    banner: { js: '"use client";' },
  },
  {
    ...shared,
    entry: { "next/server": "src/next/server.ts" },
    // No "use client" here — this half is server-only by design.
  },
]);
