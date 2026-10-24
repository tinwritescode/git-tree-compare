package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// maxEditSize caps the files the editor opens. Larger files are too slow to edit in the page.
const maxEditSize = 2 << 20

// ListFiles returns every file in the repository that git tracks or would track:
// tracked files plus untracked ones, minus anything ignored.
func ListFiles(repo string) ([]string, error) {
	out, err := runGit(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, p := range strings.Split(out, "\x00") {
		if p != "" {
			paths = append(paths, p)
		}
	}
	return paths, nil
}

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

// ReadFile returns the text of a repository file for the editor.
// It refuses binary files and files over maxEditSize.
func ReadFile(repo, rel string) (string, error) {
	full, err := safeFilePath(repo, rel)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(full)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file", rel)
	}
	if info.Size() > maxEditSize {
		return "", fmt.Errorf("%s is larger than 2 MB and cannot be edited here", rel)
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return "", fmt.Errorf("%s looks like a binary file", rel)
	}
	return string(data), nil
}

// WriteFile replaces the text of an existing repository file. It keeps the file's permissions.
func WriteFile(repo, rel, content string) error {
	full, err := safeFilePath(repo, rel)
	if err != nil {
		return err
	}
	info, err := os.Stat(full)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", rel)
	}
	return os.WriteFile(full, []byte(content), info.Mode().Perm())
}

// DiffAnchor is the anchor GitHub uses for one file on a pull request's Files tab: the SHA-256 of its path.
func DiffAnchor(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:])
}
