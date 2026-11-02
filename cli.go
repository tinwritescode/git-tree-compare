package main

import "strings"

// parseLaunchArgs reads `git-tree-compare [path]`: the first argument that is not a flag.
// Unknown flags are ignored so a newer CLI can talk to an older app.
func parseLaunchArgs(args []string) string {
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			return arg
		}
	}
	return ""
}
