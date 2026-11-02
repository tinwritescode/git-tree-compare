package main

// Scope says what is being reviewed: the diff from Base to Head, both full commit ids.
type Scope struct {
	Repo     string `json:"repo"`
	Base     string `json:"base"`
	Head     string `json:"head"`
	IgnoreWS bool   `json:"ignoreWS"`
	FullFile bool   `json:"fullFile,omitempty"` // show the whole file as context, not just the changed hunks
}

// fullFileContext asks git for more context lines than any file has, so each diff holds the whole file.
const fullFileContext = "-U1000000"

// scopeDiff runs a diff within scope and returns its output. flags are extra options
// such as --name-status. path limits the output to one file when set.
func scopeDiff(s Scope, flags []string, path string) (string, error) {
	args := append([]string{"diff", "-M"}, flags...)
	if s.IgnoreWS {
		args = append(args, "-w")
	}
	if s.FullFile {
		args = append(args, fullFileContext)
	}
	args = append(args, s.Base, s.Head)
	if path != "" {
		args = append(args, "--", path)
	}
	return runGit(s.Repo, args...)
}
