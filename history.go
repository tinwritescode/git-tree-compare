package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const maxHistory = 50

// HistoryEntry is one past comparison. Entries are unique per repo and base.
type HistoryEntry struct {
	Repo     string    `json:"repo"`
	Base     string    `json:"base"`
	File     string    `json:"file"`
	OpenedAt time.Time `json:"openedAt"`
}

// historyPath is ~/Library/Application Support/git-tree-compare/history.json on macOS.
func historyPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "git-tree-compare", "history.json"), nil
}

// loadHistory reads the history file. A missing file is an empty history.
func loadHistory(path string) ([]HistoryEntry, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var entries []HistoryEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, err
	}
	return entries, nil
}

// recordHistory puts entry first, replacing any older entry with the same
// repo and base, and keeps only the newest maxHistory entries.
func recordHistory(entries []HistoryEntry, entry HistoryEntry) []HistoryEntry {
	result := []HistoryEntry{entry}
	for _, e := range entries {
		if e.Repo == entry.Repo && e.Base == entry.Base {
			continue
		}
		result = append(result, e)
	}
	if len(result) > maxHistory {
		result = result[:maxHistory]
	}
	return result
}

// saveHistory writes the history file, creating its folder if needed.
func saveHistory(path string, entries []HistoryEntry) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
