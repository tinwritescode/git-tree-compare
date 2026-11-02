package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
)

// safeFilePath returns the absolute path of rel inside repo. It rejects paths that
// leave the repository, including through a symlink.
func safeFilePath(repo, rel string) (string, error) {
	if filepath.IsAbs(rel) {
		return "", fmt.Errorf("%s is not a repository path", rel)
	}
	root, err := filepath.EvalSymlinks(repo)
	if err != nil {
		return "", err
	}
	full := filepath.Join(root, filepath.Clean(rel))
	resolved, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", err
	}
	inside, err := filepath.Rel(root, resolved)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%s is outside the repository", rel)
	}
	return resolved, nil
}

// DiffAnchor is the anchor GitHub uses for one file on a pull request's Files tab: the SHA-256 of its path.
func DiffAnchor(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:])
}
