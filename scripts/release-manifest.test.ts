// @vitest-environment node
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

function job(name: string, source = workflow): string {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const starts = lines.flatMap((line, index) => (line === `  ${name}:` ? [index] : []));
  if (starts.length !== 1) throw new Error(`Expected exactly one ${name} job`);
  const start = starts[0]!;
  const next = lines.findIndex((line, index) => index > start && /^ {2}[\w-]+:/.test(line));
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

// Extract only this job's literal script. No YAML dependency or second implementation.
function script(name: string, source = workflow): string {
  const lines = job(name, source).split("\n");
  const markers = lines.flatMap((line, index) => (/^ +script: \|$/.test(line) ? [index] : []));
  if (markers.length !== 1) throw new Error(`Expected exactly one script block in ${name}`);
  const start = markers[0]!;
  const indent = lines[start]!.search(/\S/) + 2;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  if (!body.some((line) => line.trim())) throw new Error(`Empty ${name} script`);
  return body.join("\n");
}

type Bundle = { name: string; keys: string[] };
type Asset = { id: number; name: string };
type Upload = { name: string; data: string };
type Manifest = { version: string; platforms: Record<string, { url: string; signature: string }> };

// Frozen from v0.3.0-1's published assets/latest.json; ARM and RPM names are fixtures.
const publishedKeys = [
  "darwin-aarch64",
  "darwin-aarch64-app",
  "darwin-x86_64",
  "darwin-x86_64-app",
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "windows-x86_64",
  "windows-x86_64-msi",
  "windows-x86_64-nsis",
];
const armKeys = [
  "linux-aarch64",
  "linux-aarch64-appimage",
  "linux-aarch64-deb",
  "windows-aarch64",
  "windows-aarch64-msi",
  "windows-aarch64-nsis",
];
const rpmKeys = ["linux-aarch64-rpm", "linux-x86_64-rpm"];

function publishedBundles(version: string): Bundle[] {
  return [
    { name: `IBLOpenIdea_${version}_amd64.AppImage`, keys: ["linux-x86_64", "linux-x86_64-appimage"] },
    { name: `IBLOpenIdea_${version}_amd64.deb`, keys: ["linux-x86_64-deb"] },
    { name: "IBLOpenIdea_aarch64.app.tar.gz", keys: ["darwin-aarch64", "darwin-aarch64-app"] },
    { name: "IBLOpenIdea_x64.app.tar.gz", keys: ["darwin-x86_64", "darwin-x86_64-app"] },
    { name: `IBLOpenIdea_${version}_x64_en-US.msi`, keys: ["windows-x86_64", "windows-x86_64-msi"] },
    { name: `IBLOpenIdea_${version}_x64-setup.exe`, keys: ["windows-x86_64-nsis"] },
  ];
}

function bundles(tag: string): Bundle[] {
  const version = tag.slice(1);
  return [
    ...publishedBundles(version),
    { name: `IBLOpenIdea_${version}_aarch64.AppImage`, keys: ["linux-aarch64", "linux-aarch64-appimage"] },
    { name: `IBLOpenIdea_${version}_arm64.deb`, keys: ["linux-aarch64-deb"] },
    { name: `IBLOpenIdea_${version}_arm64_en-US.msi`, keys: ["windows-aarch64", "windows-aarch64-msi"] },
    { name: `IBLOpenIdea_${version}_arm64-setup.exe`, keys: ["windows-aarch64-nsis"] },
    ...(tag.includes("-")
      ? []
      : [
          { name: `IBLOpenIdea-${version}-1.x86_64.rpm`, keys: ["linux-x86_64-rpm"] },
          { name: `IBLOpenIdea-${version}-1.aarch64.rpm`, keys: ["linux-aarch64-rpm"] },
        ]),
  ];
}

function assetsFor(input: Bundle[]): Asset[] {
  return [
    ...input.flatMap(({ name }, index) => [
      { id: 2 * index + 1, name },
      { id: 2 * index + 2, name: `${name}.sig` },
    ]),
    { id: 9000, name: "latest.json" },
  ];
}

async function generate(tag: string, assets: Asset[]) {
  const events: string[] = [];
  const upload = vi.fn(async (request: Upload) => {
    events.push(`upload:${request.name}`);
  });
  const remove = vi.fn(async ({ asset_id }: { asset_id: number }) => {
    events.push(`delete:${asset_id}`);
  });
  const getAsset = vi.fn(async ({ asset_id }: { asset_id: number }) => {
    const asset = assets.find(({ id }) => id === asset_id);
    if (!asset?.name.endsWith(".sig")) throw new Error("Only fixture signatures may be downloaded");
    return { data: Buffer.from(`signature:${asset.name.slice(0, -4)}\n`) };
  });
  const core = { notice: vi.fn(), info: vi.fn(), setFailed: vi.fn() };
  const github = {
    paginate: vi.fn(async () => assets),
    rest: {
      repos: {
        listReleaseAssets: vi.fn(),
        getReleaseAsset: getAsset,
        deleteReleaseAsset: remove,
        uploadReleaseAsset: upload,
      },
    },
  };
  // No real process, credentials or GitHub client enters the actual workflow script.
  await runInNewContext(
    `(async () => {\n${script("updater-manifest")}\n})()`,
    {
      github,
      core,
      context: { repo: { owner: "inno-bit-lab", repo: "ibl-openidea" } },
      process: { env: { TAG: tag, RELEASE_ID: "42" } },
      Buffer,
    },
    { timeout: 1000 },
  );
  return { upload, remove, getAsset, core, events };
}

describe("release updater manifest", () => {
  it.each([
    { tag: "v0.3.1-1", keys: [...publishedKeys, ...armKeys], count: 16 },
    { tag: "v0.3.1", keys: [...publishedKeys, ...armKeys, ...rpmKeys], count: 18 },
  ])("pairs every bundle/signature with the exact $count keys for $tag", async ({ tag, keys, count }) => {
    expect(tag).toMatch(/^v\d+\.\d+\.\d+(?:-\d+)?$/);
    const input = bundles(tag);
    const result = await generate(tag, assetsFor(input));
    expect(result.core.setFailed).not.toHaveBeenCalled();
    expect(result.upload).toHaveBeenCalledTimes(1);
    const request = result.upload.mock.calls[0]![0];
    expect(request.name).toBe("latest.json");
    const manifest = JSON.parse(request.data) as Manifest;
    expect(manifest.version).toBe(tag.slice(1));
    expect(Object.keys(manifest.platforms).sort()).toEqual(keys.toSorted());
    expect(Object.keys(manifest.platforms)).toHaveLength(count);
    expect(
      Object.keys(manifest.platforms)
        .filter((key) => key.startsWith("darwin-") || /^(linux|windows)-x86_64(?:-|$)/.test(key))
        .filter((key) => !key.endsWith("-rpm"))
        .sort(),
    ).toEqual(publishedKeys);
    for (const { name, keys: bundleKeys } of input) {
      for (const key of bundleKeys) {
        expect(manifest.platforms[key]).toEqual({
          url: `https://github.com/inno-bit-lab/ibl-openidea/releases/download/${tag}/${encodeURIComponent(name)}`,
          signature: `signature:${name}`,
        });
      }
    }
    expect(result.getAsset).toHaveBeenCalledTimes(input.length);
    expect(result.events).toEqual(["delete:9000", "upload:latest.json"]);
  });

  it("rejects the published ten-key assets alone instead of emitting a partial ARM manifest", async () => {
    const result = await generate("v0.3.1-1", assetsFor(publishedBundles("0.3.1-1")));
    expect(result.core.setFailed).toHaveBeenCalledTimes(1);
    for (const key of armKeys) expect(result.core.setFailed.mock.calls[0]![0]).toContain(key);
    expect(result.upload).not.toHaveBeenCalled();
    expect(result.remove).not.toHaveBeenCalled();
  });

  it("fails a missing required ARM signature without deleting or uploading latest.json", async () => {
    const assets = assetsFor(bundles("v0.3.1-1")).filter(({ name }) => name !== "IBLOpenIdea_0.3.1-1_arm64.deb.sig");
    const result = await generate("v0.3.1-1", assets);
    expect(result.core.setFailed).toHaveBeenCalledWith("latest.json would miss linux-aarch64-deb");
    expect(result.upload).not.toHaveBeenCalled();
    expect(result.remove).not.toHaveBeenCalled();
  });

  it("keeps the zero-signature skip policy without uploading or deleting a manifest", async () => {
    const assets = assetsFor(bundles("v0.3.1-1")).filter(({ name }) => !name.endsWith(".sig"));
    const result = await generate("v0.3.1-1", assets);
    expect(result.core.notice).toHaveBeenCalledWith(expect.stringContaining("no signed bundles"));
    expect(result.core.setFailed).not.toHaveBeenCalled();
    expect(result.upload).not.toHaveBeenCalled();
    expect(result.remove).not.toHaveBeenCalled();
    expect(result.getAsset).not.toHaveBeenCalled();
  });

  it("keeps six desktop targets, the existing server targets and both Linux pre-release RPM guards", () => {
    const build = job("build");
    const targets = [...build.matchAll(/^ +target: (\S+)$/gm)].map((match) => match[1]);
    expect(targets.toSorted()).toEqual(
      [
        "aarch64-apple-darwin",
        "x86_64-apple-darwin",
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
        "aarch64-pc-windows-msvc",
        "x86_64-pc-windows-msvc",
      ].sort(),
    );
    expect(new Set(targets).size).toBe(6);
    expect(build).toContain("os: ubuntu-22.04-arm\n            target: aarch64-unknown-linux-gnu");
    expect(build).toContain("os: windows-11-arm\n            target: aarch64-pc-windows-msvc");
    const args = build.split("\n").find((line) => line.trimStart().startsWith("args:"));
    expect(args).toContain("runner.os == 'Linux' && contains(env.TAG, '-') && ' --bundles deb,appimage'");
    expect(args).not.toContain("matrix.os");
    expect([...job("server").matchAll(/target: ([\w-]+)/g)].map((match) => match[1])).toEqual([
      "x86_64-unknown-linux-musl",
      "aarch64-unknown-linux-musl",
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
  });

  it("preserves one manifest writer, published/draft guards, version equality and notarization", () => {
    for (const name of ["build", "server", "updater-manifest", "publish"]) {
      expect(job(name)).toMatch(/^ {4}if: needs\.create-release\.outputs\.already_published != 'true'$/m);
    }
    const create = job("create-release");
    expect(create).toContain("already_published: ${{ steps.release.outputs.already_published }}");
    expect(create).toContain('app="v$(jq -r .version src-tauri/tauri.conf.json)"');
    expect(create).toContain('if [ "$app" != "$TAG" ]; then');
    expect(create).toContain("exit 1");
    expect(create).toContain("if (!existing.draft)");
    expect(create).toContain('core.setOutput("already_published", "true")');
    expect(create).toContain("name: `IBLOpenIdea ${tag}`");
    expect(create).toContain('draft: true, prerelease: tag.includes("-")');
    expect(workflow.match(/includeUpdaterJson: false/g)).toHaveLength(1);
    expect(workflow).not.toContain("uploadUpdaterJson:");
    expect(workflow.match(/name: "latest\.json"/g)).toHaveLength(1);
    expect(job("build")).toContain('xcrun notarytool submit "$dmg"');
    expect(job("build")).toContain('xcrun stapler staple "$dmg"');
  });
});
