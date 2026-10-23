package main

import "strings"

// parseLaunchArgs reads `git-tree-compare [path] [--base REF]`, also `--base=REF`.
// The first argument that is not a flag is the repository path.
func parseLaunchArgs(args []string) (path, base string) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--base" && i+1 < len(args):
			base = args[i+1]
			i++
		case strings.HasPrefix(arg, "--base="):
			base = strings.TrimPrefix(arg, "--base=")
		case strings.HasPrefix(arg, "-"):
			// Unknown flags are ignored so a newer CLI can talk to an older app.
		case path == "":
			path = arg
		}
	}
	return path, base
}
