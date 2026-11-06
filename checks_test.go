package main

import (
	"reflect"
	"testing"
)

const checksJSON = `[
  {"name":"lint","state":"SUCCESS","link":"https://ci/lint","bucket":"pass"},
  {"name":"test","state":"FAILURE","link":"https://ci/test","bucket":"fail"},
  {"name":"deploy","state":"SKIPPED","link":"","bucket":"skipping"},
  {"name":"build","state":"IN_PROGRESS","link":"https://ci/build","bucket":"pending"}
]`

func TestParseChecksPutsFailuresAndPendingFirst(t *testing.T) {
	got, err := parseChecks(ghResult{Stdout: []byte(checksJSON), ExitCode: 0})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, c := range got {
		names = append(names, c.Name)
	}
	if want := []string{"test", "build", "lint", "deploy"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("order = %v, want %v", names, want)
	}
	if got[0] != (Check{Name: "test", State: "FAILURE", Link: "https://ci/test", Bucket: "fail"}) {
		t.Fatalf("first check = %+v", got[0])
	}
}

// gh exits 1 when a check failed and 8 while checks are pending, and still prints the list.
func TestParseChecksReadsTheListWhenGHExitsForFailedOrPendingChecks(t *testing.T) {
	for _, code := range []int{1, 8} {
		got, err := parseChecks(ghResult{Stdout: []byte(checksJSON), ExitCode: code})
		if err != nil || len(got) != 4 {
			t.Fatalf("exit %d: %d checks, err %v", code, len(got), err)
		}
	}
}

func TestParseChecksWithNoChecksIsAnEmptyList(t *testing.T) {
	got, err := parseChecks(ghResult{ExitCode: 1, Stderr: "no checks reported on the 'feat' branch\n"})
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("got %v, err %v; want an empty list", got, err)
	}
}

func TestParseChecksReportsWhatGHSaidOnOtherFailures(t *testing.T) {
	_, err := parseChecks(ghResult{ExitCode: 4, Stderr: "To get started with GitHub CLI, please run: gh auth login\n"})
	if err == nil || err.Error() != "GitHub said: To get started with GitHub CLI, please run: gh auth login" {
		t.Fatalf("err = %v", err)
	}
	_, err = parseChecks(ghResult{ExitCode: 1, Stderr: "GraphQL: Could not resolve to a PullRequest\n"})
	if err == nil {
		t.Fatal("a failure without a list was taken as no checks")
	}
}
