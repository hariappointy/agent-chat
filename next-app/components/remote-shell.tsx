"use client";

import { CSSProperties, FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { IconMessage, IconUser, IconUsers } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type BootstrapResponse = {
  browserToken: string;
  deviceId: string;
  relayWsUrl: string;
};

type Machine = {
  id: string;
  name: string;
  deviceId: string;
  hostName?: string | null;
  runtimes?: string[] | null;
  lastSeenAt?: number | null;
  online: boolean;
};

type RelayMessage =
  | {
      type: "auth-ok";
    }
  | {
      deviceId: string;
      hostName?: string;
      online: boolean;
      runtimes?: string[];
      type: "device-status";
    }
  | {
      command: string;
      commandId: string;
      startedAt: string;
      type: "command-started";
    }
  | {
      chunk: string;
      commandId: string;
      stream: "stdout" | "stderr";
      type: "command-output";
    }
  | {
      commandId: string;
      exitCode: number;
      finishedAt: string;
      type: "command-exit";
    }
  | {
      error: string;
      type: "error";
    };

type RemoteShellProps = {
  userName: string;
  userEmail: string;
};

export function RemoteShell({ userName, userEmail }: RemoteShellProps) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [machineName, setMachineName] = useState("My Machine");
  const [serverUrl, setServerUrl] = useState("");
  const [session, setSession] = useState<BootstrapResponse | null>(null);
  const [command, setCommand] = useState("pwd");
  const [status, setStatus] = useState("Not connected");
  const [relayConnected, setRelayConnected] = useState(false);
  const [deviceOnline, setDeviceOnline] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [output, setOutput] = useState("Waiting for a command...\n");
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTab, setActiveTab] = useState<"messages" | "members">("messages");
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setServerUrl(window.location.origin);
  }, []);

  useEffect(() => {
    void loadMachines();
  }, []);

  useEffect(() => {
    if (!selectedMachineId) {
      return;
    }

    void bootstrapBrowserSession(selectedMachineId);
  }, [selectedMachineId]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const socket = new WebSocket(session.relayWsUrl);
    socketRef.current = socket;
    setStatus("Connecting to relay...");

    socket.addEventListener("open", () => {
      setRelayConnected(false);
      setStatus("Authenticating browser session...");
      socket.send(
        JSON.stringify({
          token: session.browserToken,
          type: "auth",
        })
      );
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as RelayMessage;

      switch (message.type) {
        case "auth-ok": {
          setRelayConnected(true);
          setStatus("Relay connected");
          break;
        }
        case "device-status": {
          setDeviceOnline(message.online);
          setDeviceName(message.hostName ?? null);
          setStatus(message.online ? "Machine connected" : "Waiting for machine connection");
          setMachines((current) =>
            current.map((machine) =>
              machine.deviceId === message.deviceId
                ? {
                    ...machine,
                    online: message.online,
                    hostName: message.hostName ?? machine.hostName,
                    runtimes: message.runtimes ?? machine.runtimes,
                  }
                : machine
            )
          );
          break;
        }
        case "command-started": {
          setIsRunning(true);
          setOutput((current) => {
            const prefix = current.endsWith("\n") ? current : `${current}\n`;
            return `${prefix}$ ${message.command}\n`;
          });
          break;
        }
        case "command-output": {
          setOutput((current) => `${current}${message.chunk}`);
          break;
        }
        case "command-exit": {
          setIsRunning(false);
          setOutput((current) => `${current}\n[exit ${message.exitCode}]\n`);
          break;
        }
        case "error": {
          setIsRunning(false);
          setOutput((current) => `${current}\n[relay error] ${message.error}\n`);
          break;
        }
      }
    });

    socket.addEventListener("close", () => {
      setDeviceOnline(false);
      setRelayConnected(false);
      setStatus("Relay disconnected");
      setIsRunning(false);
      socketRef.current = null;
    });

    socket.addEventListener("error", () => {
      setRelayConnected(false);
      setStatus("Relay connection error");
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [session]);

  const connectHint = useMemo(() => {
    if (!apiKey || !serverUrl) {
      return "Create a machine to generate a connect command.";
    }

    return `npx @hariappointy/agent-chat-daemon --server-url ${serverUrl} --api-key ${apiKey}`;
  }, [apiKey, serverUrl]);

  async function loadMachines() {
    const response = await fetch("/api/machines");
    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as { machines: Machine[] };
    setMachines(data.machines);
    if (!selectedMachineId && data.machines.length > 0) {
      setSelectedMachineId(data.machines[0].id);
    }
  }

  async function bootstrapBrowserSession(machineId: string) {
    setIsBootstrapping(true);
    setStatus("Connecting to machine...");

    try {
      const response = await fetch("/api/machines/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId }),
      });

      if (!response.ok) {
        setStatus("Failed to connect to machine");
        return;
      }

      const nextSession = (await response.json()) as BootstrapResponse;
      setSession(nextSession);
      setRelayConnected(false);
      setOutput("Waiting for a command...\n");
      setDeviceName(null);
      setDeviceOnline(false);
      setStatus("Relay ready");
    } catch {
      setStatus("Failed to initialize session");
    } finally {
      setIsBootstrapping(false);
    }
  }

  async function handleCreateMachine() {
    setIsCreating(true);

    try {
      const response = await fetch("/api/machines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: machineName }),
      });

      if (!response.ok) {
        setStatus("Failed to create machine");
        return;
      }

      const data = (await response.json()) as {
        apiKey: string;
        machine: Machine;
      };

      setApiKey(data.apiKey);
      await loadMachines();
      setSelectedMachineId(data.machine.id);
      setStatus("Machine created — save the API key now");
    } finally {
      setIsCreating(false);
    }
  }

  function handleRunCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setOutput((current) => `${current}\n[client error] Relay is not connected.\n`);
      return;
    }

    setOutput("");
    socketRef.current.send(
      JSON.stringify({
        command,
        type: "run-command",
      })
    );
  }

  async function copyCommand() {
    if (!apiKey || !serverUrl) {
      return;
    }

    await navigator.clipboard.writeText(connectHint);
    setStatus("Connect command copied");
  }

  return (
    <SidebarProvider
      defaultOpen={true}
      className="h-svh"
      style={{ "--sidebar-width": "22rem" } as CSSProperties}
    >
      <Sidebar collapsible="none" className="border-r border-sidebar-border">
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "messages" | "members")}
          className="flex flex-col flex-1 overflow-hidden gap-0"
        >
          <SidebarHeader className="border-b p-2">
            <TabsList className="w-full rounded-lg bg-muted h-10">
              <TabsTrigger value="messages" className="flex-1">
                <IconMessage className="size-5" />
              </TabsTrigger>
              <TabsTrigger value="members" className="flex-1">
                <IconUsers className="size-5" />
              </TabsTrigger>
            </TabsList>
          </SidebarHeader>
          <SidebarContent />
        </Tabs>
        <SidebarFooter className="border-t border-foreground p-2">
          <Dialog>
            <DialogTrigger asChild>
              <button className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-sidebar-accent transition-colors">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                  <IconUser className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{userName}</p>
                  <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
                </div>
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{userName}</DialogTitle>
                <DialogDescription>{userEmail}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <SignOutButton />
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="overflow-y-auto">
        <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-10 sm:px-6 lg:px-8">
          {activeTab === "members" && (
            <Card>
              <CardHeader>
                <CardTitle>1. Register a machine</CardTitle>
                <CardDescription>
                  Create a machine key. You will only see the API key once.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Input
                    value={machineName}
                    onChange={(event) => setMachineName(event.target.value)}
                    placeholder="Machine name"
                  />
                  <Button disabled={isCreating} onClick={handleCreateMachine} type="button">
                    {isCreating ? "Creating..." : "Create machine"}
                  </Button>
                </div>
                <Textarea className="min-h-32 font-mono text-xs" readOnly value={connectHint} />
                <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                  <Button disabled={!apiKey} onClick={copyCommand} type="button" variant="outline">
                    Copy command
                  </Button>
                  <span>Status: {status}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "messages" && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>2. Connect to a machine</CardTitle>
                  <CardDescription>Select a machine to open a relay session.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={selectedMachineId ?? ""}
                      onChange={(event) => setSelectedMachineId(event.target.value || null)}
                    >
                      <option value="">Select a machine</option>
                      {machines.map((machine) => (
                        <option key={machine.id} value={machine.id}>
                          {machine.name} {machine.online ? "(online)" : "(offline)"}
                        </option>
                      ))}
                    </select>
                    <Button
                      disabled={!selectedMachineId || isBootstrapping}
                      onClick={() =>
                        selectedMachineId && bootstrapBrowserSession(selectedMachineId)
                      }
                      type="button"
                      variant="outline"
                    >
                      {isBootstrapping ? "Connecting..." : "Reconnect relay"}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                    <span>Relay: {relayConnected ? "Connected" : "Disconnected"}</span>
                    <span>Device: {deviceName ?? "offline"}</span>
                    <span>Online: {deviceOnline ? "Yes" : "No"}</span>
                    {deviceOnline &&
                    machines.find((m) => m.id === selectedMachineId)?.runtimes?.length ? (
                      <span>
                        Runtimes:{" "}
                        {machines
                          .find((m) => m.id === selectedMachineId)
                          ?.runtimes?.join(", ")}
                      </span>
                    ) : null}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>3. Run a command</CardTitle>
                  <CardDescription>
                    Commands are forwarded through the relay and executed by the connected daemon.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <form className="flex flex-col gap-3 sm:flex-row" onSubmit={handleRunCommand}>
                    <Input
                      className="font-mono"
                      onChange={(event) => setCommand(event.target.value)}
                      placeholder="bash command"
                      value={command}
                    />
                    <Button
                      disabled={!deviceOnline || !relayConnected || isRunning || !session}
                      type="submit"
                    >
                      {isRunning ? "Running..." : "Run"}
                    </Button>
                  </form>
                  <Textarea className="min-h-80 font-mono text-xs" readOnly value={output} />
                </CardContent>
              </Card>
            </>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
