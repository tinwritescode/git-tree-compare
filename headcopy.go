package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// headCopyRequest names one file of a pull request at its head commit, and the temp dir its
// read-only copy goes under.
type headCopyRequest struct {
	Tmp    string
	Repo   string
	Number int
	Head   string
	Path   string // repository path of the file
}

// repoHash names a repository's folder under the temp dir, so two repositories never share copies.
func repoHash(repo string) string {
	sum := sha256.Sum256([]byte(repo))
	return hex.EncodeToString(sum[:6])
}

// headCopyPath is where the copy goes: <tmp>/git-tree-compare/<repo-hash>/pr-<n>/<head-short>/<path>.
// The path must stay inside that folder.
func headCopyPath(r headCopyRequest) (string, error) {
	if !commitID.MatchString(r.Head) {
		return "", fmt.Errorf("%q is not a commit id", r.Head)
	}
	if r.Number < 1 {
		return "", fmt.Errorf("%d is not a pull request number", r.Number)
	}
	if !filepath.IsLocal(r.Path) {
		return "", fmt.Errorf("%s is not a repository path", r.Path)
	}
	return filepath.Join(headCopyRoot(r), r.Path), nil
}

// headCopyRoot is the folder all copies of one pull request head go in.
func headCopyRoot(r headCopyRequest) string {
	return filepath.Join(r.Tmp, "git-tree-compare", repoHash(r.Repo), fmt.Sprintf("pr-%d", r.Number), r.Head[:12])
}

// writeHeadCopy writes the file as it is at the head commit, read-only, and returns its path.
// Writing it again replaces whatever is there, so a copy edited or half-written before is fixed.
func writeHeadCopy(r headCopyRequest) (string, error) {
	path, err := headCopyPath(r)
	if err != nil {
		return "", err
	}
	body, err := runGit(r.Repo, "show", r.Head+":"+filepath.ToSlash(r.Path))
	if err != nil {
		return "", fmt.Errorf("%s is not in the pull request's head commit: %w", r.Path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	// The folder must not lead out of the copy through a symlink.
	dir, err := safeFilePath(headCopyRoot(r), filepath.Dir(r.Path))
	if err != nil {
		return "", err
	}
	return replaceReadOnly(filepath.Join(dir, filepath.Base(path)), []byte(body))
}

// replaceReadOnly writes body to a temp file next to path and renames it over path, which
// replaces a file or a symlink there rather than writing through it.
func replaceReadOnly(path string, body []byte) (string, error) {
	f, err := os.CreateTemp(filepath.Dir(path), ".copy-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name()) // a no-op once renamed
	_, err = f.Write(body)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(f.Name(), 0o444)
	}
	if err == nil {
		err = os.Rename(f.Name(), path)
	}
	if err != nil {
		return "", err
	}
	return path, nil
}

// OpenAtHead opens a read-only copy of a pull request's file at its head commit in the editor,
// so what the editor shows matches the diff whatever branch is checked out.
func OpenAtHead(repo string, number int, head, rel, editorID string) error {
	app, err := editorApp(editorID)
	if err != nil {
		return err
	}
	path, err := writeHeadCopy(headCopyRequest{Tmp: os.TempDir(), Repo: repo, Number: number, Head: head, Path: rel})
	if err != nil {
		return err
	}
	return openWith(app, path)
}
