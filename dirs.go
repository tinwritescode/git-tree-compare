package main

import (
	"os"
	"path/filepath"
	"strings"
)

// DirEntry is one visible subfolder in the in-app repository picker.
// IsRepo marks a folder that holds a .git entry (a directory or a worktree file).
type DirEntry struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	IsRepo bool   `json:"isRepo"`
}

// DirListing is one folder as shown by the in-app repository picker.
// Parent is "" at the filesystem root.
type DirListing struct {
	Path    string     `json:"path"`
	Parent  string     `json:"parent"`
	IsRepo  bool       `json:"isRepo"`
	Entries []DirEntry `json:"entries"`
}

// ListDir returns the visible subfolders of path, sorted by name.
// Hidden folders are skipped. Entries that are repositories are marked.
func ListDir(path string) (DirListing, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return DirListing{}, err
	}
	items, err := os.ReadDir(abs)
	if err != nil {
		return DirListing{}, err
	}

	out := DirListing{Path: abs, IsRepo: isRepoDir(abs)}
	if parent := filepath.Dir(abs); parent != abs {
		out.Parent = parent
	}
	for _, item := range items {
		if !item.IsDir() || strings.HasPrefix(item.Name(), ".") {
			continue
		}
		child := filepath.Join(abs, item.Name())
		out.Entries = append(out.Entries, DirEntry{Name: item.Name(), Path: child, IsRepo: isRepoDir(child)})
	}
	return out, nil
}

// isRepoDir reports whether dir holds a .git entry. A worktree or submodule has a .git file.
func isRepoDir(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}
