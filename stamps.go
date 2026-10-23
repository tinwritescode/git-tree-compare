package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// fileStamp describes a file's current content cheaply: size and modification
// time. It changes whenever the file is saved, so a reviewed mark can reset.
func fileStamp(repo, path string) string {
	info, err := os.Stat(filepath.Join(repo, path))
	if err != nil {
		return "gone"
	}
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
}

// Stamps returns the current stamp of each path.
func Stamps(repo string, paths []string) map[string]string {
	stamps := make(map[string]string, len(paths))
	for _, p := range paths {
		stamps[p] = fileStamp(repo, p)
	}
	return stamps
}

// Fingerprint changes whenever the working-tree comparison could have changed:
// HEAD or base moved, or a changed file was saved. The frontend polls it.
func Fingerprint(repo, base string) (string, error) {
	head, err := runGit(repo, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	baseSha, err := runGit(repo, "rev-parse", base)
	if err != nil {
		return "", err
	}
	changes, err := ChangedFiles(Scope{Repo: repo, Base: base})
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString(strings.TrimSpace(head) + "\n" + strings.TrimSpace(baseSha) + "\n")
	for _, c := range changes {
		b.WriteString(c.Path + " " + c.Status + " " + fileStamp(repo, c.Path) + "\n")
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:]), nil
}
