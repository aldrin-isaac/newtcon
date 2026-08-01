package hygiene_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestGofmtClean fails when any Go source in the repo is not gofmt-formatted.
//
// Added after formatting drift accumulated silently across 13 files — mostly
// Go 1.19's doc-comment rules, which change how `go doc` renders an indented
// block, so the drift was quietly degrading documentation rather than being
// merely cosmetic. Nothing caught it: no CI, no Makefile, no pre-commit hook.
// `go test ./...` is the one gate every change already passes through.
//
// Deliberately fails rather than auto-fixes: a test that rewrites the tree
// would make `go test` non-idempotent and could clobber work in progress.
func TestGofmtClean(t *testing.T) {
	gofmt, err := exec.LookPath("gofmt")
	if err != nil {
		// A missing local toolchain is not a defect in this codebase.
		t.Skip("gofmt not on PATH")
	}
	root := repoRoot(t)

	// Only the Go trees. Pointing gofmt at the repo root would walk
	// web/node_modules for nothing.
	args := []string{"-l"}
	for _, dir := range []string{"cmd", "internal"} {
		p := filepath.Join(root, dir)
		if _, err := os.Stat(p); err == nil {
			args = append(args, p)
		}
	}

	out, err := exec.Command(gofmt, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("running gofmt: %v\n%s", err, out)
	}
	listed := strings.TrimSpace(string(out))
	if listed == "" {
		return
	}

	files := strings.Split(listed, "\n")
	for i, f := range files {
		if rel, err := filepath.Rel(root, strings.TrimSpace(f)); err == nil {
			files[i] = rel
		}
	}
	t.Errorf("%d file(s) are not gofmt-formatted:\n  %s\n\nFix with:\n  gofmt -w %s",
		len(files), strings.Join(files, "\n  "), strings.Join([]string{"./cmd", "./internal"}, " "))
}

// repoRoot walks up from the test's working directory to the directory holding
// go.mod, so the gate works regardless of where `go test` is invoked from.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("no go.mod found above %s", dir)
		}
		dir = parent
	}
}
