package main

import (
	"bufio"
	"os"
	"reflect"
	"testing"
)

// parseFixture runs every line of a recorded stream through the parser. brief.jsonl and text.jsonl
// are trimmed from real claude runs; budget.jsonl follows the shape of a run that hit its budget.
func parseFixture(t *testing.T, name string, p streamParser) []ClaudeEvent {
	t.Helper()
	f, err := os.Open("testdata/claude/" + name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var events []ClaudeEvent
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		events = append(events, p.parse(scanner.Bytes())...)
	}
	return events
}

func TestParseStreamReportsToolsAndTheStructuredResult(t *testing.T) {
	got := parseFixture(t, "brief.jsonl", streamParser{roots: []string{"/tmp/wt"}, partial: true})
	want := []ClaudeEvent{
		{Kind: "tool", Name: "Glob"},
		{Kind: "tool", Name: "Read", Path: "limit.go"},
		{Kind: "result", JSON: []byte(`{"word":"banana","limit":42}`), Text: `{"word":"banana","limit":42}`, CostUSD: 0.0016434700000000002},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %+v\nwant %+v", got, want)
	}
}

func TestParseStreamTakesTextFromDeltasWhenPartial(t *testing.T) {
	got := parseFixture(t, "text.jsonl", streamParser{partial: true})
	want := []ClaudeEvent{
		{Kind: "text", Delta: "Hello there"},
		{Kind: "text", Delta: ", n"},
		{Kind: "text", Delta: "ice to meet you!"},
		{Kind: "result", Text: "Hello there, nice to meet you!", CostUSD: 0.015247},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %+v\nwant %+v", got, want)
	}
}

// Without partial messages the whole message is the only copy of the text.
func TestParseStreamTakesTextFromTheMessageWhenNotPartial(t *testing.T) {
	got := parseFixture(t, "text.jsonl", streamParser{})
	if len(got) != 2 || !reflect.DeepEqual(got[0], ClaudeEvent{Kind: "text", Delta: "Hello there, nice to meet you!"}) || got[1].Kind != "result" {
		t.Fatalf("got %+v", got)
	}
}

func TestParseStreamTurnsAFailedResultIntoAnError(t *testing.T) {
	got := parseFixture(t, "budget.jsonl", streamParser{})
	want := []ClaudeEvent{{Kind: "error", Message: "Reached maximum budget ($0.1)"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseStreamToolPaths(t *testing.T) {
	p := streamParser{roots: []string{"/var/wt", "/private/var/wt"}}
	cases := map[string]ClaudeEvent{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/private/var/wt/pkg/a.go"}}]}}`: {Kind: "tool", Name: "Read", Path: "pkg/a.go"},
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"x","path":"/var/wt/cmd"}}]}}`:     {Kind: "tool", Name: "Grep", Path: "cmd"},
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/etc/hosts"}}]}}`:               {Kind: "tool", Name: "Read", Path: "/etc/hosts"},
	}
	for line, want := range cases {
		if got := p.parse([]byte(line)); len(got) != 1 || !reflect.DeepEqual(got[0], want) {
			t.Errorf("%s\ngot %+v, want %+v", line, got, want)
		}
	}
}

func TestParseStreamIgnoresWhatItDoesNotUse(t *testing.T) {
	for _, line := range []string{
		``,
		`{`,
		`{"type":"rate_limit_event"}`,
		`{"type":"system","subtype":"status","status":"requesting"}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"secret"}]}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{"ok":true}}]}}`,
		`{"type":"something_new","payload":1}`,
	} {
		if got := (streamParser{partial: true}).parse([]byte(line)); len(got) != 0 {
			t.Errorf("%q gave %+v", line, got)
		}
	}
}

func TestParseStreamSaysWhyAResultFailed(t *testing.T) {
	cases := map[string]string{
		// An API error ends with subtype success but is_error set.
		`{"type":"result","subtype":"success","is_error":true,"result":"API Error: 500"}`:                "API Error: 500",
		`{"type":"result","subtype":"error_during_execution","errors":["one","two"],"result":"ignored"}`: "one; two",
		`{"type":"result","subtype":"error_max_turns"}`:                                                  "Claude stopped: error_max_turns",
	}
	for line, want := range cases {
		got := streamParser{}.parse([]byte(line))
		if !reflect.DeepEqual(got, []ClaudeEvent{{Kind: "error", Message: want}}) {
			t.Errorf("%s: got %+v, want the error %q", line, got, want)
		}
	}
}
