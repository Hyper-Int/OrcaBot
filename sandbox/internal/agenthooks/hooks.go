// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: gemini-ui-v1-hide-sandbox-status

package agenthooks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/mcp"
)

// GenerateHooksForAgent creates stop hook configurations for the specified agent.
// It writes shell scripts to /workspace/.orcabot/hooks/ and updates agent config files.
// The scripts use ORCABOT_SESSION_ID and ORCABOT_PTY_ID environment variables
// (set by the PTY) so they work correctly for any PTY in the workspace.
func GenerateHooksForAgent(workspaceRoot string, agentType mcp.AgentType, sessionID, ptyID string) error {
	// Note: sessionID and ptyID parameters are kept for API compatibility but not used.
	// Scripts use environment variables instead to support multiple PTYs correctly.
	_ = sessionID
	_ = ptyID

	if agentType == mcp.AgentTypeUnknown {
		return nil
	}

	// Create hooks directory
	hooksDir := filepath.Join(workspaceRoot, ".orcabot", "hooks")
	if err := os.MkdirAll(hooksDir, 0755); err != nil {
		return fmt.Errorf("failed to create hooks dir: %w", err)
	}

	switch agentType {
	case mcp.AgentTypeClaude:
		return generateClaudeHooks(workspaceRoot, hooksDir)
	case mcp.AgentTypeGemini:
		return generateGeminiHooks(workspaceRoot, hooksDir)
	case mcp.AgentTypeOpenCode:
		return generateOpenCodeHooks(workspaceRoot, hooksDir)
	case mcp.AgentTypeMoltbot:
		return generateMoltbotHooks(workspaceRoot, hooksDir)
	case mcp.AgentTypeDroid:
		return generateDroidHooks(workspaceRoot, hooksDir)
	case mcp.AgentTypeCodex:
		return generateCodexHooks(workspaceRoot, hooksDir)
	default:
		return nil
	}
}

// generateClaudeHooks creates Stop hook for Claude Code
func generateClaudeHooks(workspaceRoot, hooksDir string) error {
	// Create the shell script - uses env vars set by PTY
	scriptPath := filepath.Join(hooksDir, "claude-stop.sh")
	script := `#!/bin/bash
# Claude Code stop hook - reads JSON from stdin, posts to sandbox
# Uses ORCABOT_SESSION_ID, ORCABOT_PTY_ID, and MCP_LOCAL_PORT env vars set by the PTY process
PORT="${MCP_LOCAL_PORT:-8081}"
LOGFILE="/tmp/claude-hook-debug.log"
INPUT=$(cat)
echo "=== Hook invoked at $(date) ===" >> "$LOGFILE"
echo "Full input JSON:" >> "$LOGFILE"
echo "$INPUT" | jq '.' >> "$LOGFILE" 2>&1
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
echo "Transcript: $TRANSCRIPT" >> "$LOGFILE"

# Function to extract last assistant text message from transcript
# Claude Code writes separate messages for thinking and text content
# We look for assistant messages with text content (ignore stop_reason, it's always null)
# IMPORTANT: stop at the first "user" message to avoid returning a previous turn's response
extract_last_text() {
    local count=0
    local seen_assistant=0
    tac "$TRANSCRIPT" 2>/dev/null | while IFS= read -r line; do
        msg_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
        count=$((count + 1))

        # Log every message type we see (first 20 lines)
        if [ $count -le 20 ]; then
            echo "  Line $count: type=$msg_type" >> "$LOGFILE"
        fi

        # Stop at user message boundary - we've gone past the current turn
        if [ "$msg_type" = "user" ]; then
            if [ $seen_assistant -gt 0 ]; then
                echo "  Hit user message at line $count after $seen_assistant assistant msgs - stopping (current turn has no usable text)" >> "$LOGFILE"
                exit 1
            fi
        fi

        if [ "$msg_type" = "assistant" ]; then
            seen_assistant=$((seen_assistant + 1))

            # Log the full assistant message structure
            echo "  Found assistant message at line $count" >> "$LOGFILE"

            # Log what content types exist
            content_types=$(echo "$line" | jq -r '(.message.content // .content // []) | [.[].type] | join(",")' 2>/dev/null)
            echo "    content_types=$content_types" >> "$LOGFILE"

            # Try .message.content first, then .content - look for text blocks
            text=$(echo "$line" | jq -r '
                (.message.content // .content // [])
                | [.[] | select(.type == "text") | .text]
                | join("\n")
            ' 2>/dev/null)

            echo "    extracted text length=${#text}" >> "$LOGFILE"

            if [ -n "$text" ] && [ "$text" != "null" ] && [ "$text" != "" ] && [ "$text" != "(no content)" ]; then
                echo "$text"
                exit 0
            else
                echo "    No usable text (empty or placeholder), continuing..." >> "$LOGFILE"
            fi
        fi
    done
}

# Wait for transcript file to stop being modified (Claude still writing)
wait_for_stable() {
    local prev_size=0
    local curr_size=0
    local stable_count=0
    for i in 1 2 3 4 5 6 7 8 9 10; do
        curr_size=$(stat -c%s "$TRANSCRIPT" 2>/dev/null || echo "0")
        if [ "$curr_size" = "$prev_size" ]; then
            stable_count=$((stable_count + 1))
            if [ $stable_count -ge 2 ]; then
                echo "Transcript stable after $i checks" >> "$LOGFILE"
                return 0
            fi
        else
            stable_count=0
        fi
        prev_size=$curr_size
        sleep 0.3
    done
    echo "Transcript did not stabilize" >> "$LOGFILE"
}

LAST_MSG=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    # Log transcript file stats
    FILESIZE=$(stat -c%s "$TRANSCRIPT" 2>/dev/null || echo "0")
    LINECOUNT=$(wc -l < "$TRANSCRIPT" 2>/dev/null || echo "0")
    echo "Transcript file: size=$FILESIZE bytes, lines=$LINECOUNT" >> "$LOGFILE"

    # Log last 5 lines of transcript for debugging
    echo "Last 5 lines of transcript:" >> "$LOGFILE"
    tail -5 "$TRANSCRIPT" | while IFS= read -r line; do
        echo "  $(echo "$line" | jq -c '{type, stop_reason: .message.stop_reason}' 2>/dev/null)" >> "$LOGFILE"
    done

    # Wait for file to stop changing
    wait_for_stable

    # Extract message
    echo "Extracting last assistant text..." >> "$LOGFILE"
    LAST_MSG=$(extract_last_text | head -c 4096)

    echo "Final message from transcript (${#LAST_MSG} chars): ${LAST_MSG:0:200}" >> "$LOGFILE"
else
    echo "No transcript path provided or file missing" >> "$LOGFILE"
fi

# Fallback: if transcript didn't have the text, use PTY scrollback
if [ -z "$LAST_MSG" ]; then
    echo "Transcript fallback: fetching PTY scrollback..." >> "$LOGFILE"
    SCROLLBACK=$(curl -s "http://localhost:$PORT/sessions/$ORCABOT_SESSION_ID/ptys/$ORCABOT_PTY_ID/scrollback" 2>/dev/null)
    if [ -n "$SCROLLBACK" ]; then
        echo "Raw scrollback (last 500 chars): ...${SCROLLBACK: -500}" >> "$LOGFILE"
        # Claude Code marks assistant responses with ● (bullet)
        # Extract text after the LAST ● up to the next ❯ (prompt) or end
        # Use perl for reliable unicode handling
        LAST_MSG=$(echo "$SCROLLBACK" | perl -0777 -ne '
            # Find all blocks between ● and the next ❯ or end of string
            my @blocks;
            while (/●\s*(.*?)(?=❯|\z)/sg) {
                push @blocks, $1;
            }
            # Use the last block found
            if (@blocks) {
                my $msg = $blocks[-1];
                $msg =~ s/^\s+//;  # trim leading whitespace
                $msg =~ s/\s+$//;  # trim trailing whitespace
                # Remove Claude Code TUI artifacts
                $msg =~ s/^-{5,}$//mg;                          # separator lines
                $msg =~ s/\x{2728}.*?\(thinking\)//g;           # ✨ ... (thinking)
                $msg =~ s/\x{2736}.*?\(thinking\)//g;           # ✶ ... (thinking)
                $msg =~ s/\x{25cf}.*?\(thinking\)//g;           # ● ... (thinking)
                $msg =~ s/\(thinking\)//g;                       # bare (thinking)
                $msg =~ s/Fluttering\x{2026}//g;                # Fluttering…
                $msg =~ s/Pondering\x{2026}//g;                 # Pondering…
                $msg =~ s/Thinking\x{2026}//g;                  # Thinking…
                $msg =~ s/\?\s+for\s+shortcuts//g;               # ? for shortcuts
                $msg =~ s/[\x00-\x08\x0b\x0c\x0e-\x1f]//g;    # control chars
                $msg =~ s/^\s*\n//mg;                            # blank lines
                $msg =~ s/^\s+//;                                # leading whitespace
                $msg =~ s/\s+$//;                                # trailing whitespace
                print substr($msg, 0, 4096) if length($msg) > 0;
            }
        ' 2>/dev/null)
        echo "Scrollback fallback (${#LAST_MSG} chars): ${LAST_MSG:0:200}" >> "$LOGFILE"
    else
        echo "Scrollback fetch failed" >> "$LOGFILE"
    fi
fi

[ -z "$LAST_MSG" ] && LAST_MSG="Agent completed"

curl -sX POST "http://localhost:$PORT/sessions/$ORCABOT_SESSION_ID/ptys/$ORCABOT_PTY_ID/agent-stopped" \
  -H "Content-Type: application/json" \
  -d "{\"agent\":\"claude-code\",\"lastMessage\":$(echo "$LAST_MSG" | jq -Rs .),\"reason\":\"complete\"}"
`

	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		return fmt.Errorf("failed to write claude hook script: %w", err)
	}

	// Update Claude settings to include the Stop hook
	// Use settings.local.json because Claude Code overwrites settings.json on startup
	settingsPath := filepath.Join(workspaceRoot, ".claude", "settings.local.json")
	return mergeClaudeHookSettings(settingsPath, scriptPath)
}

// mergeClaudeHookSettings adds Stop hook to existing Claude settings without overwriting user hooks
func mergeClaudeHookSettings(settingsPath, scriptPath string) error {
	fmt.Fprintf(os.Stderr, "[DEBUG] mergeClaudeHookSettings called: settingsPath=%s scriptPath=%s\n", settingsPath, scriptPath)

	// Ensure directory exists
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0755); err != nil {
		fmt.Fprintf(os.Stderr, "[DEBUG] MkdirAll failed: %v\n", err)
		return err
	}

	// Read existing settings or create new
	var settings map[string]interface{}
	data, err := os.ReadFile(settingsPath)
	if err == nil {
		fmt.Fprintf(os.Stderr, "[DEBUG] Read existing settings: %s\n", string(data))
		if err := json.Unmarshal(data, &settings); err != nil {
			fmt.Fprintf(os.Stderr, "[DEBUG] Unmarshal failed, creating new: %v\n", err)
			settings = make(map[string]interface{})
		}
	} else {
		fmt.Fprintf(os.Stderr, "[DEBUG] No existing settings file, creating new: %v\n", err)
		settings = make(map[string]interface{})
	}

	// Get or create hooks map
	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		hooks = make(map[string]interface{})
	}

	// Claude Code hook format requires nested structure:
	// { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "..." } ] } ] } }
	// See: https://code.claude.com/docs/en/hooks
	ourHook := map[string]interface{}{
		"hooks": []interface{}{
			map[string]interface{}{
				"type":    "command",
				"command": scriptPath,
			},
		},
	}

	// Get existing Stop hooks or create new array
	existingStopHooks, ok := hooks["Stop"].([]interface{})
	if !ok {
		existingStopHooks = []interface{}{}
	}

	// Check if our hook is already present (by matching scriptPath in nested hooks)
	alreadyPresent := false
	for _, h := range existingStopHooks {
		if hookMap, ok := h.(map[string]interface{}); ok {
			if innerHooks, ok := hookMap["hooks"].([]interface{}); ok {
				for _, ih := range innerHooks {
					if ihMap, ok := ih.(map[string]interface{}); ok {
						if cmd, ok := ihMap["command"].(string); ok && cmd == scriptPath {
							alreadyPresent = true
							break
						}
					}
				}
			}
		}
		if alreadyPresent {
			break
		}
	}

	// Only append if not already present
	if !alreadyPresent {
		existingStopHooks = append(existingStopHooks, ourHook)
	}

	hooks["Stop"] = existingStopHooks
	settings["hooks"] = hooks

	// Write back
	data, err = json.MarshalIndent(settings, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "[DEBUG] MarshalIndent failed: %v\n", err)
		return err
	}
	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "[DEBUG] WriteFile failed: %v\n", err)
		return err
	}
	fmt.Fprintf(os.Stderr, "[DEBUG] Successfully wrote hooks to %s\n", settingsPath)
	return nil
}

// generateGeminiHooks creates AfterAgent hook for Gemini CLI
func generateGeminiHooks(workspaceRoot, hooksDir string) error {
	scriptPath := filepath.Join(hooksDir, "gemini-stop.sh")
	script := `#!/bin/bash
# Gemini CLI AfterAgent hook
# Uses ORCABOT_SESSION_ID, ORCABOT_PTY_ID, and MCP_LOCAL_PORT env vars set by the PTY process
PORT="${MCP_LOCAL_PORT:-8081}"
LOGFILE="/tmp/gemini-hook-debug.log"
INPUT=$(cat)
echo "=== Gemini hook invoked at $(date) ===" >> "$LOGFILE"

# Primary: use transcript file (clean content, no streaming duplication)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
LAST_MSG=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    # Gemini transcript is a JSON file with a messages array
    # Extract the last gemini message content
    LAST_MSG=$(jq -r '.messages | map(select(.type == "gemini")) | last | .content // empty' "$TRANSCRIPT" 2>/dev/null | head -c 4096)
    echo "Transcript message (${#LAST_MSG} chars): ${LAST_MSG:0:200}" >> "$LOGFILE"
fi

# Fallback: use prompt_response from hook input (may have streaming duplication)
if [ -z "$LAST_MSG" ]; then
    LAST_MSG=$(echo "$INPUT" | jq -r '.prompt_response // empty' 2>/dev/null | head -c 4096)
    echo "Fallback to prompt_response (${#LAST_MSG} chars): ${LAST_MSG:0:200}" >> "$LOGFILE"
fi

[ -z "$LAST_MSG" ] && LAST_MSG="Agent completed"

curl -sX POST "http://localhost:$PORT/sessions/$ORCABOT_SESSION_ID/ptys/$ORCABOT_PTY_ID/agent-stopped" \
  -H "Content-Type: application/json" \
  -d "{\"agent\":\"gemini\",\"lastMessage\":$(echo "$LAST_MSG" | jq -Rs .),\"reason\":\"complete\"}"
echo '{}'  # Gemini requires JSON output
`

	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		return fmt.Errorf("failed to write gemini hook script: %w", err)
	}

	// Write Gemini system override settings to a separate file.
	// Gemini CLI overwrites ~/.gemini/settings.json on startup (losing our ui/hooks sections).
	// Using GEMINI_CLI_SYSTEM_SETTINGS_PATH (highest precedence, never overwritten by CLI)
	// ensures our settings persist. The env var is set in session.go CreatePTY.
	overrideDir := filepath.Join(workspaceRoot, ".orcabot")
	if err := os.MkdirAll(overrideDir, 0755); err != nil {
		return fmt.Errorf("failed to create orcabot dir: %w", err)
	}
	overridePath := filepath.Join(overrideDir, "gemini-system-settings.json")
	return mergeGeminiHookSettings(overridePath, scriptPath, workspaceRoot)
}

// mergeGeminiHookSettings adds AfterAgent hook to existing Gemini settings without overwriting user hooks.
// It also mirrors auth-related fields from ~/.gemini/settings.json into the system override,
// so the user's chosen auth method (e.g., OAuth from "gemini login") survives CLI restarts.
func mergeGeminiHookSettings(settingsPath, scriptPath, workspaceRoot string) error {
	fmt.Fprintf(os.Stderr, "[DEBUG] mergeGeminiHookSettings called: settingsPath=%s scriptPath=%s\n", settingsPath, scriptPath)

	if err := os.MkdirAll(filepath.Dir(settingsPath), 0755); err != nil {
		fmt.Fprintf(os.Stderr, "[DEBUG] Gemini MkdirAll failed: %v\n", err)
		return err
	}

	var settings map[string]interface{}
	data, err := os.ReadFile(settingsPath)
	if err == nil {
		fmt.Fprintf(os.Stderr, "[DEBUG] Gemini read existing settings: %s\n", string(data))
		if err := json.Unmarshal(data, &settings); err != nil {
			settings = make(map[string]interface{})
		}
	} else {
		fmt.Fprintf(os.Stderr, "[DEBUG] Gemini no existing settings, creating new: %v\n", err)
		settings = make(map[string]interface{})
	}

	// Suppress home directory warning (we're in a sandbox VM, not a real home dir)
	ui, ok := settings["ui"].(map[string]interface{})
	if !ok {
		ui = make(map[string]interface{})
	}
	ui["showHomeDirectoryWarning"] = false

	// Hide "no sandbox" footer indicator — Gemini is already running inside an isolated sandbox VM
	footer, ok := ui["footer"].(map[string]interface{})
	if !ok {
		footer = make(map[string]interface{})
	}
	footer["hideSandboxStatus"] = true
	ui["footer"] = footer

	settings["ui"] = ui

	// Mirror auth-related fields from ~/.gemini/settings.json into the system override.
	// When a user runs "gemini login", Gemini CLI writes the auth method to settings.json.
	// Since Gemini CLI also overwrites settings.json on startup (potentially resetting auth),
	// putting the auth method in the system override (highest precedence) ensures it persists.
	geminiUserSettings := filepath.Join(workspaceRoot, ".gemini", "settings.json")
	if geminiData, readErr := os.ReadFile(geminiUserSettings); readErr == nil {
		var userSettings map[string]interface{}
		if json.Unmarshal(geminiData, &userSettings) == nil {
			for _, authKey := range []string{"selectedAuthType", "authType", "authMethod"} {
				if val, exists := userSettings[authKey]; exists {
					settings[authKey] = val
				}
			}
		}
	}

	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		hooks = make(map[string]interface{})
	}

	// Gemini CLI hook format requires nested structure:
	// { "hooks": { "AfterAgent": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
	ourHookEntry := map[string]interface{}{
		"type":    "command",
		"command": scriptPath,
		"name":    "orcabot-stop",
	}

	ourMatcherGroup := map[string]interface{}{
		"matcher": "*",
		"hooks":   []interface{}{ourHookEntry},
	}

	// Get existing AfterAgent hooks
	existingAfterAgent, ok := hooks["AfterAgent"].([]interface{})
	if !ok {
		existingAfterAgent = []interface{}{}
	}

	// Check if our hook is already present (look inside nested hooks arrays)
	alreadyPresent := false
	for _, matcherGroup := range existingAfterAgent {
		if mg, ok := matcherGroup.(map[string]interface{}); ok {
			if innerHooks, ok := mg["hooks"].([]interface{}); ok {
				for _, h := range innerHooks {
					if hookMap, ok := h.(map[string]interface{}); ok {
						if cmd, ok := hookMap["command"].(string); ok && cmd == scriptPath {
							alreadyPresent = true
							break
						}
					}
				}
			}
		}
		if alreadyPresent {
			break
		}
	}

	// Only append if not already present
	if !alreadyPresent {
		existingAfterAgent = append(existingAfterAgent, ourMatcherGroup)
	}

	hooks["AfterAgent"] = existingAfterAgent
	settings["hooks"] = hooks

	data, err = json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "[DEBUG] Writing Gemini settings: %s\n", string(data))
	if err := os.WriteFile(settingsPath, data, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "[DEBUG] Gemini WriteFile failed: %v\n", err)
		return err
	}
	fmt.Fprintf(os.Stderr, "[DEBUG] Successfully wrote Gemini hooks to %s\n", settingsPath)
	return nil
}

// generateOpenCodeHooks is a no-op for now.
// OpenCode rewrites its config on startup, mangling any entries we add.
// TODO: revisit when OpenCode's config/plugin format stabilizes.
func generateOpenCodeHooks(workspaceRoot, hooksDir string) error {
	return nil
}

// generateMoltbotHooks creates command:stop hook for OpenClaw
func generateMoltbotHooks(workspaceRoot, hooksDir string) error {
	// OpenClaw uses TypeScript hooks
	// Uses process.env for session/pty IDs and port
	scriptPath := filepath.Join(hooksDir, "openclaw-stop.ts")
	script := `// OpenClaw command:stop hook
// Uses ORCABOT_SESSION_ID, ORCABOT_PTY_ID, and MCP_LOCAL_PORT env vars set by the PTY process
import type { HookHandler } from '@openclaw/types';

const handler: HookHandler = async (event) => {
  const sessionId = process.env.ORCABOT_SESSION_ID;
  const ptyId = process.env.ORCABOT_PTY_ID;
  const port = process.env.MCP_LOCAL_PORT || '8081';
  if (!sessionId || !ptyId) {
    console.error('Missing ORCABOT_SESSION_ID or ORCABOT_PTY_ID');
    return;
  }
  const lastMsg = event.messages?.slice(-1)[0] || 'Agent completed';
  try {
    await fetch(
      "http://localhost:" + port + "/sessions/" + sessionId + "/ptys/" + ptyId + "/agent-stopped",
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'openclaw',
          lastMessage: typeof lastMsg === 'string' ? lastMsg.slice(0, 4096) : 'Agent completed',
          reason: 'complete'
        })
      }
    );
  } catch (e) {
    console.error('Failed to notify agent stopped:', e);
  }
};

export default handler;
`

	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		return fmt.Errorf("failed to write openclaw hook script: %w", err)
	}

	// Update OpenClaw config - merge with existing hooks
	openclawDir := filepath.Join(workspaceRoot, ".openclaw")
	if err := os.MkdirAll(openclawDir, 0755); err != nil {
		return err
	}

	configPath := filepath.Join(openclawDir, "config.json")
	var config map[string]interface{}
	data, err := os.ReadFile(configPath)
	if err == nil {
		json.Unmarshal(data, &config)
	}
	if config == nil {
		config = make(map[string]interface{})
	}

	hooks, ok := config["hooks"].(map[string]interface{})
	if !ok {
		hooks = make(map[string]interface{})
	}

	// Check if command:stop hook already exists with our handler
	if existingHook, ok := hooks["command:stop"].(map[string]interface{}); ok {
		if handler, ok := existingHook["handler"].(string); ok && handler == scriptPath {
			// Already configured with our handler, nothing to do
			return nil
		}
		// User has a different handler - check if handlers array exists
		if handlers, ok := existingHook["handlers"].([]interface{}); ok {
			// Check if our handler is already in the array
			alreadyPresent := false
			for _, h := range handlers {
				if hStr, ok := h.(string); ok && hStr == scriptPath {
					alreadyPresent = true
					break
				}
			}
			if !alreadyPresent {
				handlers = append(handlers, scriptPath)
				existingHook["handlers"] = handlers
			}
		} else {
			// Convert single handler to handlers array
			existingHandler := existingHook["handler"]
			existingHook["handlers"] = []interface{}{existingHandler, scriptPath}
			delete(existingHook, "handler")
		}
		hooks["command:stop"] = existingHook
	} else {
		// No existing command:stop hook, create new
		hooks["command:stop"] = map[string]interface{}{
			"enabled": true,
			"handler": scriptPath,
		}
	}
	config["hooks"] = hooks

	data, err = json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, data, 0644)
}

// generateDroidHooks creates Stop hook for Droid (Factory.ai)
func generateDroidHooks(workspaceRoot, hooksDir string) error {
	scriptPath := filepath.Join(hooksDir, "droid-stop.sh")
	script := `#!/bin/bash
# Droid (Factory.ai) Stop hook
# Uses ORCABOT_SESSION_ID, ORCABOT_PTY_ID, and MCP_LOCAL_PORT env vars set by the PTY process
PORT="${MCP_LOCAL_PORT:-8081}"
INPUT=$(cat)
LAST_MSG=$(echo "$INPUT" | jq -r '.tool_input // "Agent completed"' 2>/dev/null | head -c 4096)
curl -sX POST "http://localhost:$PORT/sessions/$ORCABOT_SESSION_ID/ptys/$ORCABOT_PTY_ID/agent-stopped" \
  -H "Content-Type: application/json" \
  -d "{\"agent\":\"droid\",\"lastMessage\":$(echo "$LAST_MSG" | jq -Rs .),\"reason\":\"complete\"}"
`

	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		return fmt.Errorf("failed to write droid hook script: %w", err)
	}

	// Update Factory settings
	factoryDir := filepath.Join(workspaceRoot, ".factory")
	if err := os.MkdirAll(factoryDir, 0755); err != nil {
		return err
	}

	settingsPath := filepath.Join(factoryDir, "settings.json")
	var settings map[string]interface{}
	data, err := os.ReadFile(settingsPath)
	if err == nil {
		json.Unmarshal(data, &settings)
	}
	if settings == nil {
		settings = make(map[string]interface{})
	}

	hooks, ok := settings["hooks"].(map[string]interface{})
	if !ok {
		hooks = make(map[string]interface{})
	}

	// Droid uses same nested hook format as Claude Code
	// See: https://docs.factory.ai/cli/configuration/hooks-guide
	ourHook := map[string]interface{}{
		"hooks": []interface{}{
			map[string]interface{}{
				"type":    "command",
				"command": scriptPath,
			},
		},
	}

	// Get existing Stop hooks or create new array
	existingStopHooks, ok := hooks["Stop"].([]interface{})
	if !ok {
		existingStopHooks = []interface{}{}
	}

	// Check if our hook is already present (by matching scriptPath in nested hooks)
	alreadyPresent := false
	for _, h := range existingStopHooks {
		if hookMap, ok := h.(map[string]interface{}); ok {
			if innerHooks, ok := hookMap["hooks"].([]interface{}); ok {
				for _, ih := range innerHooks {
					if ihMap, ok := ih.(map[string]interface{}); ok {
						if cmd, ok := ihMap["command"].(string); ok && cmd == scriptPath {
							alreadyPresent = true
							break
						}
					}
				}
			}
		}
		if alreadyPresent {
			break
		}
	}

	// Only append if not already present
	if !alreadyPresent {
		existingStopHooks = append(existingStopHooks, ourHook)
	}

	hooks["Stop"] = existingStopHooks
	settings["hooks"] = hooks

	data, err = json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath, data, 0644)
}

// generateCodexHooks creates notify hook for Codex CLI
func generateCodexHooks(workspaceRoot, hooksDir string) error {
	scriptPath := filepath.Join(hooksDir, "codex-stop.sh")
	// Codex passes JSON as first argument, not stdin
	// Uses ORCABOT_SESSION_ID, ORCABOT_PTY_ID, and MCP_LOCAL_PORT env vars set by the PTY process
	script := `#!/bin/bash
# Codex CLI notify hook - receives JSON as first argument
# Uses ORCABOT_SESSION_ID, ORCABOT_PTY_ID, and MCP_LOCAL_PORT env vars set by the PTY process
PORT="${MCP_LOCAL_PORT:-8081}"
LOGFILE="/tmp/codex-hook-debug.log"
PAYLOAD="$1"
echo "=== Codex hook invoked at $(date) ===" >> "$LOGFILE"
echo "Payload: $PAYLOAD" >> "$LOGFILE"
echo "SESSION_ID: $ORCABOT_SESSION_ID, PTY_ID: $ORCABOT_PTY_ID, PORT: $PORT" >> "$LOGFILE"
EVENT_TYPE=$(echo "$PAYLOAD" | jq -r '.type // empty')
echo "Event type: $EVENT_TYPE" >> "$LOGFILE"

if [ "$EVENT_TYPE" = "agent-turn-complete" ]; then
    LAST_MSG=$(echo "$PAYLOAD" | jq -r '.["last-assistant-message"] // "Agent completed"' | head -c 4096)
    echo "Extracted message: $LAST_MSG" >> "$LOGFILE"
    curl -sX POST "http://localhost:$PORT/sessions/$ORCABOT_SESSION_ID/ptys/$ORCABOT_PTY_ID/agent-stopped" \
      -H "Content-Type: application/json" \
      -d "{\"agent\":\"codex\",\"lastMessage\":$(echo "$LAST_MSG" | jq -Rs .),\"reason\":\"complete\"}"
else
    echo "Ignoring non-completion event" >> "$LOGFILE"
fi
`

	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		return fmt.Errorf("failed to write codex hook script: %w", err)
	}

	// Write notify to /etc/codex/config.toml (system config).
	// Codex CLI overwrites ~/.codex/config.toml on startup, stripping our additions.
	// System config is read but not overwritten by Codex.
	systemCodexDir := "/etc/codex"
	if err := os.MkdirAll(systemCodexDir, 0755); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "[DEBUG] generateCodexHooks: systemCodexDir=%s\n", systemCodexDir)

	configPath := filepath.Join(systemCodexDir, "config.toml")

	// Read existing system config or create new
	var existingConfig string
	data, err := os.ReadFile(configPath)
	if err == nil {
		existingConfig = string(data)
	}

	// Check if our script is already in the config
	if strings.Contains(existingConfig, scriptPath) {
		// Already configured, nothing to do
		return nil
	}

	// Check if notify is already set
	if strings.Contains(existingConfig, "notify") {
		// Parse existing notify array and append our script
		lines := strings.Split(existingConfig, "\n")
		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "notify") {
				start := strings.Index(line, "[")
				end := strings.LastIndex(line, "]")
				if start != -1 && end != -1 && end > start {
					existing := strings.TrimSpace(line[start+1 : end])
					if existing == "" {
						lines[i] = fmt.Sprintf(`notify = ["%s"]`, scriptPath)
					} else {
						lines[i] = fmt.Sprintf(`notify = [%s, "%s"]`, existing, scriptPath)
					}
				}
				break
			}
		}
		existingConfig = strings.Join(lines, "\n")
	} else {
		// Add notify line
		if existingConfig != "" && !strings.HasSuffix(existingConfig, "\n") {
			existingConfig += "\n"
		}
		existingConfig += fmt.Sprintf("\n# OrcaBot agent stop notification\nnotify = [\"%s\"]\n", scriptPath)
	}

	fmt.Fprintf(os.Stderr, "[DEBUG] Writing Codex system config to %s:\n%s\n", configPath, existingConfig)
	if err := os.WriteFile(configPath, []byte(existingConfig), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "[DEBUG] Failed to write Codex system config: %v\n", err)
		return err
	}
	fmt.Fprintf(os.Stderr, "[DEBUG] Successfully wrote Codex hooks to %s\n", configPath)
	return nil
}
