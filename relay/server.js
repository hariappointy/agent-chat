const { createServer } = require("node:http");
const { createHmac, randomUUID, timingSafeEqual } = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");

const port = Number(process.env.PORT ?? 8787);
const sharedSecret = process.env.RELAY_SHARED_SECRET ?? "dev-relay-secret";

const daemonByDeviceId = new Map();
const browsersByDeviceId = new Map();
const socketMeta = new WeakMap();

function sign(value) {
  return createHmac("sha256", sharedSecret).update(value).digest("base64url");
}

function verifyToken(token) {
  if (typeof token !== "string") {
    return null;
  }

  const [encodedPayload, receivedSignature] = token.split(".");

  if (!encodedPayload || !receivedSignature) {
    return null;
  }

  const expectedSignature = sign(encodedPayload);
  if (receivedSignature.length !== expectedSignature.length) {
    return null;
  }

  const isValid = timingSafeEqual(
    Buffer.from(receivedSignature),
    Buffer.from(expectedSignature)
  );

  if (!isValid) {
    return null;
  }

  let payload;

  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (payload.exp < Date.now()) {
    return null;
  }

  if (payload.role !== "browser" && payload.role !== "daemon") {
    return null;
  }

  return payload;
}

function getDaemonInfo(deviceId) {
  const daemonSocket = daemonByDeviceId.get(deviceId);

  if (!daemonSocket || daemonSocket.readyState !== WebSocket.OPEN) {
    return { hostName: undefined, online: false, runtimes: undefined };
  }

  const meta = socketMeta.get(daemonSocket);

  return {
    hostName: meta?.hostName,
    online: true,
    runtimes: meta?.runtimes,
  };
}

function sendJson(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

function broadcastToBrowsers(deviceId, message) {
  const sockets = browsersByDeviceId.get(deviceId);
  if (!sockets) {
    return;
  }

  for (const socket of sockets) {
    sendJson(socket, message);
  }
}

function trackBrowser(deviceId, socket) {
  const sockets = browsersByDeviceId.get(deviceId) ?? new Set();
  sockets.add(socket);
  browsersByDeviceId.set(deviceId, sockets);
}

function removeSocket(socket) {
  const meta = socketMeta.get(socket);
  if (!meta) {
    return;
  }

  if (meta.role === "daemon") {
    const activeSocket = daemonByDeviceId.get(meta.deviceId);
    if (activeSocket === socket) {
      daemonByDeviceId.delete(meta.deviceId);
      broadcastToBrowsers(meta.deviceId, {
        deviceId: meta.deviceId,
        online: false,
        type: "device-status",
      });
    }
  }

  if (meta.role === "browser") {
    const sockets = browsersByDeviceId.get(meta.deviceId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        browsersByDeviceId.delete(meta.deviceId);
      }
    }
  }

  socketMeta.delete(socket);
}

function handleDaemonMessage(socket, meta, message) {
  switch (message.type) {
    case "heartbeat": {
      if (typeof message.hostName === "string") {
        meta.hostName = message.hostName;
      }
      if (Array.isArray(message.runtimes)) {
        meta.runtimes = message.runtimes;
      }

      broadcastToBrowsers(meta.deviceId, {
        deviceId: meta.deviceId,
        hostName: meta.hostName,
        online: true,
        runtimes: meta.runtimes,
        type: "device-status",
      });
      break;
    }
    case "command-output": {
      if (typeof message.commandId !== "string" || typeof message.chunk !== "string") {
        return;
      }

      broadcastToBrowsers(meta.deviceId, {
        chunk: message.chunk,
        commandId: message.commandId,
        stream: message.stream === "stderr" ? "stderr" : "stdout",
        type: "command-output",
      });
      break;
    }
    case "command-exit": {
      if (typeof message.commandId !== "string") {
        return;
      }

      const exitCode = Number.isInteger(message.exitCode) ? message.exitCode : -1;
      broadcastToBrowsers(meta.deviceId, {
        commandId: message.commandId,
        exitCode,
        finishedAt: new Date().toISOString(),
        type: "command-exit",
      });
      break;
    }
    default:
      break;
  }
}

function handleBrowserMessage(socket, meta, message) {
  if (message.type !== "run-command") {
    return;
  }

  if (typeof message.command !== "string" || message.command.trim().length === 0) {
    sendJson(socket, {
      error: "Command cannot be empty",
      type: "error",
    });
    return;
  }

  const daemonSocket = daemonByDeviceId.get(meta.deviceId);
  if (!daemonSocket || daemonSocket.readyState !== WebSocket.OPEN) {
    sendJson(socket, {
      error: "Machine is offline",
      type: "error",
    });
    return;
  }

  const commandId = randomUUID();

  sendJson(daemonSocket, {
    command: message.command,
    commandId,
    type: "run-command",
  });

  broadcastToBrowsers(meta.deviceId, {
    command: message.command,
    commandId,
    startedAt: new Date().toISOString(),
    type: "command-started",
  });
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});

const wsServer = new WebSocketServer({ noServer: true });

wsServer.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendJson(socket, { error: "Invalid JSON", type: "error" });
      return;
    }

    const meta = socketMeta.get(socket);

    if (!meta) {
      if (message.type !== "auth") {
        sendJson(socket, { error: "Authenticate first", type: "error" });
        return;
      }

      const payload = verifyToken(message.token);
      if (!payload) {
        sendJson(socket, { error: "Invalid token", type: "error" });
        socket.close();
        return;
      }

      const nextMeta = {
        deviceId: payload.deviceId,
        hostName: typeof message.hostName === "string" ? message.hostName : undefined,
        runtimes: Array.isArray(message.runtimes) ? message.runtimes : undefined,
        role: payload.role,
      };
      socketMeta.set(socket, nextMeta);

      if (payload.role === "daemon") {
        const previousSocket = daemonByDeviceId.get(payload.deviceId);
        if (previousSocket && previousSocket.readyState === WebSocket.OPEN) {
          previousSocket.close();
        }

        daemonByDeviceId.set(payload.deviceId, socket);
        broadcastToBrowsers(payload.deviceId, {
          deviceId: payload.deviceId,
          hostName: nextMeta.hostName,
          online: true,
          runtimes: nextMeta.runtimes,
          type: "device-status",
        });
      } else {
        trackBrowser(payload.deviceId, socket);
        const daemonInfo = getDaemonInfo(payload.deviceId);
        sendJson(socket, {
          deviceId: payload.deviceId,
          hostName: daemonInfo.hostName,
          online: daemonInfo.online,
          runtimes: daemonInfo.runtimes,
          type: "device-status",
        });
      }

      sendJson(socket, { type: "auth-ok" });
      return;
    }

    if (meta.role === "daemon") {
      handleDaemonMessage(socket, meta, message);
      return;
    }

    handleBrowserMessage(socket, meta, message);
  });

  socket.on("close", () => {
    removeSocket(socket);
  });

  socket.on("error", () => {
    removeSocket(socket);
  });
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(request, socket, head, (ws) => {
    wsServer.emit("connection", ws, request);
  });
});

server.listen(port, () => {
  console.log(`Relay listening on http://localhost:${port}`);
});
