"use client";

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  IconChevronDown,
  IconChevronRight,
  IconCheck,
  IconCopy,
  IconDeviceDesktop,
  IconHash,
  IconMessage,
  IconPlus,
  IconTerminal2,
  IconTrash,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { cn } from "@/lib/utils";

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
  createdAt?: string;
  online: boolean;
};

type RelayMessage =
  | { type: "auth-ok" }
  | {
      deviceId: string;
      hostName?: string;
      online: boolean;
      runtimes?: string[];
      type: "device-status";
    }
  | { error: string; type: "error" };

type RemoteShellProps = {
  userName: string;
  userEmail: string;
  initialMachineId?: string | null;
};

type AddMachineStep = "form" | "waiting" | "connected";
type SectionKey = "channels" | "machinesAndAgents" | "humans";

function InfoBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function MachineDetailView({
  machine,
  connectCommand,
  isLoadingConnectCommand,
  deviceOnline,
  isBootstrapping,
  onReconnect,
  onDelete,
  isDeleting,
}: {
  machine: Machine;
  connectCommand: string | null;
  isLoadingConnectCommand: boolean;
  deviceOnline: boolean;
  isBootstrapping: boolean;
  onReconnect: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const commandToShow = connectCommand ?? "Generating reconnect command...";

  async function handleCopy() {
    if (!connectCommand) return;
    await navigator.clipboard.writeText(commandToShow);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const createdDate = machine.createdAt
    ? new Date(machine.createdAt).toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";

  return (
    <div className="flex flex-col min-h-full">
      <div className="px-8 py-8 flex flex-col gap-8 w-full">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <IconDeviceDesktop className="size-5 shrink-0" />
            <h1 className="text-lg font-semibold">{machine.name}</h1>
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "size-2 rounded-full",
                  deviceOnline ? "bg-green-500" : "bg-muted-foreground/30"
                )}
              />
              <span className="text-sm text-muted-foreground">
                {deviceOnline ? "Online" : "Offline"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onReconnect} disabled={isBootstrapping}>
              {isBootstrapping ? "Reconnecting..." : "Reconnect"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={onDelete}
              disabled={isDeleting}
            >
              <IconTrash className="size-4" />
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-4 pb-6 border-b">
          <InfoBlock label="Hostname">{machine.hostName ?? "—"}</InfoBlock>
          <InfoBlock label="Runtimes">
            {machine.runtimes && machine.runtimes.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {machine.runtimes.map((r) => (
                  <span
                    key={r}
                    className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono"
                  >
                    {r}
                  </span>
                ))}
              </div>
            ) : (
              "—"
            )}
          </InfoBlock>
          <InfoBlock label="Created">{createdDate}</InfoBlock>
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Connect Command
          </h2>
          <>
            <div className="relative rounded-lg bg-zinc-950 p-4">
              <code className="block text-xs font-mono text-green-400 break-all pr-10 leading-relaxed">
                {commandToShow}
              </code>
              <button
                onClick={handleCopy}
                disabled={!connectCommand}
                className="absolute top-3 right-3 p-1.5 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
              >
                {copied ? (
                  <IconCheck className="size-4" />
                ) : (
                  <IconCopy className="size-4" />
                )}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {isLoadingConnectCommand
                ? "Generating a fresh API key for reconnect..."
                : "Keep this process running — it maintains the connection between your machine and the server."}
            </p>
          </>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Agents on this machine [0]
            </h2>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled>
                Start All
              </Button>
              <Button size="sm" variant="outline" disabled>
                <IconPlus className="size-4" />
                Create
              </Button>
            </div>
          </div>
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No agents configured yet.
          </div>
        </div>
      </div>
    </div>
  );
}

export function RemoteShell({ userName, userEmail, initialMachineId = null }: RemoteShellProps) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(initialMachineId);
  const [activeTab, setActiveTab] = useState<"messages" | "users">("users");
  const [serverUrl, setServerUrl] = useState("");
  const [machineApiKeys, setMachineApiKeys] = useState<Record<string, string>>({});
  const [machineApiKeyLoading, setMachineApiKeyLoading] = useState<Record<string, boolean>>({});

  const [addMachineOpen, setAddMachineOpen] = useState(false);
  const [newMachineName, setNewMachineName] = useState("My Machine");
  const [isCreatingMachine, setIsCreatingMachine] = useState(false);
  const [newMachineStep, setNewMachineStep] = useState<AddMachineStep>("form");
  const [newMachineId, setNewMachineId] = useState<string | null>(null);
  const dialogSocketRef = useRef<WebSocket | null>(null);

  const [session, setSession] = useState<BootstrapResponse | null>(null);
  const [deviceOnline, setDeviceOnline] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isDeletingMachine, setIsDeletingMachine] = useState(false);

  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState("all");
  const [selectedHuman, setSelectedHuman] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    channels: true,
    machinesAndAgents: true,
    humans: true,
  });
  const [openMachines, setOpenMachines] = useState<Record<string, boolean>>({});

  const router = useRouter();
  const pathname = usePathname();

  const channels = ["all", "general", "agents"];

  const flatMenuButtonClass =
    "data-[active=false]:!bg-transparent data-[active=false]:!text-sidebar-foreground data-[active=true]:!bg-sidebar-accent data-[active=true]:!text-sidebar-accent-foreground hover:!bg-sidebar-accent/50";

  useEffect(() => {
    setServerUrl(window.location.origin);
  }, []);

  useEffect(() => {
    void loadMachines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialMachineId) return;
    setSelectedMachineId(initialMachineId);
    setActiveTab("users");
  }, [initialMachineId]);

  useEffect(() => {
    if (!selectedMachineId) return;
    void bootstrapBrowserSession(selectedMachineId);
  }, [selectedMachineId]);

  useEffect(() => {
    if (!selectedMachineId || machineApiKeys[selectedMachineId]) return;
    void ensureMachineApiKey(selectedMachineId);
  }, [selectedMachineId, machineApiKeys]);

  useEffect(() => {
    if (!session) return;

    const socket = new WebSocket(session.relayWsUrl);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ token: session.browserToken, type: "auth" }));
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as RelayMessage;
      switch (message.type) {
        case "auth-ok":
          break;
        case "device-status":
          setDeviceOnline(message.online);
          setMachines((cur) =>
            cur.map((m) =>
              m.deviceId === message.deviceId
                ? {
                    ...m,
                    online: message.online,
                    hostName: message.hostName ?? m.hostName,
                    runtimes: message.runtimes ?? m.runtimes,
                  }
                : m
            )
          );
          break;
        case "error":
          console.error("[relay error]", message.error);
          break;
      }
    });

    socket.addEventListener("close", () => {
      setDeviceOnline(false);
    });

    return () => {
      socket.close();
    };
  }, [session]);

  const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null;

  const newMachineConnectHint = useMemo(() => {
    if (!newMachineId || !machineApiKeys[newMachineId] || !serverUrl) return "";
    return `npx @hariappointy/agent-chat-daemon --server-url ${serverUrl} --api-key ${machineApiKeys[newMachineId]}`;
  }, [newMachineId, machineApiKeys, serverUrl]);

  function machineConnectCommand(machine: Machine): string | null {
    const key = machineApiKeys[machine.id];
    if (!key || !serverUrl) return null;
    return `npx @hariappointy/agent-chat-daemon --server-url ${serverUrl} --api-key ${key}`;
  }

  async function ensureMachineApiKey(machineId: string) {
    setMachineApiKeyLoading((prev) => ({ ...prev, [machineId]: true }));
    try {
      const res = await fetch("/api/machines/rotate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { apiKey: string };
      setMachineApiKeys((prev) => ({ ...prev, [machineId]: data.apiKey }));
    } finally {
      setMachineApiKeyLoading((prev) => ({ ...prev, [machineId]: false }));
    }
  }

  async function loadMachines() {
    const res = await fetch("/api/machines");
    if (!res.ok) return;
    const data = (await res.json()) as { machines: Machine[] };
    setMachines(data.machines);
    if (selectedMachineId && !data.machines.some((machine) => machine.id === selectedMachineId)) {
      setSelectedMachineId(null);
    }
  }

  function selectMachine(machineId: string) {
    setSelectedMachineId(machineId);
    setActiveTab("users");
    const machinePath = `/dashboard/machine/${machineId}`;
    if (pathname !== machinePath) {
      window.history.replaceState(null, "", machinePath);
    }
  }

  async function bootstrapBrowserSession(machineId: string) {
    setIsBootstrapping(true);
    try {
      const res = await fetch("/api/machines/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId }),
      });
      if (!res.ok) return;
      const bs = (await res.json()) as BootstrapResponse;
      setSession(bs);
    } finally {
      setIsBootstrapping(false);
    }
  }

  async function handleCreateMachine() {
    setIsCreatingMachine(true);
    try {
      const res = await fetch("/api/machines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newMachineName.trim() || "My Machine" }),
      });
      if (!res.ok) return;

      const data = (await res.json()) as { apiKey: string; machine: Machine };
      setMachineApiKeys((prev) => ({ ...prev, [data.machine.id]: data.apiKey }));
      setNewMachineId(data.machine.id);
      setNewMachineStep("waiting");

      const bsRes = await fetch("/api/machines/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId: data.machine.id }),
      });

      if (bsRes.ok) {
        const bs = (await bsRes.json()) as BootstrapResponse;
        const socket = new WebSocket(bs.relayWsUrl);
        dialogSocketRef.current = socket;

        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ token: bs.browserToken, type: "auth" }));
        });

        socket.addEventListener("message", (e) => {
          const msg = JSON.parse(e.data) as RelayMessage;
          if (msg.type === "device-status" && msg.online) {
            setNewMachineStep("connected");
            setMachines((cur) =>
              cur.map((m) => (m.id === data.machine.id ? { ...m, online: true } : m))
            );
            socket.close();
          }
        });

        socket.addEventListener("close", () => {
          dialogSocketRef.current = null;
        });
      }

      await loadMachines();
    } finally {
      setIsCreatingMachine(false);
    }
  }

  function openAddMachineDialog() {
    setNewMachineStep("form");
    setNewMachineId(null);
    setNewMachineName("My Machine");
    setAddMachineOpen(true);
  }

  function handleAddMachineClose() {
    dialogSocketRef.current?.close();
    dialogSocketRef.current = null;
    setAddMachineOpen(false);
    setNewMachineStep("form");
    setNewMachineName("My Machine");
    setNewMachineId(null);
  }

  function handleAddMachineDone() {
    if (newMachineId) {
      selectMachine(newMachineId);
    }
    handleAddMachineClose();
  }

  async function handleDeleteMachine(machineId: string) {
    if (!window.confirm("Delete this machine? This action cannot be undone.")) return;
    setIsDeletingMachine(true);
    try {
      const res = await fetch("/api/machines", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId }),
      });
      if (!res.ok) return;

      setMachineApiKeys((prev) => {
        const next = { ...prev };
        delete next[machineId];
        return next;
      });
      setOpenMachines((prev) => {
        const next = { ...prev };
        delete next[machineId];
        return next;
      });
      setMachines((prev) => prev.filter((machine) => machine.id !== machineId));
      setSelectedMachineId(null);
      router.push("/dashboard");
    } finally {
      setIsDeletingMachine(false);
    }
  }

  function toggleSection(section: SectionKey) {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }

  return (
    <SidebarProvider
      defaultOpen={true}
      className="h-svh"
      style={{ "--sidebar-width": "15rem" } as CSSProperties}
    >
      <Sidebar collapsible="none" className="border-r border-sidebar-border">
        <SidebarHeader className="border-b border-sidebar-border p-2 flex-row gap-1">
          <button
            onClick={() => setActiveTab("messages")}
            className={cn(
              "flex flex-1 items-center justify-center h-9 rounded-md transition-colors",
              activeTab === "messages" ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
            )}
          >
            <IconMessage className="size-4" />
          </button>
          <button
            onClick={() => setActiveTab("users")}
            className={cn(
              "flex flex-1 items-center justify-center h-9 rounded-md transition-colors",
              activeTab === "users" ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
            )}
          >
            <IconUsers className="size-4" />
          </button>
        </SidebarHeader>

        <SidebarContent className="py-2">
          {activeTab === "messages" ? (
            <SidebarGroup>
              <SidebarGroupLabel asChild>
                <button
                  type="button"
                  className="w-full"
                  onClick={() => toggleSection("channels")}
                >
                  {openSections.channels ? (
                    <IconChevronDown className="size-3.5" />
                  ) : (
                    <IconChevronRight className="size-3.5" />
                  )}
                  Channels
                </button>
              </SidebarGroupLabel>
              {openSections.channels && (
                <SidebarGroupContent>
                  <SidebarMenu>
                    {channels.map((channel) => (
                      <SidebarMenuItem key={channel}>
                        <SidebarMenuButton
                          isActive={selectedChannel === channel}
                          className={flatMenuButtonClass}
                          onClick={() => setSelectedChannel(channel)}
                        >
                          <IconHash className="size-4 shrink-0" />
                          <span className="flex-1 truncate">{channel}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              )}
            </SidebarGroup>
          ) : (
            <>
              <SidebarGroup>
                <SidebarGroupLabel asChild>
                  <button
                    type="button"
                    className="w-full"
                    onClick={() => toggleSection("machinesAndAgents")}
                  >
                    {openSections.machinesAndAgents ? (
                      <IconChevronDown className="size-3.5" />
                    ) : (
                      <IconChevronRight className="size-3.5" />
                    )}
                    Machines &amp; Agents
                  </button>
                </SidebarGroupLabel>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarGroupAction title="Add">
                      <IconPlus className="size-3.5" />
                    </SidebarGroupAction>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start">
                    <DropdownMenuItem onClick={openAddMachineDialog}>
                      <IconDeviceDesktop className="size-4" />
                      Add Machine
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled>
                      <IconPlus className="size-4" />
                      Create Agent
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {openSections.machinesAndAgents && (
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {machines.map((machine) => (
                        <SidebarMenuItem key={machine.id}>
                          <SidebarMenuButton
                            isActive={selectedMachineId === machine.id}
                            className={flatMenuButtonClass}
                            onClick={() => {
                              selectMachine(machine.id);
                              setOpenMachines((prev) => ({
                                ...prev,
                                [machine.id]: !prev[machine.id],
                              }));
                            }}
                          >
                            {openMachines[machine.id] ? (
                              <IconChevronDown className="size-3.5 shrink-0" />
                            ) : (
                              <IconChevronRight className="size-3.5 shrink-0" />
                            )}
                            <IconDeviceDesktop className="size-4 shrink-0" />
                            <span className="flex-1 truncate">{machine.name}</span>
                            <span
                              className={cn(
                                "size-2 rounded-full shrink-0",
                                machine.online ? "bg-green-500" : "bg-muted-foreground/30"
                              )}
                            />
                          </SidebarMenuButton>
                          {openMachines[machine.id] && (
                            <div className="ml-7 mt-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">
                              No agents yet
                            </div>
                          )}
                        </SidebarMenuItem>
                      ))}
                      {machines.length === 0 && (
                        <p className="px-2 py-1 text-xs text-muted-foreground">No machines yet</p>
                      )}
                    </SidebarMenu>
                  </SidebarGroupContent>
                )}
              </SidebarGroup>

              <SidebarGroup>
                <SidebarGroupLabel asChild>
                  <button
                    type="button"
                    className="w-full"
                    onClick={() => toggleSection("humans")}
                  >
                    {openSections.humans ? (
                      <IconChevronDown className="size-3.5" />
                    ) : (
                      <IconChevronRight className="size-3.5" />
                    )}
                    Humans
                  </button>
                </SidebarGroupLabel>
                <SidebarGroupAction title="Invite">
                  <IconPlus className="size-3.5" />
                </SidebarGroupAction>

                {openSections.humans && (
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={selectedHuman === "self"}
                          className={flatMenuButtonClass}
                          onClick={() => setSelectedHuman("self")}
                        >
                          <div className="flex size-5 items-center justify-center rounded-full bg-muted shrink-0">
                            <IconUser className="size-3" />
                          </div>
                          <span className="flex-1 truncate">{userName}</span>
                          <span className="text-xs text-muted-foreground shrink-0">you</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                )}
              </SidebarGroup>
            </>
          )}
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border p-2">
          <button
            onClick={() => setUserDialogOpen(true)}
            className="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-sidebar-accent transition-colors"
          >
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
              <IconUser className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{userName}</p>
              <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
            </div>
          </button>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="overflow-y-auto">
        {activeTab === "users" ? (
          selectedMachine ? (
            <MachineDetailView
              machine={selectedMachine}
              connectCommand={machineConnectCommand(selectedMachine)}
              isLoadingConnectCommand={Boolean(machineApiKeyLoading[selectedMachine.id])}
              deviceOnline={deviceOnline}
              isBootstrapping={isBootstrapping}
              onReconnect={() =>
                selectedMachineId && void bootstrapBrowserSession(selectedMachineId)
              }
              onDelete={() => void handleDeleteMachine(selectedMachine.id)}
              isDeleting={isDeletingMachine}
            />
          ) : (
            <div className="flex flex-col items-center justify-center min-h-full text-center gap-4 p-8">
              <IconDeviceDesktop className="size-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No machine selected. Add a machine to get started.
              </p>
              <Button size="sm" onClick={openAddMachineDialog}>
                <IconPlus className="size-4" />
                Add Machine
              </Button>
            </div>
          )
        ) : (
          <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center gap-3 px-4 py-10 text-center sm:px-6">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Channel</p>
            <h2 className="text-2xl font-semibold">#{selectedChannel}</h2>
          </main>
        )}
      </SidebarInset>

      <Dialog
        open={addMachineOpen}
        onOpenChange={(open) => {
          if (!open) handleAddMachineClose();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Machine</DialogTitle>
          </DialogHeader>

          {newMachineStep === "form" ? (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Machine name</label>
                <Input
                  value={newMachineName}
                  onChange={(e) => setNewMachineName(e.target.value)}
                  placeholder="My Machine"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isCreatingMachine) void handleCreateMachine();
                  }}
                />
              </div>
              <Button
                disabled={isCreatingMachine}
                onClick={() => void handleCreateMachine()}
              >
                {isCreatingMachine ? "Creating..." : "Create Machine"}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <IconTerminal2 className="size-4 shrink-0" />
                  Run this command on your machine to connect:
                </div>
                <div className="relative rounded-lg bg-zinc-950 p-4">
                  <code className="block text-xs font-mono text-green-400 break-all pr-8 leading-relaxed">
                    {newMachineConnectHint || "Generating command..."}
                  </code>
                  {newMachineConnectHint && (
                    <button
                      onClick={() => void navigator.clipboard.writeText(newMachineConnectHint)}
                      className="absolute top-3 right-3 p-1.5 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                    >
                      <IconCopy className="size-4" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Keep this process running — it maintains the connection between your machine and
                  the server.
                </p>
              </div>

              <div
                className={cn(
                  "flex items-center gap-2.5 rounded-lg p-3 text-sm font-medium border",
                  newMachineStep === "connected"
                    ? "bg-green-50 border-green-200 text-green-800"
                    : "bg-amber-50 border-amber-200 text-amber-800"
                )}
              >
                <span
                  className={cn(
                    "size-2.5 rounded-full shrink-0",
                    newMachineStep === "connected" ? "bg-green-500" : "bg-orange-400"
                  )}
                />
                {newMachineStep === "connected"
                  ? "Machine connected!"
                  : "Waiting for machine to connect..."}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={handleAddMachineClose}>
                  Cancel
                </Button>
                <Button disabled={newMachineStep !== "connected"} onClick={handleAddMachineDone}>
                  Done
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={userDialogOpen} onOpenChange={setUserDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{userName}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{userEmail}</p>
          <DialogFooter>
            <SignOutButton />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
