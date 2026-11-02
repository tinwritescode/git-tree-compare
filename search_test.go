package main

import (
	"strconv"
	"strings"
	"testing"
)

// searchRepo makes a repository whose committed files differ from its working tree,
// so a test can tell that search reads the commit.
func searchRepo(t *testing.T) (repo, head string) {
	t.Helper()
	repo = t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		out, err := runGit(repo, append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(out)
	}
	git("init", "-q", "-b", "main")
	writeFile(t, repo+"/limit.go", "package api\n\nfunc Limit() {\n\tkey := clientKey(r)\n\tKEY := 1\n}\n")
	writeFile(t, repo+"/notes.md", "café key\nkeyboard\n")
	writeFile(t, repo+"/logo.bin", "key\x00key\n")
	git("add", ".")
	git("commit", "-q", "-m", "head")
	writeFile(t, repo+"/limit.go", "key only in the working tree\n")
	return repo, git("rev-parse", "HEAD")
}

func hitsOf(r SearchResult) []string {
	var out []string
	for _, h := range r.Hits {
		out = append(out, h.Path+":"+strconv.Itoa(h.Line)+":"+h.Text)
	}
	return out
}

func TestSearchReadsTheCommitIgnoringCaseByDefault(t *testing.T) {
	repo, head := searchRepo(t)
	got, err := SearchFiles(repo, head, []string{"limit.go"}, SearchQuery{Text: "key"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"limit.go:4:\tkey := clientKey(r)", "limit.go:5:\tKEY := 1"}
	if strings.Join(hitsOf(got), "|") != strings.Join(want, "|") {
		t.Fatalf("hits = %q, want %q", hitsOf(got), want)
	}
	// Both "key" and "Key" in clientKey match, as UTF-16 ranges for the frontend.
	if r := got.Hits[0].Ranges; len(r) != 2 || r[0] != [2]int{1, 4} || r[1] != [2]int{14, 17} {
		t.Fatalf("ranges = %v", r)
	}
}

func TestSearchOptions(t *testing.T) {
	repo, head := searchRepo(t)
	paths := []string{"limit.go", "notes.md"}
	cases := []struct {
		name string
		q    SearchQuery
		want []string
	}{
		{"case sensitive", SearchQuery{Text: "KEY", CaseSensitive: true}, []string{"limit.go:5:\tKEY := 1"}},
		{"whole word", SearchQuery{Text: "key", Word: true}, []string{"limit.go:4:\tkey := clientKey(r)", "limit.go:5:\tKEY := 1", "notes.md:1:café key"}},
		{"regex", SearchQuery{Text: `^key\w+`, Regex: true}, []string{"notes.md:2:keyboard"}},
		{"regex is literal when off", SearchQuery{Text: `^key\w+`}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := SearchFiles(repo, head, paths, c.q)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(hitsOf(got), "|") != strings.Join(c.want, "|") {
				t.Fatalf("hits = %q, want %q", hitsOf(got), c.want)
			}
		})
	}
}

func TestSearchCountsRangesInUTF16(t *testing.T) {
	repo, head := searchRepo(t)
	got, err := SearchFiles(repo, head, []string{"notes.md"}, SearchQuery{Text: "key", Word: true})
	if err != nil {
		t.Fatal(err)
	}
	// "café " is 5 UTF-16 units but 6 bytes.
	if r := got.Hits[0].Ranges; len(r) != 1 || r[0] != [2]int{5, 8} {
		t.Fatalf("ranges = %v", r)
	}
}

func TestSearchSkipsBinaryAndMissingFiles(t *testing.T) {
	repo, head := searchRepo(t)
	got, err := SearchFiles(repo, head, []string{"logo.bin", "deleted.go"}, SearchQuery{Text: "key"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Hits) != 0 {
		t.Fatalf("hits = %q, want none", hitsOf(got))
	}
}

func TestSearchStopsAtTheLimit(t *testing.T) {
	repo, head := searchRepo(t)
	got, err := searchFiles(repo, head, []string{"limit.go", "notes.md"}, SearchQuery{Text: "key"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Hits) != 2 || !got.Truncated {
		t.Fatalf("got %d hits, truncated %v; want 2, true", len(got.Hits), got.Truncated)
	}
}

func TestSearchRejectsABadRegex(t *testing.T) {
	repo, head := searchRepo(t)
	if _, err := SearchFiles(repo, head, []string{"limit.go"}, SearchQuery{Text: "(", Regex: true}); err == nil {
		t.Fatal("want an error for an unclosed group")
	}
}
