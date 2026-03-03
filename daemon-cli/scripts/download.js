const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const version = require("../package.json").version;

if (process.env.AGENT_CHAT_DAEMON_SKIP_DOWNLOAD === "1") {
  process.exit(0);
}

const platform = process.platform;
const arch = process.arch;

const target = `${platform}-${arch}`;
const extension = platform === "win32" ? ".exe" : "";
const fileName = `agent-chat-daemon-${target}${extension}`;
const baseUrl =
  process.env.AGENT_CHAT_DAEMON_RELEASE_URL ||
  "https://github.com/hariappointy/agent-chat/releases/download";

const url = `${baseUrl}/v${version}/${fileName}`;
const distDir = path.join(__dirname, "..", "dist");
const binaryPath = path.join(distDir, `agent-chat-daemon${extension}`);

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

if (fs.existsSync(binaryPath)) {
  process.exit(0);
}

console.log(`[agent-chat-daemon] Downloading ${url}`);

https
  .get(url, (response) => {
    if (response.statusCode !== 200) {
      console.error(`[agent-chat-daemon] Failed to download (${response.statusCode}).`);
      process.exit(1);
    }

    const file = fs.createWriteStream(binaryPath, { mode: 0o755 });
    response.pipe(file);

    file.on("finish", () => {
      file.close();
      fs.chmodSync(binaryPath, 0o755);
      console.log("[agent-chat-daemon] Download complete.");
    });
  })
  .on("error", (error) => {
    console.error("[agent-chat-daemon] Download error:", error.message);
    process.exit(1);
  });
