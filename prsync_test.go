package main

import (
	"fmt"
	"os"
	"path/filepath"
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
	q := viewedMutation(true, 2)
	for _, want := range []string{"$p0: String!", "$p1: String!", "m0: markFileAsViewed", "path: $p1"} {
		if !strings.Contains(q, want) {
			t.Fatalf("viewedMutation(true, 2) missing %q:\n%s", want, q)
		}
	}
	if strings.Contains(q, "a.ts") {
		t.Fatal("paths must be passed as variables, not written into the query")
	}
}

// fakeGH puts a gh on PATH that appends each call's arguments to a log file.
func fakeGH(t *testing.T) (logPath string) {
	t.Helper()
	dir := t.TempDir()
	logPath = filepath.Join(dir, "calls")
	script := "#!/bin/sh\nprintf '%s\\n---\\n' \"$*\" >> \"" + logPath + "\"\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return logPath
}

func TestSetViewedSendsBatches(t *testing.T) {
	log := fakeGH(t)
	paths := make([]string, markBatchSize+1)
	for i := range paths {
		paths[i] = fmt.Sprintf("f%d.ts", i)
	}

	if err := SetViewed(t.TempDir(), "PR_1", paths, false); err != nil {
		t.Fatal(err)
	}

	calls, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	got := string(calls)
	if strings.Count(got, "---") != 2 {
		t.Fatalf("want 2 requests for %d files:\n%s", len(paths), got)
	}
	if !strings.Contains(got, "unmarkFileAsViewed") || !strings.Contains(got, "id=PR_1") || !strings.Contains(got, fmt.Sprintf("=f%d.ts", markBatchSize)) {
		t.Fatalf("calls = %s", got)
	}
}
