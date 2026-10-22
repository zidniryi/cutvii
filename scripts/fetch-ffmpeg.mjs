// Downloads the pinned GPL FFmpeg build for one platform into src-tauri/binaries/, where Tauri bundles it
// as a resource. Every archive is checked against the SHA-256 in config/ffmpeg-binaries.json.
//   node scripts/fetch-ffmpeg.mjs [--target macos-arm64|macos-x64|linux-x64|windows-x64]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(path.join(root, "config", "ffmpeg-binaries.json"), "utf8"));
const outDir = path.join(root, "src-tauri", "binaries");
const cacheDir = path.join(root, ".cache", "ffmpeg");

function detectTarget() {
  const { platform, arch } = process;
  if (platform === "darwin") return arch === "arm64" ? "macos-arm64" : "macos-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  throw new Error(`No pinned FFmpeg build for ${platform}/${arch}`);
}

const flag = process.argv.indexOf("--target");
const target = flag > 0 ? process.argv[flag + 1] : detectTarget();
const archives = config.targets[target];
if (!archives)
  throw new Error(`Unknown target "${target}". Known: ${Object.keys(config.targets).join(", ")}`);

const exe = (name) => (target.startsWith("windows") ? `${name}.exe` : name);
const stamp = path.join(outDir, ".ffmpeg-pinned");
const wanted = `${config.version} ${archives.map((a) => a.sha256).join(" ")}`;

if (
  existsSync(stamp) &&
  readFileSync(stamp, "utf8") === wanted &&
  existsSync(path.join(outDir, exe("ffmpeg"))) &&
  existsSync(path.join(outDir, exe("ffprobe")))
) {
  console.log(`FFmpeg ${config.version} for ${target} is already in src-tauri/binaries`);
  process.exit(0);
}

async function sha256Of(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function download({ url, sha256 }) {
  mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${sha256}-${path.basename(new URL(url).pathname)}`);
  if (existsSync(file) && (await sha256Of(file)) === sha256) return file;
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const got = await sha256Of(file);
  if (got !== sha256) {
    rmSync(file, { force: true });
    throw new Error(`${url}: SHA-256 is ${got}, expected ${sha256}. Nothing was installed.`);
  }
  return file;
}

// On Windows use the system bsdtar (it reads zip); Git's GNU tar, which can come first on PATH, does not
const tarBin =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

mkdirSync(outDir, { recursive: true });
for (const archive of archives) {
  const file = await download(archive);
  const scratch = mkdtempSync(path.join(tmpdir(), "cutvii-ffmpeg-"));
  try {
    // bsdtar (macOS, Windows) reads zip and tar.xz; GNU tar (Linux) is only given tar.xz here
    const found = new Map();
    execFileSync(tarBin, ["-xf", file, "-C", scratch], { stdio: "inherit" });
    for (const candidate of walk(scratch)) {
      const name = path.basename(candidate);
      for (const tool of ["ffmpeg", "ffprobe"]) {
        if (name === exe(tool)) found.set(tool, candidate);
      }
    }
    for (const [tool, from] of found) {
      const to = path.join(outDir, exe(tool));
      copyFileSync(from, to);
      if (process.platform !== "win32") chmodSync(to, 0o755);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
for (const tool of ["ffmpeg", "ffprobe"]) {
  if (!existsSync(path.join(outDir, exe(tool))))
    throw new Error(`${exe(tool)} was not found in the archives`);
}
writeFileSync(stamp, wanted);
console.log(`FFmpeg ${config.version} (${target}) installed in src-tauri/binaries`);
