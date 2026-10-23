package main

import (
	"reflect"
	"testing"
)

func TestParseNameStatus(t *testing.T) {
	out := "M\tfrontend/src/App.tsx\nA\tgit.go\nD\told.txt\nR087\tsrc/a.go\tsrc/b.go\n"

	got := parseNameStatus(out)

	want := []FileChange{
		{Path: "frontend/src/App.tsx", Status: "M"},
		{Path: "git.go", Status: "A"},
		{Path: "old.txt", Status: "D"},
		{Path: "src/b.go", OldPath: "src/a.go", Status: "R"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseNameStatus() = %+v, want %+v", got, want)
	}
}

func TestParseNameStatusEmpty(t *testing.T) {
	if got := parseNameStatus(""); len(got) != 0 {
		t.Fatalf("parseNameStatus(\"\") = %+v, want empty", got)
	}
}

func TestSplitLines(t *testing.T) {
	got := splitLines("main\n\nfeature/x\n")
	want := []string{"main", "feature/x"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("splitLines() = %v, want %v", got, want)
	}
}
