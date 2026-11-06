package main

import (
	"path/filepath"
	"testing"
)

func TestParseOpenURL(t *testing.T) {
	good := "git-tree-compare://open?repo=cli/cli&pr=14960"
	got, err := parseOpenURL(good)
	if err != nil || got != (OpenLink{Slug: "cli/cli", PR: 14960}) {
		t.Fatalf("parseOpenURL(%q) = %+v, %v", good, got, err)
	}

	// Any web page can send one of these, so anything off the exact shape is refused.
	bad := []string{
		"",
		"https://open?repo=cli/cli&pr=1",
		"git-tree-compare://other?repo=cli/cli&pr=1",
		"git-tree-compare://open?pr=1",
		"git-tree-compare://open?repo=cli&pr=1",
		"git-tree-compare://open?repo=cli/cli/extra&pr=1",
		"git-tree-compare://open?repo=-x/cli&pr=1",
		"git-tree-compare://open?repo=cli/cli%20--help&pr=1",
		"git-tree-compare://open?repo=cli/cli",
		"git-tree-compare://open?repo=cli/cli&pr=0",
		"git-tree-compare://open?repo=cli/cli&pr=-1",
		"git-tree-compare://open?repo=cli/cli&pr=1x",
	}
	for _, raw := range bad {
		if link, err := parseOpenURL(raw); err == nil {
			t.Errorf("parseOpenURL(%q) = %+v, want an error", raw, link)
		}
	}
}

// cloneOf creates a repository at parent/name whose named remote points at url.
func cloneOf(t *testing.T, parent, name, remote, url string) string {
	t.Helper()
	dir := filepath.Join(parent, name)
	for _, args := range [][]string{{"init", "--quiet", dir}, {"-C", dir, "remote", "add", remote, url}} {
		if _, err := runGit(parent, args...); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestFindClone(t *testing.T) {
	work := t.TempDir()
	other := t.TempDir()
	recentRepo := cloneOf(t, work, "recent", "origin", "https://github.com/me/recent.git")
	sibling := cloneOf(t, work, "sibling", "origin", "git@github.com:cli/cli.git")
	fork := cloneOf(t, other, "my-fork", "upstream", "https://github.com/o/r")
	gone := filepath.Join(work, "deleted")

	tests := []struct {
		name  string
		slug  string
		known []string
		want  string
	}{
		{"a known repository", "me/recent", []string{gone, recentRepo}, recentRepo},
		{"a repository beside a known one", "cli/cli", []string{recentRepo}, sibling},
		{"a fork's upstream", "o/r", []string{fork}, fork},
		{"not next to anything known", "o/r", []string{recentRepo}, ""},
		{"a slug that only ends the same", "li/cli", []string{sibling}, ""},
		{"nothing known", "cli/cli", nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FindClone(tt.slug, tt.known); got != tt.want {
				t.Fatalf("FindClone(%q, %v) = %q, want %q", tt.slug, tt.known, got, tt.want)
			}
		})
	}
}
