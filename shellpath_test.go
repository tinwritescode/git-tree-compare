package main

import "testing"

func TestJoinPathPutsTheLoginPathFirstAndDropsRepeats(t *testing.T) {
	got := joinPath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin", "", "/usr/local/bin")
	want := "/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin"
	if got != want {
		t.Fatalf("joinPath = %q, want %q", got, want)
	}
}

func TestLastLineSkipsWhatAProfilePrints(t *testing.T) {
	if got := lastLine("Welcome back\n/opt/homebrew/bin:/usr/bin\n"); got != "/opt/homebrew/bin:/usr/bin" {
		t.Fatalf("lastLine = %q", got)
	}
}
