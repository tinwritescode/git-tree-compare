package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// appVersion is the version this build reports. Keep it equal to info.productVersion in wails.json,
// which sets the bundle version on macOS.
const appVersion = "0.1.0"

// updateRepo is the GitHub repository whose latest release is the newest build.
const updateRepo = "tinwritescode/git-tree-compare"

// UpdateInfo says whether a newer release exists and where to download it.
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	URL       string `json:"url"`
	Available bool   `json:"available"`
}

// ghRelease is the part of a GitHub release the update check reads.
type ghRelease struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
}

// CheckUpdate asks GitHub for the latest release and compares it with this build.
// It reads only. The repository is private, so it needs gh logged in.
func CheckUpdate() (UpdateInfo, error) {
	return checkUpdate(appVersion, fetchLatestRelease)
}

// checkUpdate is CheckUpdate with the release lookup passed in, so it can be tested offline.
func checkUpdate(current string, fetch func() (ghRelease, error)) (UpdateInfo, error) {
	info := UpdateInfo{Current: current}
	release, err := fetch()
	if err != nil {
		return info, err
	}
	info.Latest = strings.TrimPrefix(release.TagName, "v")
	info.URL = release.HTMLURL
	info.Available = isNewer(info.Latest, current)
	return info, nil
}

// fetchLatestRelease reads the latest published release. GitHub skips drafts and prereleases here.
func fetchLatestRelease() (ghRelease, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "gh", "api", "repos/"+updateRepo+"/releases/latest").Output()
	if err != nil {
		return ghRelease{}, fmt.Errorf("could not check for updates: %w", err)
	}
	var release ghRelease
	if err := json.Unmarshal(out, &release); err != nil {
		return ghRelease{}, err
	}
	return release, nil
}

// isNewer reports whether version latest is greater than current. Versions are MAJOR.MINOR.PATCH;
// anything else is never newer, so an odd tag cannot trigger a prompt.
func isNewer(latest, current string) bool {
	a, okA := parseVersion(latest)
	b, okB := parseVersion(current)
	if !okA || !okB {
		return false
	}
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

// parseVersion reads "v1.2.3", "1.2" or "1" into its three numbers.
func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if len(parts) > 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
