package main

import (
	"strings"
	"testing"
)

func TestParsePRFiles(t *testing.T) {
	out := []byte(`{"data":{"node":{"files":{"pageInfo":{"hasNextPage":true,"endCursor":"c1"},` +
		`"nodes":[{"path":"a.ts","viewerViewedState":"VIEWED"},{"path":"b.ts","viewerViewedState":"UNVIEWED"}]}}}}`)

	states, next, more, err := parsePRFiles(out)
	if err != nil {
		t.Fatal(err)
	}
	if states["a.ts"] != "VIEWED" || states["b.ts"] != "UNVIEWED" || len(states) != 2 {
		t.Fatalf("states = %v", states)
	}
	if next != "c1" || !more {
		t.Fatalf("next = %q, more = %v", next, more)
	}
}

func TestMarkMutationUsesVariables(t *testing.T) {
	q := markMutation(2)
	for _, want := range []string{"$p0: String!", "$p1: String!", "m0: markFileAsViewed", "path: $p1"} {
		if !strings.Contains(q, want) {
			t.Fatalf("markMutation(2) missing %q:\n%s", want, q)
		}
	}
	if strings.Contains(q, "a.ts") {
		t.Fatal("paths must be passed as variables, not written into the query")
	}
}
