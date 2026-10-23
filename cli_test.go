package main

import "testing"

func TestParseLaunchArgs(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		wantPath string
		wantBase string
	}{
		{"none", nil, "", ""},
		{"path only", []string{"/repo"}, "/repo", ""},
		{"base flag", []string{"/repo", "--base", "staging"}, "/repo", "staging"},
		{"base equals", []string{"--base=main", "/repo"}, "/repo", "main"},
		{"unknown flag ignored", []string{"--new-thing", "/repo"}, "/repo", ""},
		{"dangling base", []string{"/repo", "--base"}, "/repo", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, base := parseLaunchArgs(tt.args)
			if path != tt.wantPath || base != tt.wantBase {
				t.Fatalf("parseLaunchArgs(%v) = %q, %q; want %q, %q", tt.args, path, base, tt.wantPath, tt.wantBase)
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
