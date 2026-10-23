package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseAssetURLs(t *testing.T) {
	zip := ghAsset{Name: "git-tree-compare-macos.zip", URL: "https://x/zip"}
	sum := ghAsset{Name: "git-tree-compare-macos.zip.sha256", URL: "https://x/sum"}

	if _, _, _, ok := releaseAssetURLs([]ghAsset{zip}); ok {
		t.Error("a zip without a checksum must not be installable")
	}
	gotZip, gotSum, name, ok := releaseAssetURLs([]ghAsset{sum, zip})
	if !ok || gotZip != zip.URL || gotSum != sum.URL || name != zip.Name {
		t.Errorf("got %q %q %q %v", gotZip, gotSum, name, ok)
	}
}

func TestVerifyChecksum(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file.zip")
	if err := os.WriteFile(path, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("payload"))
	good := hex.EncodeToString(sum[:]) + "  file.zip\n"

	if err := verifyChecksum(path, good); err != nil {
		t.Errorf("matching checksum rejected: %v", err)
	}
	if err := verifyChecksum(path, strings.Repeat("0", 64)+"  file.zip"); err == nil {
		t.Error("wrong checksum accepted")
	}
	if err := verifyChecksum(path, "  "); err == nil {
		t.Error("empty checksum file accepted")
	}
}

func TestReplaceBundle(t *testing.T) {
	dir := t.TempDir()
	appPath := filepath.Join(dir, "git-tree-compare.app")
	newApp := filepath.Join(dir, "stage", "git-tree-compare.app")
	writeFile(t, filepath.Join(appPath, "old.txt"), "old")
	writeFile(t, filepath.Join(newApp, "new.txt"), "new")

	if err := replaceBundle(newApp, appPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(appPath, "new.txt")); err != nil {
		t.Errorf("new app not in place: %v", err)
	}
	if _, err := os.Stat(filepath.Join(appPath, "old.txt")); err == nil {
		t.Error("old app still in place")
	}

	// A missing new bundle must leave the current app untouched.
	if err := replaceBundle(filepath.Join(dir, "missing.app"), appPath); err == nil {
		t.Error("expected an error for a missing new bundle")
	}
	if _, err := os.Stat(filepath.Join(appPath, "new.txt")); err != nil {
		t.Errorf("current app changed after failed swap: %v", err)
	}
}

// TestInstallRelease runs the whole install against a local server that serves a real zip made
// with ditto, the same tool the release uses.
func TestInstallRelease(t *testing.T) {
	if _, err := exec.LookPath("ditto"); err != nil {
		t.Skip("ditto is macOS only")
	}
	dir := t.TempDir()
	build := filepath.Join(dir, "build")
	newApp := filepath.Join(build, "git-tree-compare.app")
	writeFile(t, filepath.Join(newApp, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>0.9.0</string>
</dict></plist>`)
	writeFile(t, filepath.Join(newApp, "marker.txt"), "new build")
	zipPath := filepath.Join(dir, "git-tree-compare-macos.zip")
	if out, err := exec.Command("ditto", "-c", "-k", "--keepParent", newApp, zipPath).CombinedOutput(); err != nil {
		t.Fatalf("ditto: %v\n%s", err, out)
	}
	zipData, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(zipData)
	sumLine := hex.EncodeToString(sum[:]) + "  git-tree-compare-macos.zip\n"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/git-tree-compare-macos.zip":
			w.Write(zipData)
		case "/git-tree-compare-macos.zip.sha256":
			w.Write([]byte(sumLine))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	release := ghRelease{TagName: "v0.9.0", Assets: []ghAsset{
		{Name: "git-tree-compare-macos.zip", URL: server.URL + "/git-tree-compare-macos.zip"},
		{Name: "git-tree-compare-macos.zip.sha256", URL: server.URL + "/git-tree-compare-macos.zip.sha256"},
	}}

	appPath := filepath.Join(dir, "installed", "git-tree-compare.app")
	writeFile(t, filepath.Join(appPath, "old.txt"), "old build")
	if err := installRelease(release, appPath); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(appPath, "marker.txt")); string(got) != "new build" {
		t.Errorf("installed app marker = %q", got)
	}
	entries, _ := os.ReadDir(filepath.Dir(appPath))
	if len(entries) != 1 {
		t.Errorf("leftover files next to the app: %v", entries)
	}

	// A release that is not newer must be refused before anything is downloaded.
	same := release
	same.TagName = "v" + appVersion
	if err := installRelease(same, appPath); err == nil {
		t.Error("same version was installed")
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
