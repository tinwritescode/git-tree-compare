package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIScriptForPointsAtBundle(t *testing.T) {
	got := cliScriptFor("/Users/me/Apps/git-tree-compare.app")
	if !strings.Contains(got, `APP="${GTC_APP:-/Users/me/Apps/git-tree-compare.app}"`) {
		t.Fatalf("script does not point at the bundle:\n%s", got)
	}
	if !strings.HasPrefix(got, "#!/bin/sh") {
		t.Fatalf("script lost its shebang:\n%s", got)
	}
}

func TestCLIDirsKeepsOnlyDirsOnPath(t *testing.T) {
	got := cliDirs("/Users/me", []string{"/usr/bin", "/usr/local/bin", "/Users/me/.local/bin"})
	want := []string{"/Users/me/.local/bin", "/usr/local/bin"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("cliDirs = %v, want %v", got, want)
	}
}

func TestInstallCLIWritesExecutableScript(t *testing.T) {
	dir := t.TempDir()
	got, err := installCLI([]string{dir}, "/Applications/git-tree-compare.app")
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join(dir, cliName) {
		t.Fatalf("installed at %q", got)
	}
	info, err := os.Stat(got)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("command is not executable: %v", info.Mode())
	}
}

func TestInstallCLIReplacesOldVersion(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, cliName)
	writeFile(t, target, "#!/bin/sh\n"+cliMarker+" (old)\n")

	if _, err := installCLI([]string{dir}, "/Applications/git-tree-compare.app"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, target); got != cliScriptFor("/Applications/git-tree-compare.app") {
		t.Fatalf("old command not replaced:\n%s", got)
	}
}

func TestInstallCLIKeepsSomeoneElsesFile(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	foreign := filepath.Join(first, cliName)
	writeFile(t, foreign, "#!/bin/sh\necho mine\n")

	got, err := installCLI([]string{first, second}, "/Applications/git-tree-compare.app")
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join(second, cliName) {
		t.Fatalf("installed at %q, want the second folder", got)
	}
	if readFile(t, foreign) != "#!/bin/sh\necho mine\n" {
		t.Fatal("overwrote a file the app did not write")
	}
}

func TestInstallCLIFailsWithNoFolder(t *testing.T) {
	if _, err := installCLI(nil, "/Applications/git-tree-compare.app"); err == nil {
		t.Fatal("want an error when no folder is on PATH")
	}
}

func TestRefreshCLIUpdatesOnlyThisBundlesCommand(t *testing.T) {
	dir := t.TempDir()
	ours := filepath.Join(dir, cliName)
	stale := "#!/bin/sh\n" + cliMarker + "\nAPP=\"${GTC_APP:-/Applications/git-tree-compare.app}\"\n"
	writeFile(t, ours, stale)

	refreshCLI([]string{dir}, "/Users/me/build/git-tree-compare.app")
	if readFile(t, ours) != stale {
		t.Fatal("a different bundle took over the command")
	}

	refreshCLI([]string{dir}, "/Applications/git-tree-compare.app")
	if readFile(t, ours) != cliScriptFor("/Applications/git-tree-compare.app") {
		t.Fatal("stale command not refreshed")
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
