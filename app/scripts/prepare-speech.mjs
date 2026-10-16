/** Build-time only: stage a pinned offline recognizer and model for Orbit. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(fs.readFileSync(new URL("./speech-assets.json", import.meta.url), "utf8"));
export const SPEECH_STAGE_DIR = path.join(appDir, ".speech-stage", "speech");
const cache = path.join(appDir, ".speech-stage", "cache");

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function download(url, file, checksum) {
  if (fs.existsSync(file) && sha256(file) === checksum) return;
  console.log(`[speech] downloading ${path.basename(file)}`);
  const partial = `${file}.partial-${process.pid}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial, { mode: 0o600 }));
    if (sha256(partial) !== checksum) throw new Error(`Checksum mismatch: ${path.basename(file)}`);
    fs.renameSync(partial, file);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

function cmakeCommand() {
  if (spawnSync("cmake", ["--version"], { stdio: "ignore" }).status === 0) return ["cmake", []];
  if (spawnSync("uvx", ["--version"], { stdio: "ignore" }).status === 0)
    return ["uvx", ["--from", "cmake", "cmake"]];
  throw new Error("Building desktop dictation needs CMake (or uvx) and a C++ compiler.");
}

export async function prepareSpeech(platform = process.platform, arch = process.arch) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch))
    throw new Error(`Unsupported speech target: ${platform}-${arch}`);
  if (platform !== process.platform || (platform !== "darwin" && arch !== process.arch))
    throw new Error("Build the speech runtime on the target OS and architecture.");
  fs.mkdirSync(SPEECH_STAGE_DIR, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.copyFileSync(
    path.join(appDir, "scripts", "WHISPER-MODEL-LICENSE.txt"),
    path.join(SPEECH_STAGE_DIR, "WHISPER-MODEL-LICENSE.txt"),
  );
  const binaryName = platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const binary = path.join(SPEECH_STAGE_DIR, binaryName);
  const model = path.join(SPEECH_STAGE_DIR, spec.modelFile);
  // Model weights are public resources, including when an administrator
  // installs the app for other users.
  if (fs.existsSync(model)) fs.chmodSync(model, 0o644);
  const manifestFile = path.join(SPEECH_STAGE_DIR, "runtime.json");
  if (fs.existsSync(manifestFile) && fs.existsSync(binary) && fs.existsSync(model)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (
      manifest.platform === platform &&
      manifest.arch === arch &&
      manifest.commit === spec.commit &&
      manifest.modelSha256 === spec.modelSha256 &&
      sha256(binary) === manifest.binarySha256 &&
      sha256(model) === spec.modelSha256
    ) {
      console.log("[speech] verified offline Whisper Base English runtime");
      return;
    }
  }
  const archive = path.join(cache, `whisper-${spec.commit}.tar.gz`);
  await download(
    `https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${spec.commit}`,
    archive,
    spec.sourceSha256,
  );
  const source = path.join(cache, `source-${spec.commit}`);
  if (!fs.existsSync(path.join(source, "CMakeLists.txt"))) {
    fs.mkdirSync(source, { recursive: true });
    await run("tar", ["-xzf", archive, "-C", source, "--strip-components=1"]);
  }
  await download(
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/${spec.modelRevision}/${spec.modelFile}`,
    model,
    spec.modelSha256,
  );
  fs.chmodSync(model, 0o644);
  const build = path.join(cache, `build-${platform}-${arch}-${spec.commit}`);
  const [cmake, prefix] = cmakeCommand();
  const options = [
    "-S",
    source,
    "-B",
    build,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON",
    "-DWHISPER_SDL2=OFF",
    "-DGGML_NATIVE=OFF",
    "-DGGML_OPENMP=OFF",
    `-DGGML_METAL=${platform === "darwin" ? "ON" : "OFF"}`,
    "-DGGML_METAL_EMBED_LIBRARY=ON",
  ];
  if (platform === "darwin")
    options.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === "arm64" ? "arm64" : "x86_64"}`);
  console.log(`[speech] building whisper.cpp ${spec.version} for ${platform}-${arch}`);
  await run(cmake, [...prefix, ...options]);
  await run(cmake, [
    ...prefix,
    "--build",
    build,
    "--config",
    "Release",
    "--target",
    "whisper-cli",
    "--parallel",
    "4",
  ]);
  const built = [
    path.join(build, "bin", binaryName),
    path.join(build, "bin", "Release", binaryName),
  ].find(fs.existsSync);
  if (!built) throw new Error("The speech build produced no whisper-cli executable.");
  fs.copyFileSync(built, binary);
  fs.chmodSync(binary, 0o755);
  fs.copyFileSync(path.join(source, "LICENSE"), path.join(SPEECH_STAGE_DIR, "WHISPER-LICENSE.txt"));
  fs.writeFileSync(
    manifestFile,
    JSON.stringify({ ...spec, platform, arch, binarySha256: sha256(binary) }, null, 2) + "\n",
  );
  console.log("[speech] offline speech runtime ready (59.7 MB English model)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareSpeech().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
