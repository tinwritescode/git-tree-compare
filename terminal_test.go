package main

import (
	"testing"
	"time"
)

// A shell that is told to exit should end, and the session should be forgotten.
func TestTerminalShellExitClearsSession(t *testing.T) {
	a := NewApp()
	if err := a.StartTerminal(t.TempDir(), 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := a.WriteTerminal("exit\n"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for currentSession() != nil {
		if time.Now().After(deadline) {
			t.Fatal("the shell did not exit")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
