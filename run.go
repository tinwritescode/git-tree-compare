package main

import (
	"context"
	"errors"
	"os/exec"
	"time"
)

const runTimeout = 5 * time.Minute

// RunResult is the outcome of a command run from the app.
type RunResult struct {
	Output   string `json:"output"`
	ExitCode int    `json:"exitCode"`
	TimedOut bool   `json:"timedOut"`
}

// RunCommand runs a shell command in repo and returns its combined output.
// The app runs what the user typed, so the command is not sanitised.
func RunCommand(repo, command string) RunResult {
	ctx, cancel := context.WithTimeout(context.Background(), runTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Dir = repo
	out, err := cmd.CombinedOutput()

	res := RunResult{Output: string(out)}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		res.TimedOut = true
		res.ExitCode = -1
		return res
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		res.ExitCode = exitErr.ExitCode()
	} else if err != nil {
		res.ExitCode = -1
		res.Output += err.Error()
	}
	return res
}
