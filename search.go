package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// SearchQuery is what the reviewer typed in the search dialog, with its toggles.
type SearchQuery struct {
	Text          string `json:"text"`
	CaseSensitive bool   `json:"caseSensitive"`
	Word          bool   `json:"word"`
	Regex         bool   `json:"regex"`
}

// SearchHit is one matching line. Ranges are [start, end) in UTF-16 units,
// the way the frontend's strings count, so it can mark the matches.
type SearchHit struct {
	Path   string   `json:"path"`
	Line   int      `json:"line"`
	Text   string   `json:"text"`
	Ranges [][2]int `json:"ranges"`
}

// SearchResult is the hits in file order. Truncated is set when there were more than the limit.
type SearchResult struct {
	Hits      []SearchHit `json:"hits"`
	Truncated bool        `json:"truncated"`
}

// searchLimit caps the hits returned, so a common word cannot flood the dialog.
const searchLimit = 500

// SearchFiles searches the given files as they are at commit head, never the working tree.
// Binary files and paths that do not exist at head are skipped.
func SearchFiles(repo, head string, paths []string, q SearchQuery) (SearchResult, error) {
	return searchFiles(repo, head, paths, q, searchLimit)
}

func searchFiles(repo, head string, paths []string, q SearchQuery, limit int) (SearchResult, error) {
	re, err := compileQuery(q)
	if err != nil {
		return SearchResult{}, err
	}
	result := SearchResult{Hits: []SearchHit{}}
	err = readBlobs(repo, head, paths, func(path string, content []byte) bool {
		for i, line := range strings.Split(string(content), "\n") {
			locs := re.FindAllStringIndex(line, -1)
			if len(locs) == 0 {
				continue
			}
			if len(result.Hits) == limit {
				result.Truncated = true
				return false
			}
			result.Hits = append(result.Hits, SearchHit{Path: path, Line: i + 1, Text: line, Ranges: utf16Ranges(line, locs)})
		}
		return true
	})
	return result, err
}

// compileQuery turns the query and its toggles into one regular expression.
func compileQuery(q SearchQuery) (*regexp.Regexp, error) {
	pattern := q.Text
	if !q.Regex {
		pattern = regexp.QuoteMeta(pattern)
	}
	if q.Word {
		pattern = `\b(?:` + pattern + `)\b`
	}
	if !q.CaseSensitive {
		pattern = `(?i)` + pattern
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("not a valid regular expression: %s", strings.TrimPrefix(err.Error(), "error parsing regexp: "))
	}
	return re, nil
}

// utf16Ranges converts byte offsets within line to UTF-16 offsets.
func utf16Ranges(line string, locs [][]int) [][2]int {
	units := func(byteOffset int) int { return len(utf16.Encode([]rune(line[:byteOffset]))) }
	out := make([][2]int, len(locs))
	for i, loc := range locs {
		out[i] = [2]int{units(loc[0]), units(loc[1])}
	}
	return out
}

// readBlobs streams each path's content at head through one `git cat-file --batch`.
// visit returns false to stop early. Missing paths and binary files are not visited.
func readBlobs(repo, head string, paths []string, visit func(path string, content []byte) bool) error {
	cmd := exec.Command("git", "-C", repo, "cat-file", "--batch")
	var input strings.Builder
	for _, p := range paths {
		input.WriteString(head + ":" + p + "\n")
	}
	cmd.Stdin = strings.NewReader(input.String())
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	out := bufio.NewReader(stdout)
	for _, path := range paths {
		header, err := out.ReadString('\n')
		if err != nil {
			return fmt.Errorf("reading %s at %.8s: %w", path, head, err)
		}
		fields := strings.Fields(header)
		if len(fields) != 3 { // "<object> missing"
			continue
		}
		size, err := strconv.Atoi(fields[2])
		if err != nil {
			return fmt.Errorf("reading %s at %.8s: bad header %q", path, head, header)
		}
		content := make([]byte, size+1) // the object, then a newline
		if _, err := io.ReadFull(out, content); err != nil {
			return fmt.Errorf("reading %s at %.8s: %w", path, head, err)
		}
		content = content[:size]
		if fields[1] != "blob" || bytes.IndexByte(content[:min(size, 8000)], 0) >= 0 {
			continue
		}
		if !visit(path, bytes.TrimSuffix(content, []byte("\n"))) {
			return nil
		}
	}
	return nil
}
