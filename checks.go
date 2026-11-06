package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strconv"
	"strings"
)

// Check is one CI check on a pull request's head. Bucket is gh's grouping of State:
// pass, fail, pending, skipping or cancel.
type Check struct {
	Name   string `json:"name"`
	State  string `json:"state"`
	Link   string `json:"link"`
	Bucket string `json:"bucket"`
}

// ghResult is what a gh command printed and how it exited.
type ghResult struct {
	Stdout   []byte
	ExitCode int
	Stderr   string
}

// bucketRank orders checks so the ones that need attention come first.
var bucketRank = map[string]int{"fail": 0, "pending": 1, "cancel": 2, "pass": 3, "skipping": 4}

// parseChecks reads `gh pr checks --json`. gh exits 1 when a check failed and 8 while checks are
// pending, and prints the list either way; with no checks at all it prints nothing and says so.
func parseChecks(r ghResult) ([]Check, error) {
	listed := r.ExitCode == 0 || r.ExitCode == 1 || r.ExitCode == 8
	if listed && len(bytes.TrimSpace(r.Stdout)) > 0 {
		var checks []Check
		if err := json.Unmarshal(r.Stdout, &checks); err != nil {
			return nil, fmt.Errorf("could not read the checks: %w", err)
		}
		slices.SortStableFunc(checks, func(a, b Check) int { return rank(a.Bucket) - rank(b.Bucket) })
		return checks, nil
	}
	if listed && strings.Contains(r.Stderr, "no checks reported") {
		return []Check{}, nil
	}
	return nil, fmt.Errorf("GitHub said: %s", strings.TrimSpace(r.Stderr))
}

func rank(bucket string) int {
	if r, ok := bucketRank[bucket]; ok {
		return r
	}
	return len(bucketRank)
}

// PRChecks lists the CI checks on the pull request's head, failing and pending first.
func PRChecks(repo string, number int) ([]Check, error) {
	cmd := exec.Command("gh", "pr", "checks", strconv.Itoa(number), "--json", "name,state,link,bucket")
	cmd.Dir = repo
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	code := 0
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		code = exit.ExitCode()
	} else if err != nil {
		return nil, err
	}
	return parseChecks(ghResult{Stdout: out, ExitCode: code, Stderr: stderr.String()})
}
