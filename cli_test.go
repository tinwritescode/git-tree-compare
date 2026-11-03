package main

import "testing"

func TestParseLaunchArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want Launch
	}{
		{"none", nil, Launch{}},
		{"path only", []string{"/repo"}, Launch{Path: "/repo"}},
		{"unknown flag ignored", []string{"--new-thing", "/repo"}, Launch{Path: "/repo"}},
		{"first path wins", []string{"/repo", "/other"}, Launch{Path: "/repo"}},
		{"commit", []string{"/repo", "--commit", "a1b2c3d"}, Launch{Path: "/repo", Commit: "a1b2c3d"}},
		{"branch and base", []string{"--branch=feat/x", "/repo", "--base", "staging"}, Launch{Path: "/repo", Branch: "feat/x", Base: "staging"}},
		{"flag without value", []string{"/repo", "--commit"}, Launch{Path: "/repo"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseLaunchArgs(tt.args); got != tt.want {
				t.Fatalf("parseLaunchArgs(%v) = %+v, want %+v", tt.args, got, tt.want)
			}
		})
	}
}

func TestParseNumstat(t *testing.T) {
	out := "3\t1\tfrontend/src/App.tsx\n" +
		"-\t-\tlogo.png\n" +
		"5\t0\tsrc/{old => new}/x.go\n" +
		"2\t2\told.txt => renamed.txt\n"

	got := parseNumstat(out)

	want := map[string][2]int{
		"frontend/src/App.tsx": {3, 1},
		"logo.png":             {0, 0},
		"src/new/x.go":         {5, 0},
		"renamed.txt":          {2, 2},
	}
	for path, counts := range want {
		if got[path] != counts {
			t.Errorf("numstat[%q] = %v, want %v", path, got[path], counts)
		}
	}
}
