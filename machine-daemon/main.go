package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type authMessage struct {
	HostName string   `json:"hostName,omitempty"`
	Runtimes []string `json:"runtimes,omitempty"`
	Token    string   `json:"token"`
	Type     string   `json:"type"`
}

type runCommandMessage struct {
	Command   string `json:"command"`
	CommandID string `json:"commandId"`
	Type      string `json:"type"`
}

type outputMessage struct {
	Chunk     string `json:"chunk"`
	CommandID string `json:"commandId"`
	Stream    string `json:"stream"`
	Type      string `json:"type"`
}

type exitMessage struct {
	CommandID string `json:"commandId"`
	ExitCode  int    `json:"exitCode"`
	Type      string `json:"type"`
}

type heartbeatMessage struct {
	HostName string   `json:"hostName,omitempty"`
	Runtimes []string `json:"runtimes,omitempty"`
	Type     string   `json:"type"`
}

type bootstrapResponse struct {
	DaemonToken string `json:"daemonToken"`
	RelayWsURL  string `json:"relayWsUrl"`
}

func main() {
	relayURL := flag.String("relay-url", "", "relay websocket URL (legacy)")
	serverURL := flag.String("server-url", "", "server base URL for API bootstrap")
	apiKey := flag.String("api-key", "", "machine API key")
	token := flag.String("token", "", "daemon auth token (legacy)")
	name := flag.String("name", "", "display name for UI")
	chatBridgePath := flag.String("chat-bridge-path", "", "path to Slock MCP chat bridge JS")
	flag.Parse()

	hostName := *name
	if hostName == "" {
		detectedHostName, err := os.Hostname()
		if err == nil && detectedHostName != "" {
			hostName = detectedHostName
		} else {
			hostName = "unknown-host"
		}
	}

	runtimes := detectRuntimes()
	resolvedBridgePath := resolveChatBridgePath(*chatBridgePath)
	if resolvedBridgePath != "" {
		fmt.Printf("Using chat bridge: %s\n", resolvedBridgePath)
	} else {
		fmt.Println("Chat bridge not found; agent:start will fail until --chat-bridge-path is provided")
	}

	if *token == "" && (*apiKey == "" || *serverURL == "") {
		fmt.Fprintln(os.Stderr, "--api-key and --server-url are required (or use legacy --token + --relay-url)")
		os.Exit(1)
	}

	backoff := time.Second
	for {
		resolvedRelayURL, resolvedToken, err := resolveConnection(*relayURL, *token, *serverURL, *apiKey, hostName, runtimes)
		if err != nil {
			fmt.Fprintf(os.Stderr, "bootstrap failed: %v\n", err)
			time.Sleep(backoff)
			backoff = minDuration(backoff*2, 30*time.Second)
			continue
		}

		fmt.Printf("Connecting to relay %s\n", resolvedRelayURL)
		err = connectAndServe(resolvedRelayURL, resolvedToken, hostName, runtimes, *serverURL, *apiKey, resolvedBridgePath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "relay disconnected: %v\n", err)
		}

		time.Sleep(backoff)
		backoff = minDuration(backoff*2, 30*time.Second)
	}
}

func resolveConnection(relayURL, token, serverURL, apiKey, hostName string, runtimes []string) (string, string, error) {
	if token != "" {
		resolved := relayURL
		if resolved == "" {
			resolved = "ws://localhost:8787/ws"
		}
		return resolved, token, nil
	}

	bootstrap, err := bootstrapMachine(serverURL, apiKey, hostName, runtimes)
	if err != nil {
		return "", "", err
	}

	return bootstrap.RelayWsURL, bootstrap.DaemonToken, nil
}

func bootstrapMachine(serverURL, apiKey, hostName string, runtimes []string) (*bootstrapResponse, error) {
	payload := map[string]any{
		"hostName": hostName,
		"runtimes": runtimes,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	endpoint := strings.TrimRight(serverURL, "/") + "/api/machines/bootstrap"
	request, err := http.NewRequest("POST", endpoint, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}

	request.Header.Set("authorization", "Bearer "+apiKey)
	request.Header.Set("content-type", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("bootstrap failed with status %d", response.StatusCode)
	}

	var result bootstrapResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, err
	}

	return &result, nil
}

func connectAndServe(relayURL, token, hostName string, runtimes []string, serverURL, apiKey, chatBridgePath string) error {
	connection, _, err := websocket.DefaultDialer.Dial(relayURL, nil)
	if err != nil {
		return err
	}
	defer connection.Close()

	writer := &jsonWriter{connection: connection}
	manager := newAgentManager(chatBridgePath, serverURL, apiKey, writer.send)

	if err := writer.send(authMessage{Type: "auth", Token: token, HostName: hostName, Runtimes: runtimes}); err != nil {
		return err
	}
	_ = writer.send(heartbeatMessage{Type: "heartbeat", HostName: hostName, Runtimes: runtimes})

	stopHeartbeat := make(chan struct{})
	go startHeartbeat(writer, hostName, runtimes, stopHeartbeat)
	if apiKey != "" && serverURL != "" {
		go startAPIHeartbeat(serverURL, apiKey, hostName, runtimes, stopHeartbeat)
	}

	for {
		_, raw, err := connection.ReadMessage()
		if err != nil {
			close(stopHeartbeat)
			manager.stopAll()
			return err
		}

		var incoming map[string]any
		if err := json.Unmarshal(raw, &incoming); err != nil {
			fmt.Fprintf(os.Stderr, "invalid relay message: %v\n", err)
			continue
		}

		messageType, _ := incoming["type"].(string)
		switch messageType {
		case "auth-ok":
			fmt.Println("Authentication successful")
			_ = writer.send(map[string]any{
				"type":          "ready",
				"capabilities":  []string{"agent:start", "agent:stop", "agent:deliver", "workspace:files"},
				"runtimes":      runtimes,
				"runningAgents": manager.runningAgentIDs(),
				"hostname":      hostName,
				"os":            detectOSLabel(),
				"daemonVersion": "go-clone-0.1.0",
			})
		case "run-command":
			commandID, _ := incoming["commandId"].(string)
			command, _ := incoming["command"].(string)
			if commandID == "" || command == "" {
				continue
			}
			go runCommand(writer, runCommandMessage{Type: "run-command", CommandID: commandID, Command: command})
		case "agent:start":
			agentID := getString(incoming, "agentId")
			if agentID == "" {
				continue
			}
			config := parseAgentConfig(incoming["config"], serverURL, apiKey)
			wakeMessage := parseWakeMessage(incoming["wakeMessage"])
			unreadSummary := parseUnreadSummary(incoming["unreadSummary"])
			go func() {
				if err := manager.startAgent(agentID, config, wakeMessage, unreadSummary); err != nil {
					reason := err.Error()
					_ = writer.send(map[string]any{"type": "agent:status", "agentId": agentID, "status": "inactive"})
					_ = writer.send(map[string]any{"type": "agent:activity", "agentId": agentID, "activity": "offline", "detail": "Start failed: " + reason})
				}
			}()
		case "agent:stop":
			manager.stopAgent(getString(incoming, "agentId"))
		case "agent:sleep":
			manager.sleepAgent(getString(incoming, "agentId"))
		case "agent:reset-workspace":
			manager.resetWorkspace(getString(incoming, "agentId"))
		case "agent:deliver":
			agentID := getString(incoming, "agentId")
			if agentID == "" {
				continue
			}
			msg := parseWakeMessage(incoming["message"])
			if msg != nil {
				manager.deliverMessage(agentID, *msg)
			}
			_ = writer.send(map[string]any{"type": "agent:deliver:ack", "agentId": agentID, "seq": incoming["seq"]})
		case "agent:workspace:list":
			agentID := getString(incoming, "agentId")
			dirPath := getString(incoming, "dirPath")
			files := manager.getFileTree(agentID, dirPath)
			_ = writer.send(map[string]any{"type": "agent:workspace:file_tree", "agentId": agentID, "files": files, "dirPath": dirPath})
		case "agent:workspace:read":
			agentID := getString(incoming, "agentId")
			path := getString(incoming, "path")
			requestID := getString(incoming, "requestId")
			content, binary, err := manager.readFile(agentID, path)
			if err != nil {
				_ = writer.send(map[string]any{"type": "agent:workspace:file_content", "agentId": agentID, "requestId": requestID, "content": nil, "binary": false})
				continue
			}
			if binary {
				_ = writer.send(map[string]any{"type": "agent:workspace:file_content", "agentId": agentID, "requestId": requestID, "content": nil, "binary": true})
				continue
			}
			_ = writer.send(map[string]any{"type": "agent:workspace:file_content", "agentId": agentID, "requestId": requestID, "content": content, "binary": false})
		case "machine:workspace:scan":
			directories := manager.scanAllWorkspaces()
			_ = writer.send(map[string]any{"type": "machine:workspace:scan_result", "directories": directories})
		case "machine:workspace:delete":
			directoryName := getString(incoming, "directoryName")
			success := manager.deleteWorkspaceDirectory(directoryName)
			_ = writer.send(map[string]any{"type": "machine:workspace:delete_result", "directoryName": directoryName, "success": success})
		case "ping":
			_ = writer.send(map[string]any{"type": "pong"})
		case "error":
			message, _ := incoming["error"].(string)
			fmt.Fprintf(os.Stderr, "relay error: %s\n", message)
		}
	}
}

func parseAgentConfig(value any, defaultServerURL, daemonAPIKey string) AgentConfig {
	cfg := AgentConfig{Runtime: "claude", ServerURL: defaultServerURL, AuthToken: daemonAPIKey}
	m, ok := value.(map[string]any)
	if !ok {
		return cfg
	}
	if v, ok := m["runtime"].(string); ok && strings.TrimSpace(v) != "" {
		cfg.Runtime = v
	}
	if v, ok := m["model"].(string); ok {
		cfg.Model = v
	}
	if v, ok := m["sessionId"].(string); ok {
		cfg.SessionID = v
	}
	if v, ok := m["serverUrl"].(string); ok && strings.TrimSpace(v) != "" {
		cfg.ServerURL = v
	}
	if v, ok := m["authToken"].(string); ok && strings.TrimSpace(v) != "" {
		cfg.AuthToken = v
	}
	if v, ok := m["name"].(string); ok {
		cfg.Name = v
	}
	if v, ok := m["displayName"].(string); ok {
		cfg.DisplayName = v
	}
	if v, ok := m["description"].(string); ok {
		cfg.Description = v
	}
	if v, ok := m["reasoningEffort"].(string); ok {
		cfg.ReasoningEffort = v
	}
	return cfg
}

func parseWakeMessage(value any) *IncomingChatMessage {
	m, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	msg := &IncomingChatMessage{
		ChannelName: getString(m, "channel_name"),
		ChannelType: getString(m, "channel_type"),
		Content:     getString(m, "content"),
		SenderName:  getString(m, "sender_name"),
		SenderType:  getString(m, "sender_type"),
		Timestamp:   getString(m, "timestamp"),
	}
	return msg
}

func parseUnreadSummary(value any) map[string]int {
	m, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]int)
	for key, raw := range m {
		switch v := raw.(type) {
		case float64:
			out[key] = int(v)
		case int:
			out[key] = v
		}
	}
	return out
}

func getString(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

func startHeartbeat(writer *jsonWriter, hostName string, runtimes []string, stop <-chan struct{}) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			_ = writer.send(heartbeatMessage{Type: "heartbeat", HostName: hostName, Runtimes: runtimes})
		case <-stop:
			return
		}
	}
}

func startAPIHeartbeat(serverURL, apiKey, hostName string, runtimes []string, stop <-chan struct{}) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			_ = sendHeartbeatToAPI(serverURL, apiKey, hostName, runtimes)
		case <-stop:
			return
		}
	}
}

func sendHeartbeatToAPI(serverURL, apiKey, hostName string, runtimes []string) error {
	payload := map[string]any{
		"hostName": hostName,
		"runtimes": runtimes,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	endpoint := strings.TrimRight(serverURL, "/") + "/api/machines/heartbeat"
	request, err := http.NewRequest("POST", endpoint, strings.NewReader(string(body)))
	if err != nil {
		return err
	}

	request.Header.Set("authorization", "Bearer "+apiKey)
	request.Header.Set("content-type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("heartbeat failed with status %d", response.StatusCode)
	}

	return nil
}

func detectRuntimes() []string {
	runtimeCandidates := []string{"claude", "codex"}
	available := make([]string, 0, len(runtimeCandidates))
	for _, runtime := range runtimeCandidates {
		if _, err := exec.LookPath(runtime); err == nil {
			available = append(available, runtime)
		}
	}
	return available
}

func resolveChatBridgePath(explicitPath string) string {
	candidates := make([]string, 0)
	if strings.TrimSpace(explicitPath) != "" {
		candidates = append(candidates, explicitPath)
	}
	if envPath := strings.TrimSpace(os.Getenv("SLOCK_CHAT_BRIDGE_PATH")); envPath != "" {
		candidates = append(candidates, envPath)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "package", "dist", "chat-bridge.js"),
			filepath.Join(cwd, "..", "package", "dist", "chat-bridge.js"),
		)
	}
	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		candidates = append(candidates,
			filepath.Join(exeDir, "chat-bridge.js"),
			filepath.Join(exeDir, "..", "package", "dist", "chat-bridge.js"),
		)
	}

	seen := map[string]struct{}{}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		abs, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		if _, ok := seen[abs]; ok {
			continue
		}
		seen[abs] = struct{}{}
		if info, err := os.Stat(abs); err == nil && !info.IsDir() {
			return abs
		}
	}
	return ""
}

func minDuration(value, max time.Duration) time.Duration {
	if value > max {
		return max
	}
	return value
}

type jsonWriter struct {
	connection *websocket.Conn
	mutex      sync.Mutex
}

func (w *jsonWriter) send(payload any) error {
	w.mutex.Lock()
	defer w.mutex.Unlock()
	return w.connection.WriteJSON(payload)
}

func runCommand(writer *jsonWriter, message runCommandMessage) {
	command := exec.Command("bash", "-lc", message.Command)

	stdoutPipe, err := command.StdoutPipe()
	if err != nil {
		_ = writer.send(exitMessage{Type: "command-exit", CommandID: message.CommandID, ExitCode: -1})
		return
	}

	stderrPipe, err := command.StderrPipe()
	if err != nil {
		_ = writer.send(exitMessage{Type: "command-exit", CommandID: message.CommandID, ExitCode: -1})
		return
	}

	if err := command.Start(); err != nil {
		_ = writer.send(outputMessage{Type: "command-output", CommandID: message.CommandID, Stream: "stderr", Chunk: err.Error() + "\n"})
		_ = writer.send(exitMessage{Type: "command-exit", CommandID: message.CommandID, ExitCode: -1})
		return
	}

	var streamWg sync.WaitGroup
	streamWg.Add(2)

	go func() {
		defer streamWg.Done()
		streamOutput(writer, stdoutPipe, message.CommandID, "stdout")
	}()

	go func() {
		defer streamWg.Done()
		streamOutput(writer, stderrPipe, message.CommandID, "stderr")
	}()

	waitErr := command.Wait()
	streamWg.Wait()

	exitCode := 0
	if waitErr != nil {
		if exitError, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitError.ExitCode()
		} else {
			exitCode = -1
		}
	}

	_ = writer.send(exitMessage{Type: "command-exit", CommandID: message.CommandID, ExitCode: exitCode})
}

func streamOutput(writer *jsonWriter, stream io.Reader, commandID, streamName string) {
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 4096), 1024*1024)

	for scanner.Scan() {
		_ = writer.send(outputMessage{
			Type:      "command-output",
			CommandID: commandID,
			Stream:    streamName,
			Chunk:     scanner.Text() + "\n",
		})
	}

	if err := scanner.Err(); err != nil {
		if strings.Contains(err.Error(), "file already closed") {
			return
		}
		_ = writer.send(outputMessage{
			Type:      "command-output",
			CommandID: commandID,
			Stream:    "stderr",
			Chunk:     "stream read error: " + err.Error() + "\n",
		})
	}
}
