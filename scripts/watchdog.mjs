#!/usr/bin/env node
// Runs the MCP server and ngrok tunnel together, restarting either one if it
// crashes. Unlike `npm run tunnel` (which just runs both once via
// concurrently), this keeps retrying indefinitely with a backoff, so the
// Cowork connector stays up across transient failures (network blip, ngrok
// hiccup, an unhandled exception in the server) without you noticing.
//
// Usage: node scripts/watchdog.mjs
// Stop with Ctrl+C (stops both children cleanly).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const logDir = join(rootDir, "logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, "watchdog.log");

const NGROK_DOMAIN = process.env.NGROK_DOMAIN || "single-darkness-estrogen.ngrok-free.dev";
const MAX_BACKOFF_MS = 30_000;

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.error(stamped);
  appendFileSync(logFile, stamped + "\n");
}

const children = [];
let shuttingDown = false;

function supervise(name, command, args) {
  let backoff = 1000;
  let restarts = 0;

  function start() {
    if (shuttingDown) return;
    log(`[${name}] starting: ${command} ${args.join(" ")}`);
    const child = spawn([command, ...args].join(" "), { cwd: rootDir, shell: true });
    children.push(child);

    child.stdout?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
    child.stderr?.on("data", (d) => process.stderr.write(`[${name}] ${d}`));

    child.on("exit", (code, signal) => {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      if (shuttingDown) return;

      restarts++;
      log(`[${name}] exited (code=${code} signal=${signal}), restart #${restarts} in ${backoff}ms`);
      setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });

    // Reset backoff once a process has stayed up a reasonable while.
    setTimeout(() => {
      if (children.includes(child)) backoff = 1000;
    }, 60_000);
  }

  start();
}

supervise("server", "npm", ["start"]);
supervise("ngrok", "ngrok", ["http", `--url=${NGROK_DOMAIN}`, "8080"]);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("Shutting down (Ctrl+C) — stopping server and tunnel...");
  for (const child of children) child.kill();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`Watchdog started. Domain: ${NGROK_DOMAIN}. Logs: ${logFile}`);
