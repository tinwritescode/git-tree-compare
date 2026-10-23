package main

import (
	"strings"
	"testing"
)

func TestRunCommandOutputAndExitCode(t *testing.T) {
	ok := RunCommand(t.TempDir(), "echo hello")
	if ok.ExitCode != 0 || !strings.Contains(ok.Output, "hello") {
		t.Fatalf("RunCommand(echo) = %+v", ok)
	}

	failed := RunCommand(t.TempDir(), "echo oops >&2; exit 3")
	if failed.ExitCode != 3 || !strings.Contains(failed.Output, "oops") {
		t.Fatalf("RunCommand(exit 3) = %+v", failed)
	}
}
