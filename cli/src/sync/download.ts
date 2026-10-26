import { chmodSync, createWriteStream, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "fs";
import { pipeline } from "stream/promises";
import { getDataDir } from "../utils/paths";

export const MUTAGEN_VERSION = "0.17.6";

type Platform = "darwin" | "linux";
type Arch = "amd64" | "arm64";
type Target = `${Platform}_${Arch}`;

// Mutagen runs on every sync with the user's full privileges, so what runs must be exactly what
// mutagen-io published. These are copied from that release's SHA256SUMS
// (https://github.com/mutagen-io/mutagen/releases/download/v0.17.6/SHA256SUMS). A bump of
// MUTAGEN_VERSION has to replace all three tables, from the new release's SHA256SUMS and the files
// inside its tarballs; a download that does not match is refused, never installed.
export const MUTAGEN_TARBALL_SHA256: Record<Target, string> = {
  darwin_amd64: "f082eef2ae405a6bf5effdbcd000bb5fe2bc7b0968f86b2b54d9d3260c48c739",
  darwin_arm64: "b6c35942ca9cbbbf726bfa249da554d829a8a28cad620a55e02d098d692121d1",
  linux_amd64: "1b826e121be59506e133d90dc2b8a0c820b92f480d9b2b230d8b389d6178a6cf",
  linux_arm64: "2a383cb572a1bdad83f7c4be3cc4a541a58e6c9e11e326ee4cc2d0e14f9d003a",
};

// The two files inside each tarball, hashed after extracting the verified tarballs above. The
// installed binary is checked against these on every run that uses it, so a partial install, a
// leftover from another version or a replaced file is reinstalled instead of executed.
const MUTAGEN_BINARY_SHA256: Record<Target, string> = {
  darwin_amd64: "1534554d291364fc3c6ed67ef6c4fab70ee87ab5873d44acae176604088f12db",
  darwin_arm64: "43c95e679e3166ca947764fc91545c0f2bee80a60ef5806f16517e4a02109f15",
  linux_amd64: "04d5dee7077996aa6a270aab5707ec705aebeebac72ac5cd97d5ffa8f4ce157c",
  linux_arm64: "890c4fdad28e4237cb79a50e399666c177326ed4f3f3d19616343e063a2726ea",
};
// The same agent bundle ships in all four tarballs. It is copied to the workspace, never run here.
const MUTAGEN_AGENTS_SHA256 = "38f4868355d0c560bb537ee3c2d0ebb998f50b1c8405e6d0d1665303c6134909";

function getMutagenBinDir(): string {
  return `${getDataDir()}/mutagen/bin`;
}

export function getMutagenPath(): string {
  return `${getMutagenBinDir()}/mutagen`;
}

export function getMutagenAgentPath(): string {
  return `${getMutagenBinDir()}/mutagen-agents.tar.gz`;
}

function detectPlatform(): Platform {
  const platform = process.platform;
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  throw new Error(`Unsupported platform: ${platform}. Haven CLI supports macOS and Linux only.`);
}

function detectArch(): Arch {
  const arch = process.arch;
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "amd64";
  throw new Error(`Unsupported architecture: ${arch}. Haven CLI supports x64 and arm64 only.`);
}

function getMutagenDownloadUrl(platform: Platform, arch: Arch): string {
  return `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_${platform}_${arch}_v${MUTAGEN_VERSION}.tar.gz`;
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

// lstat: a symlink where a file was expected is a failure and is never followed.
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

async function verify(path: string, expected: string, what: string): Promise<void> {
  if (!isRegularFile(path)) {
    throw new Error(`Mutagen ${MUTAGEN_VERSION} is incomplete: ${what} is missing or not a regular file.`);
  }
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Error(
      `Mutagen ${MUTAGEN_VERSION} failed verification: ${what} has SHA-256 ${actual}, expected ${expected}. Nothing was installed.`,
    );
  }
}

export async function downloadMutagen(onProgress?: (message: string) => void): Promise<void> {
  const platform = detectPlatform();
  const arch = detectArch();
  const target: Target = `${platform}_${arch}`;
  const url = getMutagenDownloadUrl(platform, arch);
  const binDir = getMutagenBinDir();

  onProgress?.("Setting up file sync (one-time)...");

  mkdirSync(binDir, { recursive: true });
  // Staged beside the destination, so the final step is a rename on one filesystem.
  const staging = mkdtempSync(`${binDir}/.download-`);

  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download Mutagen: ${response.status} ${response.statusText}`);
    }

    const tarball = `${staging}/mutagen.tar.gz`;
    await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(tarball));
    await verify(tarball, MUTAGEN_TARBALL_SHA256[target], "the downloaded archive");
  
    onProgress?.("Installing...");

    // Only the two members the release contains are named, so nothing else in an archive can be
    // written, whatever this host's tar does with absolute or `..` paths (busybox tar refuses
    // neither). Both are hash-checked again after extraction.
    const proc = Bun.spawn(["tar", "-xzf", tarball, "-C", staging, "mutagen", "mutagen-agents.tar.gz"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`Failed to extract Mutagen: ${stderr}`);
    }

    await verify(`${staging}/mutagen`, MUTAGEN_BINARY_SHA256[target], "the mutagen binary");
    await verify(`${staging}/mutagen-agents.tar.gz`, MUTAGEN_AGENTS_SHA256, "the agent bundle");
    chmodSync(`${staging}/mutagen`, 0o755);

    // Agents first: the binary is what later runs check, so a run interrupted between the two
    // renames leaves a binary that fails that check and is reinstalled.
    renameSync(`${staging}/mutagen-agents.tar.gz`, getMutagenAgentPath());
    renameSync(`${staging}/mutagen`, getMutagenPath());
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  onProgress?.("File sync ready");
}

let verifiedPath: string | null = null;

/**
 * The path of a mutagen binary that matches the pinned hash, installing it first if needed.
 * Checked once per process: `haven status --watch` asks every two seconds.
 */
export async function ensureMutagenInstalled(onProgress?: (message: string) => void): Promise<string> {
  if (verifiedPath) return verifiedPath;

  const target: Target = `${detectPlatform()}_${detectArch()}`;
  const path = getMutagenPath();
  const installed =
    isRegularFile(path) &&
    isRegularFile(getMutagenAgentPath()) &&
    (await sha256File(path)) === MUTAGEN_BINARY_SHA256[target];

  if (!installed) {
    await downloadMutagen(onProgress);
  }

  verifiedPath = path;
  return path;
}
