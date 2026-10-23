package main

import "testing"

func TestParsePRComments(t *testing.T) {
	out := []byte(`{"data":{"node":{
		"reviewThreads":{"totalCount":2,"nodes":[
			{"isResolved":false,"isOutdated":false,"path":"app.go","line":12,"originalLine":12,
			 "comments":{"nodes":[{"author":{"login":"ana"},"body":"rename this","url":"https://x/1","createdAt":"2026-10-01T00:00:00Z"}]}},
			{"isResolved":true,"isOutdated":true,"path":"git.go","line":null,"originalLine":7,
			 "comments":{"nodes":[{"author":null,"body":"old","url":"https://x/2","createdAt":"2026-10-02T00:00:00Z"}]}}
		]},
		"comments":{"totalCount":1,"nodes":[{"author":{"login":"bo"},"body":"lgtm","url":"https://x/3","createdAt":"2026-10-03T00:00:00Z"}]}
	}}}`)
	d, err := parsePRComments(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Threads) != 2 || d.Threads[0].Path != "app.go" || d.Threads[0].Line != 12 || d.Threads[0].URL != "https://x/1" {
		t.Fatalf("threads: %+v", d.Threads)
	}
	if !d.Threads[1].Resolved || !d.Threads[1].Outdated || d.Threads[1].Line != 7 {
		t.Fatalf("outdated thread should fall back to originalLine: %+v", d.Threads[1])
	}
	if d.Threads[1].Comments[0].Author != "ghost" {
		t.Fatalf("null author should read as ghost: %+v", d.Threads[1].Comments[0])
	}
	if len(d.Comments) != 1 || d.Comments[0].Author != "bo" || d.Truncated {
		t.Fatalf("comments: %+v truncated=%v", d.Comments, d.Truncated)
	}
}

func TestParsePRCommentsEmptyAndTruncated(t *testing.T) {
	out := []byte(`{"data":{"node":{"reviewThreads":{"totalCount":101,"nodes":[]},"comments":{"totalCount":0,"nodes":[]}}}}`)
	d, err := parsePRComments(out)
	if err != nil {
		t.Fatal(err)
	}
	if d.Threads == nil || d.Comments == nil {
		t.Fatal("empty lists must not be nil, they serialize to null")
	}
	if !d.Truncated {
		t.Fatal("more threads on GitHub than fetched should set truncated")
	}
}
