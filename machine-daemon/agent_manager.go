package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxTrajectoryTextLen = 2000
	maxReadableFileSize  = 1 << 20
)

var textExtensions = map[string]struct{}{
	".md": {}, ".txt": {}, ".json": {}, ".js": {}, ".ts": {}, ".jsx": {}, ".tsx": {},
	".yaml": {}, ".yml": {}, ".toml": {}, ".log": {}, ".csv": {}, ".xml": {},
	".html": {}, ".css": {}, ".sh": {}, ".py": {},
}

type AgentConfig struct {
	AuthToken       string `json:"authToken,omitempty"`
	Description     string `json:"description,omitempty"`
	DisplayName     string `json:"displayName,omitempty"`
	Model           string `json:"model,omitempty"`
	Name            string `json:"name,omitempty"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
	Runtime         string `json:"runtime,omitempty"`
	ServerURL       string `json:"serverUrl,omitempty"`
	SessionID       string `json:"sessionId,omitempty"`
}

type IncomingChatMessage struct {
	ChannelName string `json:"channel_name,omitempty"`
	ChannelType string `json:"channel_type,omitempty"`
	Content     string `json:"content,omitempty"`
	SenderName  string `json:"sender_name,omitempty"`
	SenderType  string `json:"sender_type,omitempty"`
	Timestamp   string `json:"timestamp,omitempty"`
}

type workspaceNode struct {
	IsDirectory bool   `json:"isDirectory"`
	ModifiedAt  string `json:"modifiedAt"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	Size        int64  `json:"size"`
}

type workspaceDirInfo struct {
	DirectoryName  string `json:"directoryName"`
	FileCount      int    `json:"fileCount"`
	LastModified   string `json:"lastModified"`
	TotalSizeBytes int64  `json:"totalSizeBytes"`
}

type parsedEventKind string

const (
	eventError      parsedEventKind = "error"
	eventSession    parsedEventKind = "session_init"
	eventText       parsedEventKind = "text"
	eventThinking   parsedEventKind = "thinking"
	eventToolCall   parsedEventKind = "tool_call"
	eventTurnEnd    parsedEventKind = "turn_end"
	statusActive    string          = "active"
	statusInactive  string          = "inactive"
	statusSleeping  string          = "sleeping"
	activityOffline string          = "offline"
	activityOnline  string          = "online"
	activitySleep   string          = "sleeping"
	activityThink   string          = "thinking"
	activityWork    string          = "working"
)

type parsedEvent struct {
	Input     any
	Kind      parsedEventKind
	Message   string
	Name      string
	SessionID string
	Text      string
}

type agentProcess struct {
	cmd       *exec.Cmd
	config    AgentConfig
	agentID   string
	stdin     io.WriteCloser
	sessionID string
	workspace string
}

type agentManager struct {
	mu             sync.Mutex
	agents         map[string]*agentProcess
	chatBridgePath string
	daemonAPIKey   string
	defaultSrvURL  string
	sendJSON       func(payload any) error
}

func newAgentManager(chatBridgePath, defaultServerURL, daemonAPIKey string, sendJSON func(payload any) error) *agentManager {
	return &agentManager{
		agents:         make(map[string]*agentProcess),
		chatBridgePath: chatBridgePath,
		daemonAPIKey:   daemonAPIKey,
		defaultSrvURL:  defaultServerURL,
		sendJSON:       sendJSON,
	}
}

func (m *agentManager) startAgent(agentID string, config AgentConfig, wakeMessage *IncomingChatMessage, unreadSummary map[string]int) error {
	if strings.TrimSpace(agentID) == "" {
		return errors.New("agentId is required")
	}

	runtimeID := strings.TrimSpace(config.Runtime)
	if runtimeID == "" {
		runtimeID = "claude"
	}
	if runtimeID != "claude" {
		return fmt.Errorf("runtime %q not supported yet in machine-daemon (claude only)", runtimeID)
	}

	m.mu.Lock()
	if _, ok := m.agents[agentID]; ok {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()

	workspace, err := ensureAgentWorkspace(agentID, config)
	if err != nil {
		return err
	}

	prompt := buildClaudePrompt(config, wakeMessage, unreadSummary)
	proc, err := m.spawnClaude(agentID, workspace, config, prompt)
	if err != nil {
		return err
	}

	m.mu.Lock()
	m.agents[agentID] = proc
	m.mu.Unlock()

	_ = m.sendJSON(map[string]any{"type": "agent:status", "agentId": agentID, "status": statusActive})
	_ = m.sendJSON(map[string]any{"type": "agent:activity", "agentId": agentID, "activity": activityWork, "detail": "Starting..."})

	go m.streamClaude(agentID, proc)
	go m.waitClaudeExit(agentID, proc)
	return nil
}

func (m *agentManager) stopAgent(agentID string) {
	m.mu.Lock()
	proc := m.agents[agentID]
	delete(m.agents, agentID)
	m.mu.Unlock()
	if proc == nil {
		return
	}
	_ = proc.cmd.Process.Kill()
	_ = m.sendJSON(map[string]any{"type": "agent:status", "agentId": agentID, "status": statusInactive})
	_ = m.sendJSON(map[string]any{"type": "agent:activity", "agentId": agentID, "activity": activityOffline, "detail": ""})
}

func (m *agentManager) sleepAgent(agentID string) {
	m.mu.Lock()
	proc := m.agents[agentID]
	delete(m.agents, agentID)
	m.mu.Unlock()
	if proc == nil {
		return
	}
	_ = proc.cmd.Process.Kill()
	_ = m.sendJSON(map[string]any{"type": "agent:status", "agentId": agentID, "status": statusSleeping})
	_ = m.sendJSON(map[string]any{"type": "agent:activity", "agentId": agentID, "activity": activitySleep, "detail": ""})
}

func (m *agentManager) deliverMessage(agentID string, msg IncomingChatMessage) {
	m.mu.Lock()
	proc := m.agents[agentID]
	m.mu.Unlock()
	if proc == nil || proc.stdin == nil {
		return
	}

	channelLabel := "#all"
	if msg.ChannelType == "dm" {
		channelLabel = "DM:@" + msg.ChannelName
	} else if msg.ChannelName != "" {
		channelLabel = "#" + msg.ChannelName
	}

	senderPrefix := ""
	if msg.SenderType == "agent" {
		senderPrefix = "(agent) "
	}
	text := fmt.Sprintf("[%s] %s@%s: %s", channelLabel, senderPrefix, msg.SenderName, msg.Content)
	payload := encodeClaudeUserMessage("New message received:\n\n"+text, proc.sessionID)
	_, _ = proc.stdin.Write([]byte(payload + "\n"))
}

func (m *agentManager) resetWorkspace(agentID string) {
	dir := filepath.Join(agentWorkspaceRoot(), agentID)
	_ = os.RemoveAll(dir)
}

func (m *agentManager) stopAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.agents))
	for id := range m.agents {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.stopAgent(id)
	}
}

func (m *agentManager) runningAgentIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make([]string, 0, len(m.agents))
	for id := range m.agents {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (m *agentManager) scanAllWorkspaces() []workspaceDirInfo {
	root := agentWorkspaceRoot()
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	out := make([]workspaceDirInfo, 0)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(root, entry.Name())
		children, err := os.ReadDir(path)
		if err != nil {
			continue
		}
		var total int64
		latest := time.Time{}
		fileCount := 0
		for _, child := range children {
			info, err := child.Info()
			if err != nil {
				continue
			}
			if !child.IsDir() {
				total += info.Size()
				fileCount++
			}
			if info.ModTime().After(latest) {
				latest = info.ModTime()
			}
		}
		out = append(out, workspaceDirInfo{
			DirectoryName:  entry.Name(),
			TotalSizeBytes: total,
			LastModified:   latest.UTC().Format(time.RFC3339),
			FileCount:      fileCount,
		})
	}
	return out
}

func (m *agentManager) deleteWorkspaceDirectory(directoryName string) bool {
	if strings.Contains(directoryName, "/") || strings.Contains(directoryName, "\\") || strings.Contains(directoryName, "..") {
		return false
	}
	target := filepath.Join(agentWorkspaceRoot(), directoryName)
	if err := os.RemoveAll(target); err != nil {
		return false
	}
	return true
}

func (m *agentManager) getFileTree(agentID, dirPath string) []workspaceNode {
	agentRoot := filepath.Join(agentWorkspaceRoot(), agentID)
	if _, err := os.Stat(agentRoot); err != nil {
		return nil
	}
	target := agentRoot
	if strings.TrimSpace(dirPath) != "" {
		resolved := filepath.Clean(filepath.Join(agentRoot, dirPath))
		if !strings.HasPrefix(resolved, agentRoot) {
			return nil
		}
		target = resolved
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return nil
	}
	nodes := make([]workspaceNode, 0)
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") || name == "node_modules" {
			continue
		}
		fullPath := filepath.Join(target, name)
		info, err := entry.Info()
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(agentRoot, fullPath)
		if err != nil {
			continue
		}
		node := workspaceNode{
			Name:        name,
			Path:        filepath.ToSlash(rel),
			IsDirectory: entry.IsDir(),
			ModifiedAt:  info.ModTime().UTC().Format(time.RFC3339),
		}
		if !entry.IsDir() {
			node.Size = info.Size()
		}
		nodes = append(nodes, node)
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].IsDirectory && !nodes[j].IsDirectory {
			return true
		}
		if !nodes[i].IsDirectory && nodes[j].IsDirectory {
			return false
		}
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})
	return nodes
}

func (m *agentManager) readFile(agentID, relPath string) (string, bool, error) {
	agentRoot := filepath.Join(agentWorkspaceRoot(), agentID)
	resolved := filepath.Clean(filepath.Join(agentRoot, relPath))
	if !strings.HasPrefix(resolved, agentRoot) {
		return "", false, errors.New("access denied")
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", false, err
	}
	if info.IsDir() {
		return "", false, errors.New("cannot read directory")
	}
	ext := strings.ToLower(filepath.Ext(resolved))
	if ext != "" {
		if _, ok := textExtensions[ext]; !ok {
			return "", true, nil
		}
	}
	if info.Size() > maxReadableFileSize {
		return "", false, errors.New("file too large")
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return "", false, err
	}
	return string(data), false, nil
}

func (m *agentManager) spawnClaude(agentID, workspace string, config AgentConfig, prompt string) (*agentProcess, error) {
	if m.chatBridgePath == "" {
		return nil, errors.New("chat bridge path not found; set --chat-bridge-path or SLOCK_CHAT_BRIDGE_PATH")
	}
	bridgeCommand := "node"
	bridgeArgs := []string{m.chatBridgePath, "--agent-id", agentID, "--server-url", normalizeServerURL(config.ServerURL, m.defaultSrvURL), "--auth-token", firstNonEmpty(config.AuthToken, m.daemonAPIKey)}
	mcpConfig := map[string]any{
		"mcpServers": map[string]any{
			"chat": map[string]any{
				"command": bridgeCommand,
				"args":    bridgeArgs,
			},
		},
	}
	mcpConfigJSON, _ := json.Marshal(mcpConfig)

	model := strings.TrimSpace(config.Model)
	if model == "" {
		model = "sonnet"
	}
	args := []string{
		"--allow-dangerously-skip-permissions",
		"--dangerously-skip-permissions",
		"--verbose",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--mcp-config", string(mcpConfigJSON),
		"--model", model,
	}
	if strings.TrimSpace(config.SessionID) != "" {
		args = append(args, "--resume", config.SessionID)
	}

	cmd := exec.Command("claude", args...)
	cmd.Dir = workspace
	cmd.Env = append(os.Environ(), "FORCE_COLOR=0")

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	initPayload := encodeClaudeUserMessage(prompt, config.SessionID)
	if _, err := stdin.Write([]byte(initPayload + "\n")); err != nil {
		_ = cmd.Process.Kill()
		return nil, err
	}

	proc := &agentProcess{
		cmd:       cmd,
		config:    config,
		agentID:   agentID,
		stdin:     stdin,
		sessionID: config.SessionID,
		workspace: workspace,
	}

	go func() {
		s := bufio.NewScanner(stderr)
		s.Buffer(make([]byte, 8*1024), 1024*1024)
		for s.Scan() {
			line := strings.TrimSpace(s.Text())
			if line == "" {
				continue
			}
			if strings.Contains(line, "Reconnecting...") || strings.Contains(line, "Falling back from WebSockets") {
				continue
			}
			fmt.Fprintf(os.Stderr, "[Agent %s stderr] %s\n", agentID, line)
		}
	}()

	go m.consumeClaudeStdout(agentID, proc, stdout)
	return proc, nil
}

func (m *agentManager) consumeClaudeStdout(agentID string, proc *agentProcess, reader io.Reader) {
	s := bufio.NewScanner(reader)
	s.Buffer(make([]byte, 16*1024), 2*1024*1024)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" {
			continue
		}
		events := parseClaudeLine(line)
		for _, event := range events {
			m.handleParsedEvent(agentID, proc, event)
		}
	}
}

func (m *agentManager) streamClaude(agentID string, proc *agentProcess) {
	_ = agentID
	_ = proc
}

func (m *agentManager) waitClaudeExit(agentID string, proc *agentProcess) {
	err := proc.cmd.Wait()
	m.mu.Lock()
	current := m.agents[agentID]
	if current == proc {
		delete(m.agents, agentID)
	}
	m.mu.Unlock()

	if err == nil {
		_ = m.sendJSON(map[string]any{"type": "agent:status", "agentId": agentID, "status": statusSleeping})
		_ = m.sendJSON(map[string]any{"type": "agent:activity", "agentId": agentID, "activity": activitySleep, "detail": ""})
		return
	}

	_ = m.sendJSON(map[string]any{"type": "agent:status", "agentId": agentID, "status": statusInactive})
	_ = m.sendJSON(map[string]any{"type": "agent:activity", "agentId": agentID, "activity": activityOffline, "detail": fmt.Sprintf("Crashed (%v)", err)})
}

func (m *agentManager) handleParsedEvent(agentID string, proc *agentProcess, event parsedEvent) {
	entries := make([]map[string]any, 0)
	activity := ""
	detail := ""

	switch event.Kind {
	case eventSession:
		if strings.TrimSpace(event.SessionID) != "" {
			proc.sessionID = event.SessionID
			_ = m.sendJSON(map[string]any{"type": "agent:session", "agentId": agentID, "sessionId": event.SessionID})
		}
	case eventThinking:
		entries = append(entries, map[string]any{"kind": "thinking", "text": trimText(event.Text, maxTrajectoryTextLen)})
		activity = activityThink
	case eventText:
		entries = append(entries, map[string]any{"kind": "text", "text": trimText(event.Text, maxTrajectoryTextLen)})
		activity = activityThink
	case eventToolCall:
		toolName := event.Name
		entries = append(entries, map[string]any{"kind": "tool_start", "toolName": toolName, "toolInput": summarizeToolInput(toolName, event.Input)})
		if toolName == "mcp__chat__receive_message" {
			activity = activityOnline
		} else if toolName == "mcp__chat__send_message" {
			activity = activityWork
			detail = "Sending message..."
		} else {
			activity = activityWork
			detail = toolDisplayName(toolName)
		}
	case eventTurnEnd:
		activity = activityOnline
		if strings.TrimSpace(event.SessionID) != "" {
			proc.sessionID = event.SessionID
			_ = m.sendJSON(map[string]any{"type": "agent:session", "agentId": agentID, "sessionId": event.SessionID})
		}
	case eventError:
		entries = append(entries, map[string]any{"kind": "text", "text": "Error: " + event.Message})
	}

	if activity != "" {
		_ = m.sendJSON(map[string]any{"type": "agent:activity", "agentId": agentID, "activity": activity, "detail": detail})
		entries = append(entries, map[string]any{"kind": "status", "activity": activity, "detail": detail})
	}
	if len(entries) > 0 {
		_ = m.sendJSON(map[string]any{"type": "agent:trajectory", "agentId": agentID, "entries": entries})
	}
}

func parseClaudeLine(line string) []parsedEvent {
	var raw map[string]any
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return nil
	}

	typeVal, _ := raw["type"].(string)
	events := make([]parsedEvent, 0)
	switch typeVal {
	case "system":
		subtype, _ := raw["subtype"].(string)
		if subtype == "init" {
			sessionID, _ := raw["session_id"].(string)
			if sessionID != "" {
				events = append(events, parsedEvent{Kind: eventSession, SessionID: sessionID})
			}
		}
	case "assistant":
		message, _ := raw["message"].(map[string]any)
		content, _ := message["content"].([]any)
		for _, blockAny := range content {
			block, _ := blockAny.(map[string]any)
			blockType, _ := block["type"].(string)
			switch blockType {
			case "thinking":
				thinking, _ := block["thinking"].(string)
				if thinking != "" {
					events = append(events, parsedEvent{Kind: eventThinking, Text: thinking})
				}
			case "text":
				text, _ := block["text"].(string)
				if text != "" {
					events = append(events, parsedEvent{Kind: eventText, Text: text})
				}
			case "tool_use":
				name, _ := block["name"].(string)
				events = append(events, parsedEvent{Kind: eventToolCall, Name: firstNonEmpty(name, "unknown_tool"), Input: block["input"]})
			}
		}
	case "result":
		sessionID, _ := raw["session_id"].(string)
		events = append(events, parsedEvent{Kind: eventTurnEnd, SessionID: sessionID})
	}
	return events
}

func encodeClaudeUserMessage(text, sessionID string) string {
	payload := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": []map[string]any{{"type": "text", "text": text}},
		},
	}
	if strings.TrimSpace(sessionID) != "" {
		payload["session_id"] = sessionID
	}
	b, _ := json.Marshal(payload)
	return string(b)
}

func ensureAgentWorkspace(agentID string, config AgentConfig) (string, error) {
	workspace := filepath.Join(agentWorkspaceRoot(), agentID)
	if err := os.MkdirAll(filepath.Join(workspace, "notes"), 0o755); err != nil {
		return "", err
	}
	memoryPath := filepath.Join(workspace, "MEMORY.md")
	if _, err := os.Stat(memoryPath); errors.Is(err, os.ErrNotExist) {
		name := strings.TrimSpace(config.DisplayName)
		if name == "" {
			name = firstNonEmpty(strings.TrimSpace(config.Name), agentID)
		}
		content := fmt.Sprintf("# %s\n\n## Role\n%s\n\n## Key Knowledge\n- No notes yet.\n\n## Active Context\n- First startup.\n", name, firstNonEmpty(strings.TrimSpace(config.Description), "No role defined yet."))
		if err := os.WriteFile(memoryPath, []byte(content), 0o644); err != nil {
			return "", err
		}
	}
	return workspace, nil
}

func buildClaudePrompt(config AgentConfig, wakeMessage *IncomingChatMessage, unreadSummary map[string]int) string {
	if strings.TrimSpace(config.SessionID) == "" {
		return buildClaudeBaseSystemPrompt(config)
	}

	if wakeMessage != nil {
		channel := "#" + wakeMessage.ChannelName
		if wakeMessage.ChannelType == "dm" {
			channel = "DM:@" + wakeMessage.ChannelName
		}
		senderPrefix := ""
		if wakeMessage.SenderType == "agent" {
			senderPrefix = "(agent) "
		}
		prompt := fmt.Sprintf("New message received:\n\n[%s] %s@%s: %s\n\nRespond appropriately via send_message, then call receive_message(block=true).", channel, senderPrefix, wakeMessage.SenderName, wakeMessage.Content)
		if len(unreadSummary) > 0 {
			prompt += "\n\nUnread summary:\n"
			keys := make([]string, 0, len(unreadSummary))
			for k := range unreadSummary {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				prompt += fmt.Sprintf("- %s: %d unread\n", k, unreadSummary[k])
			}
		}
		return prompt
	}

	if len(unreadSummary) > 0 {
		prompt := "You have unread messages from while you were offline:\n"
		keys := make([]string, 0, len(unreadSummary))
		for k := range unreadSummary {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			prompt += fmt.Sprintf("- %s: %d unread\n", k, unreadSummary[k])
		}
		prompt += "\nUse read_history to catch up, then call receive_message(block=true)."
		return prompt
	}

	return "No new messages while you were away. Call receive_message(block=true) to listen for messages."
}

func buildClaudeBaseSystemPrompt(config AgentConfig) string {
	name := firstNonEmpty(strings.TrimSpace(config.DisplayName), strings.TrimSpace(config.Name), "Agent")

	lines := []string{
		"You are \"" + name + "\", an AI agent in Slock — a collaborative platform for human-AI collaboration.",
		"",
		"## Who you are",
		"",
		"You are a long-running, persistent agent. You are NOT a one-shot assistant — you live across many sessions.",
		"",
		"## Communication — MCP tools ONLY",
		"",
		"Use only chat MCP tools:",
		"1. mcp__chat__receive_message",
		"2. mcp__chat__send_message",
		"3. mcp__chat__list_server",
		"4. mcp__chat__read_history",
		"",
		"CRITICAL RULES:",
		"- Do NOT output text directly. ALL communication goes through mcp__chat__send_message.",
		"- Do NOT use bash/curl/sqlite to send or receive messages. The MCP tools handle everything.",
		"- Do NOT explore filesystem looking for messaging scripts.",
		"",
		"## Startup sequence",
		"",
		"1. Read MEMORY.md in cwd.",
		"2. Read referenced memory files from MEMORY.md (notes/channels.md, notes/user-preferences.md, etc).",
		"3. Call mcp__chat__receive_message(block=true) to start listening.",
		"4. When you receive a message, process and reply via mcp__chat__send_message.",
		"5. After replying, call mcp__chat__receive_message(block=true) again.",
		"",
		"## Messaging",
		"",
		"Messages include channel prefix like [#all] or [DM:@name]. Reuse the same channel identifier when replying.",
		"- Reply channel: send_message(channel=\"#channel\", content=\"...\")",
		"- Reply DM: send_message(channel=\"DM:@name\", content=\"...\")",
		"- Start new DM: send_message(dm_to=\"name\", content=\"...\")",
		"",
		"Use list_server to discover channels/agents/humans.",
		"Use read_history for context and unread catch-up.",
		"",
		"## Communication style",
		"",
		"- Acknowledge tasks and briefly state plan.",
		"- Send concise progress updates for multi-step work.",
		"- Summarize result when done.",
		"",
		"## Workspace & Memory",
		"",
		"Your cwd is persistent workspace.",
		"MEMORY.md is your memory index and must stay up to date.",
		"Maintain notes/ for user preferences, channel context, work log, and domain knowledge.",
		"Before long tasks, update Active Context in MEMORY.md so you can recover after context compression.",
		"",
		"## Message Notifications",
		"",
		"While busy, you may receive: [System notification: You have N new message(s) waiting...]",
		"- Do NOT interrupt current work mid-step.",
		"- After finishing current step, call receive_message(block=false) to check queued messages.",
		"- Do not ignore notifications for too long.",
	}

	if strings.TrimSpace(config.Description) != "" {
		lines = append(lines, "", "## Initial role", strings.TrimSpace(config.Description)+". This may evolve.")
	}

	return strings.Join(lines, "\n")
}

func agentWorkspaceRoot() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = "."
	}
	return filepath.Join(home, ".slock", "agents")
}

func normalizeServerURL(value, fallback string) string {
	v := strings.TrimSpace(value)
	if v != "" {
		return v
	}
	return strings.TrimSpace(fallback)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func trimText(text string, max int) string {
	if len(text) <= max {
		return text
	}
	return text[:max] + "…"
}

func toolDisplayName(name string) string {
	if strings.HasPrefix(name, "mcp__chat__") {
		return ""
	}
	switch name {
	case "Read", "read_file":
		return "Reading file..."
	case "Write", "write_file":
		return "Writing file..."
	case "Edit", "edit_file":
		return "Editing file..."
	case "Bash", "bash":
		return "Running command..."
	case "Glob", "glob":
		return "Searching files..."
	case "Grep", "grep":
		return "Searching code..."
	case "WebFetch", "web_fetch":
		return "Fetching web..."
	case "WebSearch", "web_search":
		return "Searching web..."
	case "TodoWrite":
		return "Updating tasks..."
	default:
		if len(name) > 20 {
			return "Using " + name[:20] + "..."
		}
		return "Using " + name + "..."
	}
}

func summarizeToolInput(name string, input any) string {
	in, ok := input.(map[string]any)
	if !ok {
		return ""
	}
	getString := func(key string) string {
		v, _ := in[key].(string)
		return v
	}
	switch name {
	case "Read", "read_file", "Write", "write_file", "Edit", "edit_file":
		return firstNonEmpty(getString("file_path"), getString("path"))
	case "Bash", "bash":
		cmd := getString("command")
		if len(cmd) > 100 {
			return cmd[:100] + "..."
		}
		return cmd
	case "Glob", "glob":
		return getString("pattern")
	case "Grep", "grep":
		return getString("pattern")
	case "WebFetch", "web_fetch":
		return getString("url")
	case "WebSearch", "web_search":
		return getString("query")
	case "mcp__chat__send_message":
		channel := getString("channel")
		if channel != "" {
			return channel
		}
		dmTo := getString("dm_to")
		if dmTo != "" {
			return "DM:@" + dmTo
		}
	}
	if name == "mcp__chat__read_history" {
		return getString("channel")
	}
	return ""
}

func detectOSLabel() string {
	return runtime.GOOS + " " + runtime.GOARCH
}
