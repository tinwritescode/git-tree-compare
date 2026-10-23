package main

import (
	"reflect"
	"testing"
)

func TestDiffArgsWorkingTree(t *testing.T) {
	got := diffArgs(Scope{Base: "main"}, "abc123", []string{"--name-status"}, "")
	want := []string{"diff", "-M", "--name-status", "abc123"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("diffArgs() = %v, want %v", got, want)
	}
}

func TestDiffArgsCommitIgnoreWhitespacePath(t *testing.T) {
	got := diffArgs(Scope{Commit: "def456", IgnoreWS: true}, "", nil, "src/a.go")
	want := []string{"show", "--format=", "-M", "-w", "def456", "--", "src/a.go"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("diffArgs() = %v, want %v", got, want)
	}
}

func TestScopeLabel(t *testing.T) {
	if got := scopeLabel(Scope{Commit: "0123456789abc"}); got != "commit-01234567" {
		t.Fatalf("scopeLabel(commit) = %q", got)
	}
	if got := scopeLabel(Scope{}); got != "working-tree" {
		t.Fatalf("scopeLabel(working tree) = %q", got)
	}
}
