package engine

import (
	"errors"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
)

type fakeRunner struct {
	mu         sync.Mutex
	files      map[string]string
	execFn     func(cmd string) (string, error)
	commands   []string
	uploads    []string
	reconnects int
}

func newFakeRunner() *fakeRunner {
	return &fakeRunner{files: map[string]string{}}
}

func (f *fakeRunner) Exec(cmd string) (string, error) {
	f.mu.Lock()
	f.commands = append(f.commands, cmd)
	f.mu.Unlock()
	if out, ok := f.fsCommand(cmd); ok {
		return out, nil
	}
	if f.execFn != nil {
		return f.execFn(cmd)
	}
	return "", nil
}

func (f *fakeRunner) fsCommand(cmd string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case strings.Contains(cmd, "ls -1 "):
		dir := extractQuotedAfter(cmd, "ls -1 ")
		seen := map[string]bool{}
		for path := range f.files {
			if !strings.HasPrefix(path, dir+"/") {
				continue
			}
			rest := strings.TrimPrefix(path, dir+"/")
			name := strings.SplitN(rest, "/", 2)[0]
			seen[name] = true
		}
		names := make([]string, 0, len(seen))
		for name := range seen {
			names = append(names, name)
		}
		sort.Strings(names)
		return strings.Join(names, "\n"), true
	case strings.HasPrefix(cmd, "rm -rf "):
		path := extractQuotedAfter(cmd, "rm -rf ")
		for file := range f.files {
			if file == path || strings.HasPrefix(file, path+"/") {
				delete(f.files, file)
			}
		}
		return "", true
	}
	return "", false
}

func (f *fakeRunner) Upload(content, remotePath string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files[remotePath] = content
	f.uploads = append(f.uploads, remotePath)
	return nil
}

func (f *fakeRunner) ReadFile(remotePath string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.files[remotePath]
	if !ok {
		return "", os.ErrNotExist
	}
	return data, nil
}

func (f *fakeRunner) Reconnect() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reconnects++
	return nil
}

func (f *fakeRunner) commandContains(substr string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, cmd := range f.commands {
		if strings.Contains(cmd, substr) {
			return true
		}
	}
	return false
}

func (f *fakeRunner) file(remotePath string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.files[remotePath]
}

func (f *fakeRunner) setFile(remotePath, content string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files[remotePath] = content
}

func (f *fakeRunner) hasFile(remotePath string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.files[remotePath]
	return ok
}

var quotedPattern = regexp.MustCompile(`'([^']*)'`)

func extractQuotedAfter(cmd, prefix string) string {
	rest := strings.TrimPrefix(cmd, prefix)
	match := quotedPattern.FindStringSubmatch(rest)
	if len(match) > 1 {
		return match[1]
	}
	return strings.Fields(rest)[0]
}

var errFakeHealth = errors.New("fake health failure")
