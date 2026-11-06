package main

import (
	"strings"
	"testing"
)

// noiseRepo commits a file that only gains spaces, a renamed file, a renamed file that only
// gains spaces, a file marked linguist-generated, and a real change, so each kind of noise can be
// told apart.
func noiseRepo(t *testing.T) Scope {
	t.Helper()
	repo := t.TempDir()
	git := gitIn(t, repo)
	git("init", "-q", "-b", "main")
	writeFile(t, repo+"/.gitattributes", "gen/** linguist-generated\nkept.txt linguist-generated=false\n")
	writeFile(t, repo+"/spaces.txt", "a b\nc\n")
	writeFile(t, repo+"/old.txt", "moved\n")
	writeFile(t, repo+"/wide.txt", strings.Repeat("a line that stays\n", 20)+"last line\n")
	writeFile(t, repo+"/gen/api.txt", "one\n")
	writeFile(t, repo+"/kept.txt", "one\n")
	writeFile(t, repo+"/real.txt", "one\n")
	git("add", ".")
	git("commit", "-q", "-m", "first")
	base := git("rev-parse", "HEAD")
	writeFile(t, repo+"/spaces.txt", "a  b\nc\n")
	git("mv", "old.txt", "new.txt")
	git("mv", "wide.txt", "wider.txt")
	writeFile(t, repo+"/wider.txt", strings.Repeat("a line that stays\n", 20)+"last  line\n")
	writeFile(t, repo+"/gen/api.txt", "two\n")
	writeFile(t, repo+"/kept.txt", "two\n")
	writeFile(t, repo+"/real.txt", "two\n")
	git("add", ".")
	git("commit", "-q", "-m", "second")
	return Scope{Repo: repo, Base: base, Head: git("rev-parse", "HEAD")}
}

func TestChangedFilesReportsGeneratedAndWhitespaceOnly(t *testing.T) {
	for _, ignoreWS := range []bool{false, true} {
		s := noiseRepo(t)
		s.IgnoreWS = ignoreWS
		files, err := ChangedFiles(s)
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]FileChange{}
		for _, f := range files {
			got[f.Path] = f
		}
		want := map[string][2]bool{ // path -> generated, whitespace only
			"spaces.txt":  {false, true},
			"new.txt":     {false, false},
			"wider.txt":   {false, true},
			"gen/api.txt": {true, false},
			"kept.txt":    {false, false},
			"real.txt":    {false, false},
		}
		for path, w := range want {
			f, ok := got[path]
			if !ok {
				t.Fatalf("ignoreWS=%v: %s missing from %v", ignoreWS, path, files)
			}
			if f.Generated != w[0] || f.WhitespaceOnly != w[1] {
				t.Errorf("ignoreWS=%v: %s generated=%v whitespaceOnly=%v, want %v", ignoreWS, path, f.Generated, f.WhitespaceOnly, w)
			}
		}
		// The line counts still follow the whitespace option.
		if wantAdded := map[bool]int{false: 1, true: 0}[ignoreWS]; got["spaces.txt"].Added != wantAdded {
			t.Errorf("ignoreWS=%v: spaces.txt added = %d, want %d", ignoreWS, got["spaces.txt"].Added, wantAdded)
		}
	}
}

func TestParseCheckAttr(t *testing.T) {
	out := "a\x00linguist-generated\x00set\x00b\x00linguist-generated\x00true\x00c\x00linguist-generated\x00unspecified\x00d\x00linguist-generated\x00false\x00"
	got := parseGenerated(out)
	if len(got) != 2 || !got["a"] || !got["b"] {
		t.Fatalf("generated = %v, want a and b", got)
	}
}

func TestIsWhitespaceOnly(t *testing.T) {
	cases := []struct {
		plain, ignoringWS [2]int
		want              bool
	}{
		{[2]int{1, 0}, [2]int{0, 0}, true},
		{[2]int{0, 1}, [2]int{0, 0}, true},
		{[2]int{0, 0}, [2]int{0, 0}, false}, // nothing changed, as for a pure rename
		{[2]int{3, 0}, [2]int{1, 0}, false},
		{[2]int{0, 3}, [2]int{0, 1}, false},
	}
	for _, c := range cases {
		if got := isWhitespaceOnly(c.plain, c.ignoringWS); got != c.want {
			t.Errorf("isWhitespaceOnly(%v, %v) = %v, want %v", c.plain, c.ignoringWS, got, c.want)
		}
	}
}

// The attributes come from the head commit, not from the working tree, even for one file.
func TestMarkGeneratedReadsTheHeadsAttributes(t *testing.T) {
	s := noiseRepo(t)
	writeFile(t, s.Repo+"/.gitattributes", "")
	changes := []FileChange{{Path: "gen/api.txt"}}
	if err := markGenerated(s.Repo, s.Head, changes); err != nil {
		t.Fatal(err)
	}
	if !changes[0].Generated {
		t.Fatal("gen/api.txt is generated at head")
	}
}
