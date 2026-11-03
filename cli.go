package main

import "strings"

// Launch is what `git-tree-compare [path] [--commit REV | --branch NAME [--base NAME]]` asks for.
type Launch struct {
	Path   string
	Commit string
	Branch string
	Base   string
}

// parseLaunchArgs reads the command line: the first argument that is not a flag is the path.
// Unknown flags are ignored so a newer CLI can talk to an older app.
func parseLaunchArgs(args []string) Launch {
	var l Launch
	fields := map[string]*string{"--commit": &l.Commit, "--branch": &l.Branch, "--base": &l.Base}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		name, value, inline := strings.Cut(arg, "=")
		if field, ok := fields[name]; ok {
			if !inline && i+1 < len(args) {
				i++
				value = args[i]
			}
			*field = value
			continue
		}
		if !strings.HasPrefix(arg, "-") && l.Path == "" {
			l.Path = arg
		}
	}
	return l
}
