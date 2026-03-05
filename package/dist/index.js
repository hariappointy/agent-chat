#!/usr/bin/env node

// src/index.ts
import path3 from "path";
import os2 from "os";
import { createRequire } from "module";
import { execSync as execSync2 } from "child_process";
import { accessSync } from "fs";
import { fileURLToPath } from "url";

// src/connection.ts
import WebSocket from "ws";
var DaemonConnection = class {
  ws = null;
  options;
  reconnectTimer = null;
  reconnectDelay = 1e3;
  maxReconnectDelay = 3e4;
  shouldConnect = true;
  constructor(options) {
    this.options = options;
  }
  connect() {
    this.shouldConnect = true;
    this.doConnect();
  }
  disconnect() {
    this.shouldConnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  doConnect() {
    if (!this.shouldConnect) return;
    const wsUrl = this.options.serverUrl.replace(/^http/, "ws") + `/daemon/connect?key=${this.options.apiKey}`;
    console.log(`[Daemon] Connecting to ${this.options.serverUrl}...`);
    this.ws = new WebSocket(wsUrl);
    this.ws.on("open", () => {
      console.log("[Daemon] Connected to server");
      this.reconnectDelay = 1e3;
      this.options.onConnect();
    });
    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.options.onMessage(msg);
      } catch (err) {
        console.error("[Daemon] Invalid message from server:", err);
      }
    });
    this.ws.on("close", () => {
      console.log("[Daemon] Disconnected from server");
      this.options.onDisconnect();
      this.scheduleReconnect();
    });
    this.ws.on("error", (err) => {
      console.error("[Daemon] WebSocket error:", err.message);
    });
  }
  scheduleReconnect() {
    if (!this.shouldConnect) return;
    if (this.reconnectTimer) return;
    console.log(`[Daemon] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
};

// src/agentProcessManager.ts
import { mkdir, writeFile, access, readdir, stat, readFile, rm } from "fs/promises";
import path2 from "path";
import os from "os";

// src/drivers/claude.ts
import { spawn } from "child_process";

// src/drivers/systemPrompt.ts
function toolRef(prefix, name) {
  return `${prefix}${name}`;
}
function buildBaseSystemPrompt(config, opts) {
  const t = (name) => toolRef(opts.toolPrefix, name);
  const criticalRules = [
    `- Do NOT output text directly. ALL communication goes through ${t("send_message")}.`,
    ...opts.extraCriticalRules,
    `- Do NOT explore the filesystem looking for messaging scripts. The MCP tools are already available.`
  ];
  const startupSteps = [
    `1. **Read MEMORY.md** (in your cwd). This is your memory index \u2014 it tells you what you know and where to find it.`,
    `2. Follow the instructions in MEMORY.md to read any other memory files you need (e.g. channel summaries, role definitions, user preferences).`,
    `3. Call ${t("receive_message")}(block=true) to start listening.`,
    `4. When you receive a message, process it and reply with ${t("send_message")}.`,
    `5. After replying, call ${t("receive_message")}(block=true) again to keep listening.`
  ];
  let prompt = `You are "${config.displayName || config.name}", an AI agent in Slock \u2014 a collaborative platform for human-AI collaboration.

## Who you are

You are a **long-running, persistent agent**. You are NOT a one-shot assistant \u2014 you live across many sessions. You will be started, put to sleep when idle, and woken up again when someone sends you a message. Your process may restart, but your memory persists through files in your workspace directory. Think of yourself as a team member who is always available, accumulates knowledge over time, and develops expertise through interactions.

## Communication \u2014 MCP tools ONLY

You have MCP tools from the "chat" server. Use ONLY these for communication:

1. **${t("receive_message")}** \u2014 Call with block=true to wait for messages. This is your main loop.
2. **${t("send_message")}** \u2014 Send a message to a channel or DM.
3. **${t("list_server")}** \u2014 List all channels, agents, and humans in this server.
4. **${t("read_history")}** \u2014 Read past messages from a channel or DM.

CRITICAL RULES:
${criticalRules.join("\n")}

## Startup sequence

${startupSteps.join("\n")}`;
  if (opts.postStartupNotes.length > 0) {
    prompt += `

${opts.postStartupNotes.join("\n")}`;
  }
  prompt += `

## Messaging

Messages you receive look like:
- **Channel message from a human**: \`[#all] @richard: hello everyone\`
- **Channel message from an agent**: \`[#all] (agent) @Alice: hi there\`
- **DM from a human**: \`[DM:@richard] @richard: hey, can you help?\`

The \`[...]\` prefix identifies where the message came from. Reuse it as the \`channel\` parameter when replying.

### Sending messages

- **Reply to a channel**: \`send_message(channel="#channel-name", content="...")\`
- **Reply to a DM**: \`send_message(channel="DM:@peer-name", content="...")\`  \u2014 reuse the channel value from the received message
- **Start a NEW DM**: \`send_message(dm_to="peer-name", content="...")\`  \u2014 use the human's name from list_server (no @ prefix)

**IMPORTANT**: To reply to any message (channel or DM), always use \`channel\` with the exact identifier from the received message. Only use \`dm_to\` when you want to start a brand new DM that doesn't exist yet.

### Discovering people and channels

Call \`list_server\` to see all your channels, other agents, and humans in this server.

### Channel awareness

Each channel has a **name** and optionally a **description** that define its purpose (visible via \`list_server\`). Respect them:
- **Reply in context** \u2014 always respond in the channel the message came from.
- **Stay on topic** \u2014 when proactively sharing results or updates, post in the channel most relevant to the work. Don't scatter messages across unrelated channels.
- If unsure where something belongs, call \`list_server\` to review channel descriptions.

### Reading history

\`read_history(channel="#channel-name")\` or \`read_history(channel="DM:@peer-name")\`

## @Mentions

In channel group chats, you can @mention people by their unique name (e.g. "@alice" or "@bob").
- Every human and agent has a unique \`name\` \u2014 this is their stable identifier for @mentions.
- @mentions do not notify people outside the channel \u2014 channels are the isolation boundary.

## Communication style

Keep the user informed. They cannot see your internal reasoning, so:
- When you receive a task, acknowledge it and briefly outline your plan before starting.
- For multi-step work, send short progress updates (e.g. "Working on step 2/3\u2026").
- When done, summarize the result.
- Keep updates concise \u2014 one or two sentences. Don't flood the chat.

## Workspace & Memory

Your working directory (cwd) is your **persistent workspace**. Everything you write here survives across sessions.

### MEMORY.md \u2014 Your Memory Index (CRITICAL)

\`MEMORY.md\` is the **entry point** to all your knowledge. It is the first file read on every startup (including after context compression). Structure it as an index that points to everything you know. This file is called \`MEMORY.md\` (not tied to any specific runtime) \u2014 keep it updated after every significant interaction or learning.

\`\`\`markdown
# <Your Name>

## Role
<your role definition, evolved over time>

## Key Knowledge
- Read notes/user-preferences.md for user preferences and conventions
- Read notes/channels.md for what each channel is about and ongoing work
- Read notes/domain.md for domain-specific knowledge and conventions
- ...

## Active Context
- Currently working on: <brief summary>
- Last interaction: <brief summary>
\`\`\`

### What to memorize

**Actively observe and record** the following kinds of knowledge as you encounter them in conversations:

1. **User preferences** \u2014 How the user likes things done, communication style, coding conventions, tool preferences, recurring patterns in their requests.
2. **World/project context** \u2014 The project structure, tech stack, architectural decisions, team conventions, deployment patterns.
3. **Domain knowledge** \u2014 Domain-specific terminology, conventions, best practices you learn through tasks.
4. **Work history** \u2014 What has been done, decisions made and why, problems solved, approaches that worked or failed.
5. **Channel context** \u2014 What each channel is about, who participates, what's being discussed, ongoing tasks per channel.
6. **Other agents** \u2014 What other agents do, their specialties, collaboration patterns, how to work with them effectively.

### How to organize memory

- **MEMORY.md** is always the index. Keep it concise but comprehensive as a table of contents.
- Create a \`notes/\` directory for detailed knowledge files. Use descriptive names:
  - \`notes/user-preferences.md\` \u2014 User's preferences and conventions
  - \`notes/channels.md\` \u2014 Summary of each channel and its purpose
  - \`notes/work-log.md\` \u2014 Important decisions and completed work
  - \`notes/<domain>.md\` \u2014 Domain-specific knowledge
- You can also create any other files or directories for your work (scripts, notes, data, etc.)
- **Update notes proactively** \u2014 Don't wait to be asked. When you learn something important, write it down.
- **Keep MEMORY.md current** \u2014 After updating notes, update the index in MEMORY.md if new files were added.

### Compaction safety (CRITICAL)

Your context will be periodically compressed to stay within limits. When this happens, you lose your in-context conversation history but MEMORY.md is always re-read. Therefore:

- **MEMORY.md must be self-sufficient as a recovery point.** After reading it, you should be able to understand who you are, what you know, and what you were working on.
- **Before a long task**, write a brief "Active Context" note in MEMORY.md so you can resume if interrupted mid-task.
- **After completing work**, update your notes and MEMORY.md index so nothing is lost.
- NEVER let context compression cause you to forget: which channel is about what, what tasks are in progress, what the user has asked for, or what other agents are doing.

## Capabilities

You can work with any files or tools on this computer \u2014 you are not confined to any directory.
You may develop a specialized role over time through your interactions. Embrace it.`;
  if (opts.includeStdinNotificationSection) {
    prompt += `

## Message Notifications

While you are busy (executing tools, thinking, etc.), new messages may arrive. When this happens, you will receive a system notification like:

\`[System notification: You have N new message(s) waiting. Call receive_message to read them when you're ready.]\`

How to handle these:
- **Do NOT interrupt your current work.** Finish what you're doing first.
- After completing your current step, call \`${t("receive_message")}(block=false)\` to check for messages.
- Do not ignore notifications for too long \u2014 acknowledge new messages in a timely manner.
- These notifications are batched (you won't get one per message), so the count tells you how many are waiting.`;
  }
  if (config.description) {
    prompt += `

## Initial role
${config.description}. This may evolve.`;
  }
  return prompt;
}

// src/drivers/claude.ts
var ClaudeDriver = class {
  id = "claude";
  supportsStdinNotification = true;
  mcpToolPrefix = "mcp__chat__";
  spawn(ctx) {
    const mcpArgs = [
      ctx.chatBridgePath,
      "--agent-id",
      ctx.agentId,
      "--server-url",
      ctx.config.serverUrl,
      "--auth-token",
      ctx.config.authToken || ctx.daemonApiKey
    ];
    const isTsSource = ctx.chatBridgePath.endsWith(".ts");
    const mcpConfig = JSON.stringify({
      mcpServers: {
        chat: {
          command: isTsSource ? "npx" : "node",
          args: isTsSource ? ["tsx", ...mcpArgs] : mcpArgs
        }
      }
    });
    const args2 = [
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--verbose",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--mcp-config",
      mcpConfig,
      "--model",
      ctx.config.model || "sonnet"
    ];
    if (ctx.config.sessionId) {
      args2.push("--resume", ctx.config.sessionId);
    }
    const spawnEnv = { ...process.env, FORCE_COLOR: "0" };
    delete spawnEnv.CLAUDECODE;
    const proc = spawn("claude", args2, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv
    });
    const stdinMsg = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: ctx.prompt }]
      },
      ...ctx.config.sessionId ? { session_id: ctx.config.sessionId } : {}
    });
    proc.stdin?.write(stdinMsg + "\n");
    return { process: proc };
  }
  parseLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    const events = [];
    switch (event.type) {
      case "system":
        if (event.subtype === "init" && event.session_id) {
          events.push({ kind: "session_init", sessionId: event.session_id });
        }
        break;
      case "assistant": {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
              events.push({ kind: "thinking", text: block.thinking });
            } else if (block.type === "text" && block.text) {
              events.push({ kind: "text", text: block.text });
            } else if (block.type === "tool_use") {
              events.push({ kind: "tool_call", name: block.name || "unknown_tool", input: block.input });
            }
          }
        }
        break;
      }
      case "result": {
        events.push({ kind: "turn_end", sessionId: event.session_id });
        break;
      }
    }
    return events;
  }
  encodeStdinMessage(text, sessionId) {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }]
      },
      ...sessionId ? { session_id: sessionId } : {}
    });
  }
  buildSystemPrompt(config, _agentId) {
    return buildBaseSystemPrompt(config, {
      toolPrefix: "mcp__chat__",
      extraCriticalRules: [
        "- Do NOT use bash/curl/sqlite to send or receive messages. The MCP tools handle everything."
      ],
      postStartupNotes: [],
      includeStdinNotificationSection: true
    });
  }
  toolDisplayName(name) {
    if (name.startsWith("mcp__chat__")) return "";
    if (name === "Read" || name === "read_file") return "Reading file\u2026";
    if (name === "Write" || name === "write_file") return "Writing file\u2026";
    if (name === "Edit" || name === "edit_file") return "Editing file\u2026";
    if (name === "Bash" || name === "bash") return "Running command\u2026";
    if (name === "Glob" || name === "glob") return "Searching files\u2026";
    if (name === "Grep" || name === "grep") return "Searching code\u2026";
    if (name === "WebFetch" || name === "web_fetch") return "Fetching web\u2026";
    if (name === "WebSearch" || name === "web_search") return "Searching web\u2026";
    if (name === "TodoWrite") return "Updating tasks\u2026";
    return `Using ${name.length > 20 ? name.slice(0, 20) + "\u2026" : name}\u2026`;
  }
  summarizeToolInput(name, input) {
    if (!input || typeof input !== "object") return "";
    try {
      if (name === "Read" || name === "read_file") return input.file_path || input.path || "";
      if (name === "Write" || name === "write_file") return input.file_path || input.path || "";
      if (name === "Edit" || name === "edit_file") return input.file_path || input.path || "";
      if (name === "Bash" || name === "bash") {
        const cmd = input.command || "";
        return cmd.length > 100 ? cmd.slice(0, 100) + "\u2026" : cmd;
      }
      if (name === "Glob" || name === "glob") return input.pattern || "";
      if (name === "Grep" || name === "grep") return input.pattern || "";
      if (name === "WebFetch" || name === "web_fetch") return input.url || "";
      if (name === "WebSearch" || name === "web_search") return input.query || "";
      if (name === "mcp__chat__send_message") {
        return input.channel || (input.dm_to ? `DM:@${input.dm_to}` : "");
      }
      if (name === "mcp__chat__read_history") return input.channel || "";
      return "";
    } catch {
      return "";
    }
  }
};

// src/drivers/codex.ts
import { spawn as spawn2, execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
var CodexDriver = class {
  id = "codex";
  supportsStdinNotification = false;
  mcpToolPrefix = "mcp_chat_";
  spawn(ctx) {
    const gitDir = path.join(ctx.workingDirectory, ".git");
    if (!existsSync(gitDir)) {
      execSync("git init", { cwd: ctx.workingDirectory, stdio: "pipe" });
      execSync("git add -A && git commit --allow-empty -m 'init'", {
        cwd: ctx.workingDirectory,
        stdio: "pipe",
        env: { ...process.env, GIT_AUTHOR_NAME: "slock", GIT_AUTHOR_EMAIL: "slock@local", GIT_COMMITTER_NAME: "slock", GIT_COMMITTER_EMAIL: "slock@local" }
      });
    }
    const isTsSource = ctx.chatBridgePath.endsWith(".ts");
    const command = isTsSource ? "npx" : "node";
    const bridgeArgs = isTsSource ? ["tsx", ctx.chatBridgePath, "--agent-id", ctx.agentId, "--server-url", ctx.config.serverUrl, "--auth-token", ctx.config.authToken || ctx.daemonApiKey] : [ctx.chatBridgePath, "--agent-id", ctx.agentId, "--server-url", ctx.config.serverUrl, "--auth-token", ctx.config.authToken || ctx.daemonApiKey];
    const args2 = ["exec"];
    if (ctx.config.sessionId) {
      args2.push("resume", ctx.config.sessionId);
    }
    args2.push(
      "--dangerously-bypass-approvals-and-sandbox",
      "--json"
    );
    args2.push(
      "-c",
      `mcp_servers.chat.command=${JSON.stringify(command)}`,
      "-c",
      `mcp_servers.chat.args=${JSON.stringify(bridgeArgs)}`,
      "-c",
      "mcp_servers.chat.startup_timeout_sec=30",
      "-c",
      "mcp_servers.chat.tool_timeout_sec=120",
      "-c",
      "mcp_servers.chat.enabled=true",
      "-c",
      "mcp_servers.chat.required=true"
    );
    if (ctx.config.model) {
      args2.push("-m", ctx.config.model);
    }
    if (ctx.config.reasoningEffort) {
      args2.push("-c", `model_reasoning_effort=${ctx.config.reasoningEffort}`);
    }
    args2.push(ctx.prompt);
    const spawnEnv = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
    const proc = spawn2("codex", args2, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv
    });
    return { process: proc };
  }
  parseLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    const events = [];
    switch (event.type) {
      case "thread.started":
        if (event.thread_id) {
          events.push({ kind: "session_init", sessionId: event.thread_id });
        }
        break;
      case "turn.started":
        events.push({ kind: "thinking", text: "" });
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = event.item;
        if (!item) break;
        switch (item.type) {
          case "reasoning":
            if (item.text) {
              events.push({ kind: "thinking", text: item.text });
            }
            break;
          case "agent_message":
            if (item.text && event.type === "item.completed") {
              events.push({ kind: "text", text: item.text });
            }
            break;
          case "command_execution":
            if (event.type === "item.started") {
              events.push({ kind: "tool_call", name: "shell", input: { command: item.command } });
            }
            break;
          case "file_change":
            if (event.type === "item.started" && Array.isArray(item.changes)) {
              for (const change of item.changes) {
                events.push({ kind: "tool_call", name: "file_change", input: { path: change.path, kind: change.kind } });
              }
            }
            break;
          case "mcp_tool_call":
            if (event.type === "item.started") {
              const toolName = item.server && item.tool ? `${this.mcpToolPrefix.replace(/_$/, "")}_${item.server}_${item.tool}` : item.tool || "mcp_tool";
              const name = item.server === "chat" ? `${this.mcpToolPrefix}${item.tool}` : toolName;
              events.push({ kind: "tool_call", name, input: item.arguments });
            }
            break;
          case "collab_tool_call":
            if (event.type === "item.started") {
              events.push({ kind: "tool_call", name: "collab_tool_call", input: {} });
            }
            break;
          case "todo_list":
            if (event.type === "item.started" || event.type === "item.updated") {
              events.push({ kind: "thinking", text: item.title || "Planning\u2026" });
            }
            break;
          case "web_search":
            if (event.type === "item.started") {
              events.push({ kind: "tool_call", name: "web_search", input: { query: item.query } });
            }
            break;
          case "error":
            if (item.message) {
              events.push({ kind: "error", message: item.message });
            }
            break;
        }
        break;
      }
      case "turn.completed":
        events.push({ kind: "turn_end" });
        break;
      case "turn.failed":
        if (event.error?.message) {
          events.push({ kind: "error", message: event.error.message });
        }
        events.push({ kind: "turn_end" });
        break;
      case "error":
        events.push({ kind: "error", message: event.message || "Unknown error" });
        break;
    }
    return events;
  }
  encodeStdinMessage(_text, _sessionId) {
    return null;
  }
  buildSystemPrompt(config, _agentId) {
    return buildBaseSystemPrompt(config, {
      toolPrefix: "",
      extraCriticalRules: [
        "- Do NOT use shell commands to send or receive messages. The MCP tools handle everything.",
        "- ALWAYS call receive_message(block=true) after completing any task \u2014 this keeps you listening for new messages."
      ],
      postStartupNotes: [
        "**IMPORTANT**: Your process exits after each turn completes. You will be automatically restarted when new messages arrive. Always call receive_message(block=true) as your last action \u2014 if no messages are pending, you'll sleep and be woken when one arrives."
      ],
      includeStdinNotificationSection: false
    });
  }
  toolDisplayName(name) {
    if (name.startsWith(this.mcpToolPrefix)) return "";
    if (name === "shell" || name === "command_execution") return "Running command\u2026";
    if (name === "file_change") return "Editing file\u2026";
    if (name === "file_read") return "Reading file\u2026";
    if (name === "file_write") return "Writing file\u2026";
    if (name === "web_search") return "Searching web\u2026";
    if (name === "collab_tool_call") return "Collaborating\u2026";
    return `Using ${name.length > 20 ? name.slice(0, 20) + "\u2026" : name}\u2026`;
  }
  summarizeToolInput(name, input) {
    if (!input || typeof input !== "object") return "";
    try {
      if (name === "shell" || name === "command_execution") {
        const cmd = input.command || "";
        return cmd.length > 100 ? cmd.slice(0, 100) + "\u2026" : cmd;
      }
      if (name === "file_change") return input.path || "";
      if (name === "file_read") return input.path || input.file_path || "";
      if (name === "file_write") return input.path || input.file_path || "";
      if (name === "web_search") return input.query || "";
      if (name === `${this.mcpToolPrefix}send_message`) {
        return input.channel || (input.dm_to ? `DM:@${input.dm_to}` : "");
      }
      if (name === `${this.mcpToolPrefix}read_history`) return input.channel || "";
      return "";
    } catch {
      return "";
    }
  }
};

// src/drivers/index.ts
var drivers = {
  claude: new ClaudeDriver(),
  codex: new CodexDriver()
};
function getDriver(runtimeId) {
  const driver = drivers[runtimeId];
  if (!driver) {
    throw new Error(`Unknown runtime: ${runtimeId}. Available: ${Object.keys(drivers).join(", ")}`);
  }
  return driver;
}

// src/agentProcessManager.ts
var DATA_DIR = path2.join(os.homedir(), ".slock", "agents");
function toLocalTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
var MAX_TRAJECTORY_TEXT = 2e3;
var AgentProcessManager = class {
  agents = /* @__PURE__ */ new Map();
  agentsStarting = /* @__PURE__ */ new Set();
  // Prevent concurrent starts of same agent
  chatBridgePath;
  sendToServer;
  daemonApiKey;
  constructor(chatBridgePath2, sendToServer, daemonApiKey) {
    this.chatBridgePath = chatBridgePath2;
    this.sendToServer = sendToServer;
    this.daemonApiKey = daemonApiKey;
  }
  async startAgent(agentId, config, wakeMessage, unreadSummary) {
    if (this.agents.has(agentId) || this.agentsStarting.has(agentId)) return;
    this.agentsStarting.add(agentId);
    try {
      const driver = getDriver(config.runtime || "claude");
      const agentDataDir = path2.join(DATA_DIR, agentId);
      await mkdir(agentDataDir, { recursive: true });
      const memoryMdPath = path2.join(agentDataDir, "MEMORY.md");
      try {
        await access(memoryMdPath);
      } catch {
        const agentName = config.displayName || config.name;
        const initialMemoryMd = `# ${agentName}

## Role
${config.description || "No role defined yet."}

## Key Knowledge
- No notes yet.

## Active Context
- First startup.
`;
        await writeFile(memoryMdPath, initialMemoryMd);
      }
      await mkdir(path2.join(agentDataDir, "notes"), { recursive: true });
      const isResume = !!config.sessionId;
      let prompt;
      if (isResume && wakeMessage) {
        const channelLabel = wakeMessage.channel_type === "dm" ? `DM:@${wakeMessage.channel_name}` : `#${wakeMessage.channel_name}`;
        const senderPrefix = wakeMessage.sender_type === "agent" ? "(agent) " : "";
        const time = wakeMessage.timestamp ? ` (${toLocalTime(wakeMessage.timestamp)})` : "";
        const formatted = `[${channelLabel}]${time} ${senderPrefix}@${wakeMessage.sender_name}: ${wakeMessage.content}`;
        prompt = `New message received:

${formatted}`;
        if (unreadSummary && Object.keys(unreadSummary).length > 0) {
          const otherUnread = Object.entries(unreadSummary).filter(([key]) => key !== channelLabel);
          if (otherUnread.length > 0) {
            prompt += `

You also have unread messages in other channels:`;
            for (const [ch, count] of otherUnread) {
              prompt += `
- ${ch}: ${count} unread`;
            }
            prompt += `

Use read_history to catch up, or respond to the message above first.`;
          }
        }
        prompt += `

Respond as appropriate \u2014 reply using send_message, or take action as needed. Then call receive_message(block=true) to keep listening.`;
        if (driver.supportsStdinNotification) {
          prompt += `

Note: While you are busy, you may receive [System notification: ...] messages. Finish your current step, then call receive_message to check.`;
        }
      } else if (isResume && unreadSummary && Object.keys(unreadSummary).length > 0) {
        prompt = `You have unread messages from while you were offline:`;
        for (const [ch, count] of Object.entries(unreadSummary)) {
          prompt += `
- ${ch}: ${count} unread`;
        }
        prompt += `

Use read_history to catch up on important channels, then call receive_message(block=true) to listen for new messages.`;
        if (driver.supportsStdinNotification) {
          prompt += `

Note: While you are busy, you may receive [System notification: ...] messages. Finish your current step, then call receive_message to check.`;
        }
      } else if (isResume) {
        prompt = `No new messages while you were away. Call ${driver.mcpToolPrefix}receive_message(block=true) to listen for new messages.`;
        if (driver.supportsStdinNotification) {
          prompt += `

Note: While you are busy, you may receive [System notification: ...] messages about new messages. Finish your current step, then call receive_message to check.`;
        }
      } else {
        prompt = driver.buildSystemPrompt(config, agentId);
      }
      const { process: proc } = driver.spawn({
        agentId,
        config,
        prompt,
        workingDirectory: agentDataDir,
        chatBridgePath: this.chatBridgePath,
        daemonApiKey: this.daemonApiKey
      });
      const agentProcess = {
        process: proc,
        driver,
        inbox: [],
        pendingReceive: null,
        config,
        sessionId: config.sessionId || null,
        isInReceiveMessage: false,
        notificationTimer: null,
        pendingNotificationCount: 0
      };
      this.agents.set(agentId, agentProcess);
      this.agentsStarting.delete(agentId);
      let buffer = "";
      proc.stdout?.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const events = driver.parseLine(line);
          for (const event of events) {
            this.handleParsedEvent(agentId, event, driver);
          }
        }
      });
      proc.stderr?.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (!text) return;
        if (/Reconnecting\.\.\.|Falling back from WebSockets/i.test(text)) return;
        console.error(`[Agent ${agentId} stderr]: ${text}`);
      });
      proc.on("exit", (code) => {
        console.log(`[Agent ${agentId}] Process exited with code ${code}`);
        if (this.agents.has(agentId)) {
          const ap = this.agents.get(agentId);
          if (ap.process !== proc) return;
          if (ap.pendingReceive) {
            clearTimeout(ap.pendingReceive.timer);
            ap.pendingReceive.resolve([]);
          }
          if (ap.notificationTimer) {
            clearTimeout(ap.notificationTimer);
          }
          this.agents.delete(agentId);
          if (code === 0) {
            this.sendToServer({ type: "agent:status", agentId, status: "sleeping" });
            this.sendToServer({ type: "agent:activity", agentId, activity: "sleeping", detail: "" });
          } else {
            const reason = code === null ? "killed by signal" : `exit code ${code}`;
            console.error(`[Agent ${agentId}] Process crashed (${reason}) \u2014 marking inactive`);
            this.sendToServer({ type: "agent:status", agentId, status: "inactive" });
            this.sendToServer({ type: "agent:activity", agentId, activity: "offline", detail: `Crashed (${reason})` });
          }
        }
      });
      this.sendToServer({ type: "agent:status", agentId, status: "active" });
      this.sendToServer({ type: "agent:activity", agentId, activity: "working", detail: "Starting\u2026" });
    } catch (err) {
      this.agentsStarting.delete(agentId);
      throw err;
    }
  }
  async stopAgent(agentId) {
    const ap = this.agents.get(agentId);
    if (!ap) return;
    if (ap.pendingReceive) {
      clearTimeout(ap.pendingReceive.timer);
      ap.pendingReceive.resolve([]);
    }
    if (ap.notificationTimer) {
      clearTimeout(ap.notificationTimer);
    }
    this.agents.delete(agentId);
    ap.process.kill("SIGTERM");
    this.sendToServer({ type: "agent:status", agentId, status: "inactive" });
    this.sendToServer({ type: "agent:activity", agentId, activity: "offline", detail: "" });
  }
  /** Hibernate: kill process but keep status as "sleeping" (auto-wakes on next message via --resume) */
  sleepAgent(agentId) {
    const ap = this.agents.get(agentId);
    if (!ap) return;
    console.log(`[Agent ${agentId}] Hibernating (sleeping)`);
    if (ap.pendingReceive) {
      clearTimeout(ap.pendingReceive.timer);
      ap.pendingReceive.resolve([]);
    }
    if (ap.notificationTimer) {
      clearTimeout(ap.notificationTimer);
    }
    this.agents.delete(agentId);
    ap.process.kill("SIGTERM");
  }
  deliverMessage(agentId, message) {
    const ap = this.agents.get(agentId);
    if (!ap) return;
    if (ap.pendingReceive) {
      clearTimeout(ap.pendingReceive.timer);
      ap.pendingReceive.resolve([message]);
      ap.pendingReceive = null;
    } else {
      ap.inbox.push(message);
    }
    if (!ap.driver.supportsStdinNotification) return;
    if (ap.isInReceiveMessage) return;
    if (!ap.sessionId) return;
    ap.pendingNotificationCount++;
    if (!ap.notificationTimer) {
      ap.notificationTimer = setTimeout(() => {
        this.sendStdinNotification(agentId);
      }, 3e3);
    }
  }
  async resetWorkspace(agentId) {
    const agentDataDir = path2.join(DATA_DIR, agentId);
    try {
      await rm(agentDataDir, { recursive: true, force: true });
      console.log(`[Agent ${agentId}] Workspace deleted: ${agentDataDir}`);
    } catch (err) {
      console.error(`[Agent ${agentId}] Failed to delete workspace:`, err);
    }
  }
  async stopAll() {
    const ids = [...this.agents.keys()];
    await Promise.all(ids.map((id) => this.stopAgent(id)));
  }
  getRunningAgentIds() {
    return [...this.agents.keys()];
  }
  // Machine-level workspace scanning
  async scanAllWorkspaces() {
    const results = [];
    let entries;
    try {
      entries = await readdir(DATA_DIR, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path2.join(DATA_DIR, entry.name);
      try {
        const dirContents = await readdir(dirPath, { withFileTypes: true });
        let totalSize = 0;
        let latestMtime = /* @__PURE__ */ new Date(0);
        let fileCount = 0;
        for (const item of dirContents) {
          const itemPath = path2.join(dirPath, item.name);
          try {
            const info = await stat(itemPath);
            if (item.isFile()) {
              totalSize += info.size;
              fileCount++;
            }
            if (info.mtime > latestMtime) {
              latestMtime = info.mtime;
            }
          } catch {
            continue;
          }
        }
        results.push({
          directoryName: entry.name,
          totalSizeBytes: totalSize,
          lastModified: latestMtime.toISOString(),
          fileCount
        });
      } catch {
        continue;
      }
    }
    return results;
  }
  async deleteWorkspaceDirectory(directoryName) {
    if (directoryName.includes("/") || directoryName.includes("..") || directoryName.includes("\\")) {
      return false;
    }
    const targetDir = path2.join(DATA_DIR, directoryName);
    try {
      await rm(targetDir, { recursive: true, force: true });
      console.log(`[Workspace] Deleted directory: ${targetDir}`);
      return true;
    } catch (err) {
      console.error(`[Workspace] Failed to delete directory ${targetDir}:`, err);
      return false;
    }
  }
  // Workspace file browsing
  async getFileTree(agentId, dirPath) {
    const agentDir = path2.join(DATA_DIR, agentId);
    try {
      await stat(agentDir);
    } catch {
      return [];
    }
    let targetDir = agentDir;
    if (dirPath) {
      const resolved = path2.resolve(agentDir, dirPath);
      if (!resolved.startsWith(agentDir + path2.sep) && resolved !== agentDir) {
        return [];
      }
      targetDir = resolved;
    }
    return this.listDirectoryChildren(targetDir, agentDir);
  }
  async readFile(agentId, filePath) {
    const agentDir = path2.join(DATA_DIR, agentId);
    const resolved = path2.resolve(agentDir, filePath);
    if (!resolved.startsWith(agentDir + path2.sep) && resolved !== agentDir) {
      throw new Error("Access denied");
    }
    const info = await stat(resolved);
    if (info.isDirectory()) throw new Error("Cannot read a directory");
    const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
      ".md",
      ".txt",
      ".json",
      ".js",
      ".ts",
      ".jsx",
      ".tsx",
      ".yaml",
      ".yml",
      ".toml",
      ".log",
      ".csv",
      ".xml",
      ".html",
      ".css",
      ".sh",
      ".py"
    ]);
    const ext = path2.extname(resolved).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && ext !== "") {
      return { content: null, binary: true };
    }
    if (info.size > 1048576) throw new Error("File too large");
    const content = await readFile(resolved, "utf-8");
    return { content, binary: false };
  }
  // Private methods
  /** Handle a single ParsedEvent from any runtime driver */
  handleParsedEvent(agentId, event, driver) {
    const trajectory = [];
    let activity = "";
    let detail = "";
    const ap = this.agents.get(agentId);
    switch (event.kind) {
      case "session_init":
        if (ap) ap.sessionId = event.sessionId;
        this.sendToServer({ type: "agent:session", agentId, sessionId: event.sessionId });
        break;
      case "thinking": {
        const text = event.text.length > MAX_TRAJECTORY_TEXT ? event.text.slice(0, MAX_TRAJECTORY_TEXT) + "\u2026" : event.text;
        trajectory.push({ kind: "thinking", text });
        activity = "thinking";
        if (ap) ap.isInReceiveMessage = false;
        break;
      }
      case "text": {
        const text = event.text.length > MAX_TRAJECTORY_TEXT ? event.text.slice(0, MAX_TRAJECTORY_TEXT) + "\u2026" : event.text;
        trajectory.push({ kind: "text", text });
        activity = "thinking";
        if (ap) ap.isInReceiveMessage = false;
        break;
      }
      case "tool_call": {
        const toolName = event.name;
        const inputSummary = driver.summarizeToolInput(toolName, event.input);
        trajectory.push({ kind: "tool_start", toolName, toolInput: inputSummary });
        if (toolName === `${driver.mcpToolPrefix}receive_message`) {
          activity = "online";
          if (ap) {
            ap.isInReceiveMessage = true;
            ap.pendingNotificationCount = 0;
            if (ap.notificationTimer) {
              clearTimeout(ap.notificationTimer);
              ap.notificationTimer = null;
            }
          }
        } else if (toolName === `${driver.mcpToolPrefix}send_message`) {
          activity = "working";
          detail = "Sending message\u2026";
          if (ap) ap.isInReceiveMessage = false;
        } else {
          activity = "working";
          detail = driver.toolDisplayName(toolName);
          if (ap) ap.isInReceiveMessage = false;
        }
        break;
      }
      case "turn_end":
        activity = "online";
        if (ap) {
          ap.isInReceiveMessage = false;
          if (event.sessionId) ap.sessionId = event.sessionId;
        }
        if (event.sessionId) {
          this.sendToServer({ type: "agent:session", agentId, sessionId: event.sessionId });
        }
        break;
      case "error":
        trajectory.push({ kind: "text", text: `Error: ${event.message}` });
        break;
    }
    if (activity) {
      this.sendToServer({ type: "agent:activity", agentId, activity, detail });
      trajectory.push({ kind: "status", activity, detail });
    }
    if (trajectory.length > 0) {
      this.sendToServer({ type: "agent:trajectory", agentId, entries: trajectory });
    }
  }
  /** Send a batched notification to the agent via stdin about pending messages */
  sendStdinNotification(agentId) {
    const ap = this.agents.get(agentId);
    if (!ap) return;
    const count = ap.pendingNotificationCount;
    ap.pendingNotificationCount = 0;
    ap.notificationTimer = null;
    if (count === 0) return;
    if (ap.isInReceiveMessage) return;
    if (!ap.sessionId) return;
    const notification = `[System notification: You have ${count} new message${count > 1 ? "s" : ""} waiting. Call receive_message to read ${count > 1 ? "them" : "it"} when you're ready.]`;
    console.log(`[Agent ${agentId}] Sending stdin notification: ${count} message(s)`);
    const encoded = ap.driver.encodeStdinMessage(notification, ap.sessionId);
    if (encoded) {
      ap.process.stdin?.write(encoded + "\n");
    }
  }
  /** List ONE level of a directory — directories returned without children (lazy-loaded on demand) */
  async listDirectoryChildren(dir, rootDir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    const nodes = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path2.join(dir, entry.name);
      const relativePath = path2.relative(rootDir, fullPath);
      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, path: relativePath, isDirectory: true, size: 0, modifiedAt: info.mtime.toISOString() });
      } else {
        nodes.push({ name: entry.name, path: relativePath, isDirectory: false, size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
    return nodes;
  }
};

// ../shared/src/index.ts
var RUNTIMES = [
  { id: "claude", displayName: "Claude Code", binary: "claude", supported: true },
  { id: "codex", displayName: "Codex CLI", binary: "codex", supported: true },
  { id: "gemini", displayName: "Gemini CLI", binary: "gemini", supported: false },
  { id: "kimi", displayName: "Kimi CLI", binary: "kimi", supported: false }
];

// src/index.ts
var require2 = createRequire(import.meta.url);
var DAEMON_VERSION = require2("../package.json").version;
function detectRuntimes() {
  const detected = [];
  for (const rt of RUNTIMES) {
    try {
      execSync2(`which ${rt.binary}`, { stdio: "pipe" });
      detected.push(rt.id);
    } catch {
    }
  }
  return detected;
}
var args = process.argv.slice(2);
var serverUrl = "";
var apiKey = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--server-url" && args[i + 1]) serverUrl = args[++i];
  if (args[i] === "--api-key" && args[i + 1]) apiKey = args[++i];
}
if (!serverUrl || !apiKey) {
  console.error("Usage: slock-daemon --server-url <url> --api-key <key>");
  process.exit(1);
}
var __dirname = path3.dirname(fileURLToPath(import.meta.url));
var chatBridgePath = path3.resolve(__dirname, "chat-bridge.js");
try {
  accessSync(chatBridgePath);
} catch {
  chatBridgePath = path3.resolve(__dirname, "chat-bridge.ts");
}
var connection;
var agentManager = new AgentProcessManager(chatBridgePath, (msg) => {
  connection.send(msg);
}, apiKey);
connection = new DaemonConnection({
  serverUrl,
  apiKey,
  onMessage: (msg) => {
    console.log(`[Daemon] Received: ${msg.type}`, msg.type === "ping" ? "" : JSON.stringify(msg).slice(0, 200));
    switch (msg.type) {
      case "agent:start":
        console.log(`[Daemon] Starting agent ${msg.agentId} (model: ${msg.config.model}, session: ${msg.config.sessionId || "new"}${msg.wakeMessage ? ", with wake message" : ""})`);
        agentManager.startAgent(msg.agentId, msg.config, msg.wakeMessage, msg.unreadSummary).catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`[Daemon] Failed to start agent ${msg.agentId}:`, reason);
          connection.send({ type: "agent:status", agentId: msg.agentId, status: "inactive" });
          connection.send({ type: "agent:activity", agentId: msg.agentId, activity: "offline", detail: `Start failed: ${reason}` });
        });
        break;
      case "agent:stop":
        console.log(`[Daemon] Stopping agent ${msg.agentId}`);
        agentManager.stopAgent(msg.agentId);
        break;
      case "agent:sleep":
        console.log(`[Daemon] Sleeping agent ${msg.agentId}`);
        agentManager.sleepAgent(msg.agentId);
        break;
      case "agent:reset-workspace":
        console.log(`[Daemon] Resetting workspace for agent ${msg.agentId}`);
        agentManager.resetWorkspace(msg.agentId);
        break;
      case "agent:deliver":
        console.log(`[Daemon] Delivering message to ${msg.agentId}: ${msg.message.content.slice(0, 80)}`);
        agentManager.deliverMessage(msg.agentId, msg.message);
        connection.send({ type: "agent:deliver:ack", agentId: msg.agentId, seq: msg.seq });
        break;
      case "agent:workspace:list":
        agentManager.getFileTree(msg.agentId, msg.dirPath).then((files) => {
          connection.send({ type: "agent:workspace:file_tree", agentId: msg.agentId, files, dirPath: msg.dirPath });
        });
        break;
      case "agent:workspace:read":
        agentManager.readFile(msg.agentId, msg.path).then(({ content, binary }) => {
          connection.send({
            type: "agent:workspace:file_content",
            agentId: msg.agentId,
            requestId: msg.requestId,
            content,
            binary
          });
        }).catch(() => {
          connection.send({
            type: "agent:workspace:file_content",
            agentId: msg.agentId,
            requestId: msg.requestId,
            content: null,
            binary: false
          });
        });
        break;
      case "machine:workspace:scan":
        console.log("[Daemon] Scanning all workspace directories");
        agentManager.scanAllWorkspaces().then((directories) => {
          connection.send({ type: "machine:workspace:scan_result", directories });
        });
        break;
      case "machine:workspace:delete":
        console.log(`[Daemon] Deleting workspace directory: ${msg.directoryName}`);
        agentManager.deleteWorkspaceDirectory(msg.directoryName).then((success) => {
          connection.send({ type: "machine:workspace:delete_result", directoryName: msg.directoryName, success });
        });
        break;
      case "ping":
        connection.send({ type: "pong" });
        break;
    }
  },
  onConnect: () => {
    const runtimes = detectRuntimes();
    console.log(`[Daemon] Detected runtimes: ${runtimes.join(", ") || "none"}`);
    connection.send({
      type: "ready",
      capabilities: ["agent:start", "agent:stop", "agent:deliver", "workspace:files"],
      runtimes,
      runningAgents: agentManager.getRunningAgentIds(),
      hostname: os2.hostname(),
      os: `${os2.platform()} ${os2.arch()}`,
      daemonVersion: DAEMON_VERSION
    });
  },
  onDisconnect: () => {
    console.log("[Daemon] Lost connection \u2014 agents continue running locally");
  }
});
console.log("[Slock Daemon] Starting...");
connection.connect();
var shutdown = async () => {
  console.log("[Slock Daemon] Shutting down...");
  await agentManager.stopAll();
  connection.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
