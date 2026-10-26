#!/usr/bin/env bun

import { MUTAGEN_VERSION, MUTAGEN_TARBALL_SHA256, sha256File } from "../src/sync/download";

const PLATFORMS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "amd64" },
  { platform: "linux", arch: "amd64" },
  { platform: "linux", arch: "arm64" },
] as const;

async function downloadMutagen({ platform, arch }: (typeof PLATFORMS)[number]): Promise<void> {
  const { mkdirSync, existsSync, createWriteStream, renameSync, rmSync } = await import("fs");
  const { pipeline } = await import("stream/promises");

  const assetsDir = "./assets/mutagen";
  
  if (!existsSync(assetsDir)) {
    mkdirSync(assetsDir, { recursive: true });
  }

  const url = `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_${platform}_${arch}_v${MUTAGEN_VERSION}.tar.gz`;
  const outputFile = `${assetsDir}/mutagen-${platform}-${arch}.tar.gz`;
  // The same pinned hashes the CLI checks at runtime (src/sync/download.ts).
  const expected = MUTAGEN_TARBALL_SHA256[`${platform}_${arch}`];

  if (existsSync(outputFile) && (await sha256File(outputFile)) === expected) {
    console.log(`  ⏭ ${platform}/${arch} already exists`);
    return;
  }

  console.log(`  ⬇ ${platform}/${arch}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.statusText}`);
  }

  const tempFile = `${outputFile}.download`;
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(tempFile));

  const actual = await sha256File(tempFile);
  if (actual !== expected) {
    rmSync(tempFile, { force: true });
    throw new Error(`${platform}/${arch}: SHA-256 ${actual} does not match the pinned ${expected}`);
  }
  renameSync(tempFile, outputFile);

  console.log(`  ✓ ${platform}/${arch}`);
}

async function main(): Promise<void> {
  console.log(`Downloading Mutagen v${MUTAGEN_VERSION} binaries...\n`);

  for (const target of PLATFORMS) {
    await downloadMutagen(target);
  }

  console.log("\nDone! Mutagen binaries are in ./assets/mutagen/");
  console.log("Note: These are .tar.gz archives. The CLI extracts them at runtime.");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
