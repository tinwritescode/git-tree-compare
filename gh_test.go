package main

import (
	"strings"
	"testing"
)

func TestParsePRInfo(t *testing.T) {
	out := []byte(`{"number":42,"title":"Fix login","url":"https://github.com/o/r/pull/42",` +
		`"baseRefName":"staging","headRefOid":"abc123","mergeable":"CONFLICTING","state":"OPEN"}`)

	pr, err := parsePRInfo(out)
	if err != nil {
		t.Fatal(err)
	}
	if pr.Number != 42 || pr.BaseRef != "staging" || pr.Mergeable != "CONFLICTING" || pr.HeadOID != "abc123" {
		t.Fatalf("parsePRInfo() = %+v", pr)
	}
}

func TestParseCommits(t *testing.T) {
	out := "abc1234567\x1fabc1234\x1fFix login\x1fTin\x1f2026-10-20T10:00:00+07:00\n" +
		"bad line\n"

	commits := parseCommits(out)
	if len(commits) != 1 || commits[0].Short != "abc1234" || commits[0].Subject != "Fix login" {
		t.Fatalf("parseCommits() = %+v", commits)
	}
}

func TestResolvePRBase(t *testing.T) {
	repo := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		out, err := runGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(out)
	}
	git("init", "-q", "-b", "main")
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "a")
	git("branch", "staging")
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "b")
	tip := git("rev-parse", "HEAD")
	missing := strings.Repeat("0", 40)

	if got := resolvePRBase(repo, nil); got != (PRBase{}) {
		t.Fatalf("no PR: got %+v", got)
	}
	// The PR merges into the commit it was opened against: use it when it is here.
	if got := resolvePRBase(repo, &PRInfo{BaseRef: "main", BaseOID: tip}); got != (PRBase{Name: "main", Commit: tip, Fetched: true}) {
		t.Fatalf("base commit present: got %+v", got)
	}
	// Not fetched: fall back to the branch of that name, and say so.
	if got := resolvePRBase(repo, &PRInfo{BaseRef: "staging", BaseOID: missing}); got != (PRBase{Name: "staging", Commit: "staging"}) {
		t.Fatalf("base commit missing: got %+v", got)
	}
}

func TestMergeBaseMissingCommitExplains(t *testing.T) {
	repo := t.TempDir()
	if _, err := runGit(repo, "init", "-q", "-b", "main"); err != nil {
		t.Fatal(err)
	}
	_, err := MergeBase(repo, "349f5780ab038508f610f344bb30efd33336bb35")
	if err == nil || !strings.Contains(err.Error(), "349f578 is not in this repository") {
		t.Fatalf("MergeBase() error = %v, want a plain explanation", err)
	}
}
