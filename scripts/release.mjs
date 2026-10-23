// Release a version: `pnpm release 1.0.2`.
// Sets the version in package.json, tauri.conf.json, Cargo.toml and Cargo.lock, commits, tags vX.Y.Z and
// pushes main and the tag. The tag starts .github/workflows/release.yml, which builds a DRAFT GitHub release.
// If the files already hold that version, only the tag is made and pushed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: pnpm release <version>   e.g. pnpm release 1.0.2");
  process.exit(1);
}
const tag = `v${version}`;

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("switch to the main branch first");
if (git("status", "--porcelain")) fail("commit or stash your changes first");
if (git("tag", "--list", tag)) fail(`tag ${tag} already exists`);

const files = {
  "package.json": [/("version":\s*")[^"]+(")/],
  "src-tauri/tauri.conf.json": [/("version":\s*")[^"]+(")/],
  "src-tauri/Cargo.toml": [/(\[package\][^[]*?\nversion\s*=\s*")[^"]+(")/],
};
let changed = false;
for (const [path, [pattern]] of Object.entries(files)) {
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) fail(`no version found in ${path}`);
  const next = text.replace(pattern, `$1${version}$2`);
  if (next !== text) {
    writeFileSync(path, next);
    changed = true;
  }
}

if (changed) {
  // brings Cargo.lock's own entry up to date without touching any dependency
  execFileSync("cargo", ["update", "-p", "cutvii", "--offline"], { cwd: "src-tauri", stdio: "inherit" });
  git("add", ...Object.keys(files), "src-tauri/Cargo.lock");
  git("commit", "-m", `chore: release ${tag}`);
  console.log(`Committed version ${version}.`);
} else {
  console.log(`Files already at ${version}; tagging only.`);
}

git("tag", "-a", tag, "-m", `CutVii ${version}`);
execFileSync("git", ["push", "origin", "main", tag], { stdio: "inherit" });
console.log(`\nPushed ${tag}. The release workflow builds a DRAFT release; when it is done:`);
console.log(`  gh run watch`);
console.log(`  gh release edit ${tag} --draft=false --latest`);
