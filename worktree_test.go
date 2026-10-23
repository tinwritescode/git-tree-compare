package main

import (
	"reflect"
	"testing"
)

func TestParseWorktrees(t *testing.T) {
	out := "worktree /repo\n" +
		"HEAD 1111111\n" +
		"branch refs/heads/staging\n" +
		"\n" +
		"worktree /repo-feature\n" +
		"HEAD 2222222\n" +
		"branch refs/heads/feat/x\n" +
		"\n" +
		"worktree /repo-detached\n" +
		"HEAD 3333333\n" +
		"detached\n" +
		"\n" +
		"worktree /bare.git\n" +
		"bare\n"

	got := parseWorktrees(out)

	want := []Worktree{
		{Path: "/repo", Head: "1111111", Branch: "staging"},
		{Path: "/repo-feature", Head: "2222222", Branch: "feat/x"},
		{Path: "/repo-detached", Head: "3333333", Detached: true},
		{Path: "/bare.git", Bare: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseWorktrees() = %+v, want %+v", got, want)
	}
}
