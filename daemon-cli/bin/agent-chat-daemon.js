#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const extension = process.platform === "win32" ? ".exe" : "";
const binaryPath = path.join(__dirname, "..", "dist", `agent-chat-daemon${extension}`);

if (!fs.existsSync(binaryPath)) {
  console.error("[agent-chat-daemon] Binary not found.");
  console.error("Run `npm install` again or set AGENT_CHAT_DAEMON_BIN to a custom path.");
  process.exit(1);
}

const args = process.argv.slice(2);
const child = spawn(binaryPath, args, { stdio: "inherit" });

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
