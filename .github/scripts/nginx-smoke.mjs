import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, "frontend/package.json"));
const { io } = require("socket.io-client");
const nginx = process.env.NGINX_BINARY || "nginx";
const openssl = process.env.OPENSSL_BINARY || "openssl";
const fixture = resolve(root, process.argv[2] || "dashboard-fixture");
const temporary = mkdtempSync(join(tmpdir(), "tdm-nginx-"));
const prefix = temporary.replaceAll("\\", "/") + "/";
const children = [];
const sockets = [];
let nginxStarted = false;
let fixtureOutput = "";
let agent;

async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const number = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return number;
}

function request(url, { method = "GET", data, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const secure = url.startsWith("https:");
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = (secure ? https : http).request(
      url,
      {
        method,
        agent: secure ? agent : undefined,
        headers: {
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
          }),
        );
        response.on("error", reject);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("HTTP timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await request(url)).status === 200) return;
    } catch {
      /* Startup only. */
    }
    if (children.some((child) => child.exitCode !== null))
      throw new Error(`Fixture exited: ${fixtureOutput}`);
    await delay(100);
  }
  throw new Error(`Server did not start: ${fixtureOutput}`);
}

function snapshot(base, transport, account, ca, cookie = "") {
  return new Promise((resolve, reject) => {
    const socket = io(base, {
      transports: [transport],
      reconnection: false,
      forceNew: true,
      timeout: 5000,
      ca,
      query: { protocol: "2", account },
      extraHeaders: { Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    });
    sockets.push(socket);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${transport}/${account} snapshot timeout`));
    }, 5000);
    const finish = (callback) => (value) => {
      clearTimeout(timer);
      socket.close();
      callback(value);
    };
    socket.on(
      account === "overview" ? "accounts" : "state_snapshot",
      finish(resolve),
    );
    socket.on("connect_error", finish(reject));
  });
}

try {
  const upstreamPort = await port();
  const httpPort = await port();
  const httpsPort = await port();
  const base = `https://127.0.0.1:${httpsPort}`;
  const upstream = `http://127.0.0.1:${upstreamPort}`;
  mkdirSync(join(temporary, "logs"));
  mkdirSync(join(temporary, "temp"));
  const challenge = join(temporary, "webroot/.well-known/acme-challenge");
  mkdirSync(challenge, { recursive: true });
  writeFileSync(join(challenge, "test"), "acme test");
  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "-keyout",
      join(temporary, "key.pem"),
      "-out",
      join(temporary, "cert.pem"),
    ],
    { stdio: "pipe" },
  );
  const ca = readFileSync(join(temporary, "cert.pem"));
  agent = new https.Agent({ ca }); // Verify TLS with only the temporary test certificate trusted.
  const config = readFileSync(join(root, "nginx.conf.example"), "utf8")
    .replace("listen 80;", `listen 127.0.0.1:${httpPort};`)
    .replace("listen 443 ssl;", `listen 127.0.0.1:${httpsPort} ssl;`)
    .replaceAll("https://drops.example.com", base)
    .replaceAll("drops.example.com", "localhost")
    .replace(
      "/etc/letsencrypt/live/localhost/fullchain.pem",
      `${prefix}cert.pem`,
    )
    .replace("/etc/letsencrypt/live/localhost/privkey.pem", `${prefix}key.pem`)
    .replace("/var/lib/letsencrypt", `${prefix}webroot`)
    .replace("http://127.0.0.1:8080", upstream);
  writeFileSync(
    join(temporary, "nginx.conf"),
    `pid logs/nginx.pid;\nerror_log logs/error.log;\nevents {}\nhttp {
access_log off;
client_body_temp_path temp/client;
proxy_temp_path temp/proxy;
fastcgi_temp_path temp/fastcgi;
uwsgi_temp_path temp/uwsgi;
scgi_temp_path temp/scgi;
${config}\n}\n`,
  );
  const child = spawn(
    fixture,
    ["--bind", `127.0.0.1:${upstreamPort}`, "--public-base-url", base],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  child.on("error", (error) => {
    fixtureOutput += error.message;
  });
  child.stdout.on("data", (data) => {
    fixtureOutput += data;
  });
  child.stderr.on("data", (data) => {
    fixtureOutput += data;
  });
  await ready(`${upstream}/__test/health`);
  execFileSync(nginx, ["-p", prefix, "-c", "nginx.conf", "-t"], {
    stdio: "pipe",
  });
  const proxy = spawn(
    nginx,
    ["-p", prefix, "-c", "nginx.conf", "-g", "daemon off;"],
    { windowsHide: true, stdio: "ignore" },
  );
  proxy.on("error", (error) => {
    fixtureOutput += error.message;
  });
  children.push(proxy);
  nginxStarted = true;
  await ready(`${base}/healthz`);
  const redirect = await request(
    `http://127.0.0.1:${httpPort}/campaigns?test=1`,
  );
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, `${base}/campaigns?test=1`);
  assert.equal(
    (
      await request(
        `http://127.0.0.1:${httpPort}/.well-known/acme-challenge/test`,
      )
    ).text,
    "acme test",
  );
  assert.equal((await request(`${base}/api/accounts`)).status, 200); // Login stays optional.
  for (const transport of ["polling", "websocket"]) {
    for (const account of ["primary", "overview"])
      await snapshot(base, transport, account, ca);
  }
  const headers = { Origin: base, "X-TDM-Request": "1" };
  const enabled = await request(`${base}/api/auth/settings`, {
    method: "POST",
    headers,
    data: {
      action: "enable",
      password: "test password",
      confirm_password: "test password",
    },
  });
  assert.equal(enabled.status, 200);
  const setCookie = enabled.headers["set-cookie"][0];
  for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict"])
    assert.ok(setCookie.includes(attribute));
  const cookie = setCookie.split(";")[0];
  for (const path of [
    "/api/accounts",
    "/api/settings",
    "/socket.io/?EIO=4&transport=polling",
  ]) {
    assert.equal((await request(`${base}${path}`)).status, 401);
  }
  const manifest = await request(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers["cache-control"], "no-cache");
  for (const icon of JSON.parse(manifest.text).icons) {
    assert.equal(
      (await request(`${base}${icon.src}`, { method: "HEAD" })).status,
      200,
    );
  }
  const current = JSON.parse(
    (
      await request(`${base}/api/accounts/primary/settings`, {
        headers: { Cookie: cookie },
      })
    ).text,
  );
  assert.equal(
    (
      await request(`${base}/api/accounts/primary/settings`, {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        data: { revision: current.revision, mining_paused: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`${base}/api/accounts/primary/settings`, {
        method: "POST",
        headers: {
          ...headers,
          Cookie: cookie,
          Origin: "https://wrong.example",
        },
        data: { mining_paused: false },
      })
    ).status,
    403,
  );
  for (const transport of ["polling", "websocket"])
    await snapshot(base, transport, "primary", ca, cookie);
  console.log(
    "Nginx HTTPS, certificate validation, redirect, ACME path, both Socket.IO transports, optional login, secure cookies and origin checks passed.",
  );
} finally {
  for (const socket of sockets) socket.close();
  agent?.destroy();
  if (nginxStarted) {
    try {
      execFileSync(nginx, ["-p", prefix, "-c", "nginx.conf", "-s", "quit"], {
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (error) {
      console.error("Nginx shutdown failed:", error.message);
    }
  }
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 5000).unref();
      });
    }
  }
  // Only this run's mkdtemp directory can be removed, including on Windows.
  assert.ok(
    resolve(temporary).startsWith(resolve(tmpdir()) + sep + "tdm-nginx-"),
  );
  rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
