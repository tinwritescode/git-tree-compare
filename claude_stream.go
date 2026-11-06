package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

// ClaudeEvent is one thing a Claude task reports to the frontend, as the event claude:<taskId>.
// Kind says which fields are set: tool (Name, Path), text (Delta), result (JSON, Text, CostUSD)
// or error (Message). The frontend parses it into a union at its boundary.
type ClaudeEvent struct {
	Kind    string          `json:"kind"`
	Name    string          `json:"name,omitempty"`
	Path    string          `json:"path,omitempty"`
	Delta   string          `json:"delta,omitempty"`
	JSON    json.RawMessage `json:"json,omitempty"`
	Text    string          `json:"text,omitempty"`
	CostUSD float64         `json:"costUsd,omitempty"`
	Message string          `json:"message,omitempty"`
}

func errorEvent(message string) ClaudeEvent {
	return ClaudeEvent{Kind: "error", Message: message}
}

// structuredOutputTool is how claude hands back a --json-schema answer. It reads nothing, so it is
// not reported as a tool.
const structuredOutputTool = "StructuredOutput"

// streamParser reads `claude --output-format stream-json` one line at a time. It reads only the
// fields it reports and skips every other line, so new line types in later claude versions are harmless.
type streamParser struct {
	roots   []string // the task's working folder, as given and with symlinks resolved; tool paths are shown relative to it
	partial bool     // --include-partial-messages: text is taken from the deltas, as whole messages repeat it
}

// streamLine is the part of a stream-json line the parser reads.
type streamLine struct {
	Type    string `json:"type"`
	Message struct {
		Content []struct {
			Type  string `json:"type"`
			Text  string `json:"text"`
			Name  string `json:"name"`
			Input struct {
				FilePath string `json:"file_path"`
				Path     string `json:"path"`
			} `json:"input"`
		} `json:"content"`
	} `json:"message"`
	Event struct {
		Type  string `json:"type"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	} `json:"event"`
	// The final result line.
	Subtype          string          `json:"subtype"`
	IsError          bool            `json:"is_error"`
	Result           string          `json:"result"`
	StructuredOutput json.RawMessage `json:"structured_output"`
	TotalCostUSD     float64         `json:"total_cost_usd"`
	Errors           []string        `json:"errors"`
}

func (p streamParser) parse(line []byte) []ClaudeEvent {
	var l streamLine
	if json.Unmarshal(line, &l) != nil {
		return nil
	}
	switch l.Type {
	case "assistant":
		return p.assistant(l)
	case "stream_event":
		if p.partial && l.Event.Type == "content_block_delta" && l.Event.Delta.Type == "text_delta" && l.Event.Delta.Text != "" {
			return []ClaudeEvent{{Kind: "text", Delta: l.Event.Delta.Text}}
		}
	case "result":
		return []ClaudeEvent{resultEvent(l)}
	}
	return nil
}

func (p streamParser) assistant(l streamLine) []ClaudeEvent {
	var events []ClaudeEvent
	for _, block := range l.Message.Content {
		switch {
		case block.Type == "tool_use" && block.Name != structuredOutputTool:
			path := block.Input.FilePath
			if path == "" {
				path = block.Input.Path
			}
			events = append(events, ClaudeEvent{Kind: "tool", Name: block.Name, Path: p.relative(path)})
		case block.Type == "text" && !p.partial && block.Text != "":
			events = append(events, ClaudeEvent{Kind: "text", Delta: block.Text})
		}
	}
	return events
}

// relative shows a path inside the working folder as a repository path, and any other path as is.
func (p streamParser) relative(path string) string {
	for _, root := range p.roots {
		if rel, err := filepath.Rel(root, path); err == nil && filepath.IsLocal(rel) {
			return filepath.ToSlash(rel)
		}
	}
	return path
}

func resultEvent(l streamLine) ClaudeEvent {
	if l.IsError || l.Subtype != "success" {
		switch {
		case len(l.Errors) > 0:
			return errorEvent(strings.Join(l.Errors, "; "))
		case l.Result != "":
			return errorEvent(l.Result)
		default:
			return errorEvent("Claude stopped: " + l.Subtype)
		}
	}
	ev := ClaudeEvent{Kind: "result", Text: l.Result, CostUSD: l.TotalCostUSD}
	if s := strings.TrimSpace(string(l.StructuredOutput)); s != "" && s != "null" {
		ev.JSON = l.StructuredOutput
	}
	return ev
}
