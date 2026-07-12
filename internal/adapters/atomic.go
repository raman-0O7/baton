package adapters

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// AtomicWrite writes data to path via temp-file+rename. If path already
// exists, the previous content is first copied to a timestamped backup in
// the same directory (NFR-4). Parent directories are created 0700.
func AtomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if prev, err := os.ReadFile(path); err == nil {
		backup := fmt.Sprintf("%s.bak-%s", path, time.Now().UTC().Format("20060102T150405Z"))
		if err := os.WriteFile(backup, prev, 0o600); err != nil {
			return fmt.Errorf("backup before overwrite: %w", err)
		}
	}
	tmp, err := os.CreateTemp(dir, ".baton-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after successful rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
