import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  basePath: "/power",
  turbopack: {
    root,
  },
};

export default nextConfig;
