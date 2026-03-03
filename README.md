# Agent Chat (Remote Shell v1)

A lightweight remote shell prototype inspired by slock.ai. This v1 focuses on **secure machine connectivity + command execution** before moving to agent chat features.

---

## What we’re building
**Goal:** A deployable remote shell where:
- Users sign in to the web UI
- Create a machine + API key
- Run `npx @hariappointy/agent-chat-daemon ...` locally
- Machine connects to relay and streams command output back to the UI

**Future:** agent chats and AI task execution on connected machines.

---

## Architecture
- **next-app/** — Next.js UI + API (auth + machine keys + relay token issuing)
- **relay/** — WebSocket relay server (forwards commands + streams output)
- **machine-daemon/** — Go daemon that connects to relay and runs commands
- **daemon-cli/** — npm wrapper for `npx` that downloads the Go binary

Flow:
1. User creates machine → gets API key
2. Daemon bootstraps with `/api/machines/bootstrap`
3. Relay issues tokens and connects browser + daemon
4. Commands + output flow through relay

---

## Production URLs (current)
- **Web UI (Vercel):** https://agent-chat-beta.vercel.app
- **Relay (Railway):** https://agent-chat-production-0b6b.up.railway.app
- **WebSocket URL:** wss://agent-chat-production-0b6b.up.railway.app/ws

---

## Environment Variables
### Next.js (Vercel + local)
```
DATABASE_URL=postgresql://...
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=https://agent-chat-beta.vercel.app
RELAY_SHARED_SECRET=... (must match relay)
NEXT_PUBLIC_RELAY_WS_URL=wss://agent-chat-production-0b6b.up.railway.app/ws
```

### Relay (Railway)
```
PORT=8787
RELAY_SHARED_SECRET=... (must match Next.js)
```

---

## Local Dev
### 1) DB
```
cd next-app
pnpm db:push
```

### 2) Relay
```
cd relay
RELAY_SHARED_SECRET=dev-relay-secret node server.js
```

### 3) Next.js
```
cd next-app
NEXT_PUBLIC_RELAY_WS_URL=ws://localhost:8787/ws pnpm dev
```

### 4) Daemon (local)
```
cd machine-daemon
go run . --server-url http://localhost:3000 --api-key <key>
```

---

## Daemon CLI (npx)
Package: `@hariappointy/agent-chat-daemon`

User command:
```
npx --yes @hariappointy/agent-chat-daemon --server-url https://agent-chat-beta.vercel.app --api-key <key>
```

### How it works
- npm installs the CLI wrapper
- postinstall downloads the Go binary from GitHub Releases
- wrapper executes the binary with provided flags

---

## Release / Publish Process
### 1) Update version
Update `daemon-cli/package.json` version (e.g. 0.1.1)

### 2) Publish npm (via Actions)
- Ensure `NPM_TOKEN` is set in GitHub Secrets
- Create GitHub Release with matching tag: `v0.1.1`
- Workflow builds binaries + publishes npm

### 3) Release assets
Release should include:
- agent-chat-daemon-darwin-arm64
- agent-chat-daemon-darwin-x64
- agent-chat-daemon-linux-x64
- agent-chat-daemon-win32-x64.exe

---

## Known fixes / notes
- `npx` downloads require **public** GitHub release assets.
- Redirect handling is implemented in `daemon-cli/scripts/download.js`.
- UI now shows relay connection status + “Reconnect relay” button.

---

## Next steps (planned)
- Machine command history
- Better shell security (allowlist / audit logs)
- Agent runtime (chat + tasks) after v1 stabilizes

---

## Owner / Status
- Repo: https://github.com/hariappointy/agent-chat
- Current status: v1 deployed and functional
