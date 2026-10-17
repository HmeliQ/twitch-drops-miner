import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const logo = readFileSync(
  join(root, "frontend/src/assets/twitch-drops-miner-logo.svg"),
  "utf8",
);
const output = join(root, "frontend/public/pwa");
const temporary = mkdtempSync(join(tmpdir(), "tdm-app-icons-"));
try {
  mkdirSync(output, { recursive: true });
  for (const [name, inset, sizes] of [
    ["icon", 64, [180, 192, 512]],
    ["maskable", 144, [512]],
  ]) {
    const source = join(temporary, `${name}.svg`);
    const inner = logo.replace(
      /<svg[^>]+>/,
      `<svg x="${inset}" y="${inset}" width="${1024 - inset * 2}" height="${1024 - inset * 2}" viewBox="206 0 588 768">`,
    );
    writeFileSync(
      source,
      `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#181818"/>${inner}</svg>`,
    );
    const destination = join(temporary, name);
    execFileSync(
      process.execPath,
      [
        resolve(root, "frontend/node_modules/@tauri-apps/cli/tauri.js"),
        "icon",
        source,
        "--output",
        destination,
        ...sizes.flatMap((size) => ["--png", String(size)]),
      ],
      { stdio: "inherit" },
    );
    for (const size of sizes)
      renameSync(
        join(destination, `${size}x${size}.png`),
        join(
          output,
          size === 180 ? "apple-touch-icon.png" : `${name}-${size}.png`,
        ),
      );
  }
} finally {
  assert.ok(
    resolve(temporary).startsWith(resolve(tmpdir()) + sep + "tdm-app-icons-"),
  );
  rmSync(temporary, { recursive: true, force: true });
}
