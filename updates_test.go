package main

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func TestIsNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"0.2.0", "0.1.0", true},
		{"v1.0.0", "0.9.9", true},
		{"0.1.1", "0.1.0", true},
		{"0.1.0", "0.1.0", false},
		{"0.0.9", "0.1.0", false},
		{"1.0", "0.9.9", true},
		{"0.1.0-beta", "0.1.0", false},
		{"", "0.1.0", false},
	}
	for _, c := range cases {
		if got := isNewer(c.latest, c.current); got != c.want {
			t.Errorf("isNewer(%q, %q) = %v, want %v", c.latest, c.current, got, c.want)
		}
	}
}

func TestCheckUpdate(t *testing.T) {
	newer := func() (ghRelease, error) {
		return ghRelease{TagName: "v0.2.0", HTMLURL: "https://github.com/x/y/releases/tag/v0.2.0"}, nil
	}
	info, err := checkUpdate("0.1.0", newer)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Available || info.Latest != "0.2.0" || info.URL == "" {
		t.Fatalf("expected an update: %+v", info)
	}

	same := func() (ghRelease, error) {
		return ghRelease{TagName: "v0.1.0"}, nil
	}
	if info, _ := checkUpdate("0.1.0", same); info.Available {
		t.Fatalf("same version must not prompt: %+v", info)
	}

	offline := func() (ghRelease, error) {
		return ghRelease{}, errors.New("no network")
	}
	info, err = checkUpdate("0.1.0", offline)
	if err == nil || info.Available {
		t.Fatalf("a failed check must return the error and no update: %+v, %v", info, err)
	}
}

// The bundle version in wails.json must match the version the app reports.
func TestAppVersionMatchesWailsJSON(t *testing.T) {
	data, err := os.ReadFile("wails.json")
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Info struct {
			ProductVersion string `json:"productVersion"`
		} `json:"info"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Info.ProductVersion != appVersion {
		t.Fatalf("wails.json productVersion %q, appVersion %q", cfg.Info.ProductVersion, appVersion)
	}
}
