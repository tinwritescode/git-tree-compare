package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// updateZipPrefix starts the name of the macOS zip an in-place update installs.
const updateZipPrefix = "git-tree-compare"

// releaseAssetURLs finds the zip and its .sha256 file in a release. The update installs only
// when both are there; a release without them is offered as a download only.
func releaseAssetURLs(assets []ghAsset) (zipURL, sumURL, zipName string, ok bool) {
	byName := map[string]string{}
	for _, a := range assets {
		byName[a.Name] = a.URL
	}
	for _, a := range assets {
		if !strings.HasPrefix(a.Name, updateZipPrefix) || !strings.HasSuffix(a.Name, ".zip") {
			continue
		}
		if sum, found := byName[a.Name+".sha256"]; found {
			return a.URL, sum, a.Name, true
		}
	}
	return "", "", "", false
}

// downloadFile saves url to dst. GitHub redirects asset links, and the client follows them.
func downloadFile(url, dst string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("could not download the update: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("could not download the update: %s", resp.Status)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return fmt.Errorf("could not download the update: %w", err)
	}
	return f.Close()
}

// verifyChecksum checks that the file at path hashes to the first field of sumFile,
// the layout `shasum -a 256` writes.
func verifyChecksum(path, sumFile string) error {
	fields := strings.Fields(sumFile)
	if len(fields) == 0 {
		return fmt.Errorf("the release checksum is empty, so the update was not installed")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != strings.ToLower(fields[0]) {
		return fmt.Errorf("the download does not match its checksum, so the update was not installed")
	}
	return nil
}

// findApp returns the single .app bundle directly inside dir.
func findApp(dir string) (string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "*.app"))
	if err != nil {
		return "", err
	}
	if len(matches) != 1 {
		return "", fmt.Errorf("the update does not contain exactly one app")
	}
	return matches[0], nil
}

// bundleVersion reads the version an app bundle reports.
func bundleVersion(app string) (string, error) {
	out, err := exec.Command("/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString",
		filepath.Join(app, "Contents", "Info.plist")).Output()
	if err != nil {
		return "", fmt.Errorf("could not read the update's version: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// appBundlePath returns the .app bundle this process runs from. A plain dev binary has none,
// so it cannot replace itself.
func appBundlePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir := exe
	for {
		if strings.HasSuffix(dir, ".app") {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("the app is not running from an .app bundle, so it cannot update itself")
		}
		dir = parent
	}
}

// replaceBundle moves newApp into the place of appPath. The old bundle is kept until the
// swap succeeds, and put back if it fails.
func replaceBundle(newApp, appPath string) error {
	if _, err := os.Stat(newApp); err != nil {
		return err
	}
	previous := appPath + ".previous"
	if err := os.RemoveAll(previous); err != nil {
		return err
	}
	if err := os.Rename(appPath, previous); err != nil {
		return fmt.Errorf("could not move the current app aside: %w", err)
	}
	if err := os.Rename(newApp, appPath); err != nil {
		os.Rename(previous, appPath)
		return fmt.Errorf("could not put the new app in place: %w", err)
	}
	return os.RemoveAll(previous)
}

// installRelease downloads release, checks it against its checksum and version, and replaces
// the app at appPath with it. The staging folder sits beside the app so the final move stays on
// one volume.
func installRelease(release ghRelease, appPath string) error {
	latest := strings.TrimPrefix(release.TagName, "v")
	if !isNewer(latest, appVersion) {
		return fmt.Errorf("version %s is already the newest", appVersion)
	}
	zipURL, sumURL, name, ok := releaseAssetURLs(release.Assets)
	if !ok {
		return fmt.Errorf("version %s has no installable build, so download it from the release page", latest)
	}

	parent := filepath.Dir(appPath)
	stage, err := os.MkdirTemp(parent, ".update-")
	if err != nil {
		return fmt.Errorf("cannot write to %s, so the app cannot update itself: %w", parent, err)
	}
	defer os.RemoveAll(stage)

	zipPath := filepath.Join(stage, name)
	sumPath := zipPath + ".sha256"
	if err := downloadFile(zipURL, zipPath); err != nil {
		return err
	}
	if err := downloadFile(sumURL, sumPath); err != nil {
		return err
	}
	sum, err := os.ReadFile(sumPath)
	if err != nil {
		return err
	}
	if err := verifyChecksum(zipPath, string(sum)); err != nil {
		return err
	}

	unpacked := filepath.Join(stage, "unpacked")
	if err := os.Mkdir(unpacked, 0o755); err != nil {
		return err
	}
	if out, err := exec.Command("ditto", "-x", "-k", zipPath, unpacked).CombinedOutput(); err != nil {
		return fmt.Errorf("could not unpack the update: %s", strings.TrimSpace(string(out)))
	}
	newApp, err := findApp(unpacked)
	if err != nil {
		return err
	}
	got, err := bundleVersion(newApp)
	if err != nil {
		return err
	}
	if got != latest {
		return fmt.Errorf("the download is version %s, not %s, so the update was not installed", got, latest)
	}
	return replaceBundle(newApp, appPath)
}

// relaunchAfterQuit starts a helper that waits for this process to exit, then opens the app.
// Opening it while this process still runs would hand off to this instance (single-instance lock).
func relaunchAfterQuit(appPath string) error {
	script := `while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; open "$2"`
	return exec.Command("/bin/sh", "-c", script, "sh", strconv.Itoa(os.Getpid()), appPath).Start()
}
