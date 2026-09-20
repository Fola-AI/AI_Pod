import type { NextConfig } from "next";
import { execSync } from "node:child_process";

// The git SHA the build was made from, baked into the bundle at build time so the
// footer can show what's actually running. Vercel provides VERCEL_GIT_COMMIT_SHA;
// locally we read it from git, falling back to "dev".
function buildSha(): string {
  const vercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (vercel) return vercel.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_SHA: buildSha(),
  },
};

export default nextConfig;
