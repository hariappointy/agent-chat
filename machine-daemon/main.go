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

func main() {
	relayURL := flag.String("relay-url", "", "relay websocket URL (legacy)")
	serverURL := flag.String("server-url", "", "server base URL for API bootstrap")
	apiKey := flag.String("api-key", "", "machine API key")
	token := flag.String("token", "", "daemon auth token (legacy)")
	name := flag.String("name", "", "display name for UI")
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
		err = connectAndServe(resolvedRelayURL, resolvedToken, hostName, runtimes, *serverURL, *apiKey)
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

	return bootstrap.RelayWsUrl, bootstrap.DaemonToken, nil
}

type bootstrapResponse struct {
	DaemonToken string `json:"daemonToken"`
	RelayWsUrl  string `json:"relayWsUrl"`
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

func connectAndServe(relayURL, token, hostName string, runtimes []string, serverURL, apiKey string) error {
	connection, _, err := websocket.DefaultDialer.Dial(relayURL, nil)
	if err != nil {
		return err
	}
	defer connection.Close()

	writer := &jsonWriter{connection: connection}
	if err := writer.send(authMessage{Type: "auth", Token: token, HostName: hostName, Runtimes: runtimes}); err != nil {
		return err
	}
	_ = writer.send(heartbeatMessage{Type: "heartbeat", HostName: hostName, Runtimes: runtimes})

	stopHeartbeat := make(chan struct{})
	go startHeartbeat(writer, hostName, runtimes, stopHeartbeat)
	if apiKey != "" && serverURL != "" {
		go startApiHeartbeat(serverURL, apiKey, hostName, runtimes, stopHeartbeat)
	}

	for {
		_, raw, err := connection.ReadMessage()
		if err != nil {
			close(stopHeartbeat)
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
		case "run-command":
			commandID, _ := incoming["commandId"].(string)
			command, _ := incoming["command"].(string)
			if commandID == "" || command == "" {
				continue
			}

			go runCommand(writer, runCommandMessage{Type: "run-command", CommandID: commandID, Command: command})
		case "error":
			message, _ := incoming["error"].(string)
			fmt.Fprintf(os.Stderr, "relay error: %s\n", message)
		}
	}
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

func startApiHeartbeat(serverURL, apiKey, hostName string, runtimes []string, stop <-chan struct{}) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			_ = sendHeartbeatToApi(serverURL, apiKey, hostName, runtimes)
		case <-stop:
			return
		}
	}
}

func sendHeartbeatToApi(serverURL, apiKey, hostName string, runtimes []string) error {
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

func streamOutput(writer *jsonWriter, stream io.Reader, commandID string, streamName string) {
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
		_ = writer.send(outputMessage{
			Type:      "command-output",
			CommandID: commandID,
			Stream:    "stderr",
			Chunk:     "stream read error: " + err.Error() + "\n",
		})
	}
}
