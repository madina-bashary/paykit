import type { NextConfig } from "next";

const config: NextConfig = {
  // paykit ships ESM + CJS already built; nothing to transpile.
  reactStrictMode: true,
};

export default config;
