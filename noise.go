package main

import (
	"strings"
)

// isWhitespaceOnly reports whether a file has changed lines that all vanish with -w.
// plain and ignoringWS are its added and deleted counts from numstat without and with -w;
// numstat with -w leaves a modified file out, or shows a renamed one as 0 0, which both read as zero.
func isWhitespaceOnly(plain, ignoringWS [2]int) bool {
	return plain[0]+plain[1] > 0 && ignoringWS[0]+ignoringWS[1] == 0
}

// markGenerated sets Generated on the changes that .gitattributes marks linguist-generated at head.
// Git before 2.40 cannot read attributes from a commit, so it falls back to the working tree's.
func markGenerated(repo, head string, changes []FileChange) error {
	if len(changes) == 0 {
		return nil
	}
	var paths strings.Builder
	for _, c := range changes {
		paths.WriteString(c.Path + "\x00")
	}
	out, err := runGitInput(repo, paths.String(), "check-attr", "--source", head, "-z", "--stdin", "linguist-generated")
	if err != nil {
		out, err = runGitInput(repo, paths.String(), "check-attr", "-z", "--stdin", "linguist-generated")
	}
	if err != nil {
		return err
	}
	generated := parseGenerated(out)
	for i := range changes {
		changes[i].Generated = generated[changes[i].Path]
	}
	return nil
}

// parseGenerated reads `git check-attr -z` output, "path\0attr\0value\0" repeated, into the
// paths whose linguist-generated attribute is set or true.
func parseGenerated(out string) map[string]bool {
	fields := strings.Split(out, "\x00")
	generated := map[string]bool{}
	for i := 0; i+2 < len(fields); i += 3 {
		if v := fields[i+2]; v == "set" || v == "true" {
			generated[fields[i]] = true
		}
	}
	return generated
}
