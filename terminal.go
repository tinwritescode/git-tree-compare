package main

import (
	"encoding/base64"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Event names for the embedded terminal.
const (
	eventTermData = "term:data" // base64 of the bytes the shell wrote
	eventTermExit = "term:exit"
)

// termSession is the one shell the terminal panel talks to.
type termSession struct {
	cmd  *exec.Cmd
	ptmx *os.File
}

var (
	termMu  sync.Mutex
	current *termSession
)

// StartTerminal starts a login shell in repo, replacing any shell already running.
// Output arrives as term:data events; the shell's exit arrives as term:exit.
func (a *App) StartTerminal(repo string, cols, rows int) error {
	StopTerminal()

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	// A login shell loads the user's PATH, which a Finder-launched app does not have.
	cmd := exec.Command(shell, "-l")
	cmd.Dir = repo
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return err
	}
	session := &termSession{cmd: cmd, ptmx: ptmx}

	termMu.Lock()
	current = session
	termMu.Unlock()

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 && a.ctx != nil {
				runtime.EventsEmit(a.ctx, eventTermData, base64.StdEncoding.EncodeToString(buf[:n]))
			}
			if err != nil {
				break
			}
		}
		_ = cmd.Wait()
		termMu.Lock()
		if current == session {
			current = nil
		}
		termMu.Unlock()
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, eventTermExit)
		}
	}()
	return nil
}

// WriteTerminal sends keystrokes to the running shell.
func (a *App) WriteTerminal(data string) error {
	s := currentSession()
	if s == nil {
		return errors.New("the terminal is not running")
	}
	_, err := io.WriteString(s.ptmx, data)
	return err
}

// ResizeTerminal tells the shell the panel's size in character cells.
func (a *App) ResizeTerminal(cols, rows int) error {
	s := currentSession()
	if s == nil {
		return nil
	}
	return pty.Setsize(s.ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// StopTerminal ends the running shell, if any.
func StopTerminal() {
	termMu.Lock()
	s := current
	current = nil
	termMu.Unlock()
	if s == nil {
		return
	}
	_ = s.ptmx.Close()
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
}

func currentSession() *termSession {
	termMu.Lock()
	defer termMu.Unlock()
	return current
}
