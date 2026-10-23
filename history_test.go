package main

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestRecordHistoryDedupesByRepoAndBase(t *testing.T) {
	old := HistoryEntry{Repo: "/r", Base: "main", File: "a.go", OpenedAt: time.Unix(1, 0)}
	other := HistoryEntry{Repo: "/r", Base: "staging", File: "b.go", OpenedAt: time.Unix(2, 0)}
	newer := HistoryEntry{Repo: "/r", Base: "main", File: "c.go", OpenedAt: time.Unix(3, 0)}

	got := recordHistory([]HistoryEntry{old, other}, newer)

	want := []HistoryEntry{newer, other}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("recordHistory() = %+v, want %+v", got, want)
	}
}

func TestRecordHistoryCapsLength(t *testing.T) {
	var entries []HistoryEntry
	for i := 0; i < maxHistory; i++ {
		entries = append(entries, HistoryEntry{Repo: "/r", Base: string(rune('a'+i%26)) + string(rune('0'+i/26))})
	}
	got := recordHistory(entries, HistoryEntry{Repo: "/new", Base: "main"})
	if len(got) != maxHistory {
		t.Fatalf("len = %d, want %d", len(got), maxHistory)
	}
	if got[0].Repo != "/new" {
		t.Fatalf("newest entry not first: %+v", got[0])
	}
}

func TestSaveAndLoadHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "history.json")
	want := []HistoryEntry{{Repo: "/r", Base: "main", File: "a.go", OpenedAt: time.Unix(10, 0).UTC()}}

	if err := saveHistory(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := loadHistory(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("loadHistory() = %+v, want %+v", got, want)
	}
}

func TestLoadHistoryMissingFile(t *testing.T) {
	got, err := loadHistory(filepath.Join(t.TempDir(), "none.json"))
	if err != nil || got != nil {
		t.Fatalf("loadHistory(missing) = %+v, %v; want nil, nil", got, err)
	}
}
