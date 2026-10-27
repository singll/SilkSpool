package engine

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ErrHostLocked 表示同 host 已有部署在进行。
var ErrHostLocked = errors.New("another deploy is in progress for this host")

// HostLockPath 返回 per-host 部署锁路径。
func HostLockPath(baseDir, host string) string {
	return filepath.Join(baseDir, ".spool", "locks", host+".lock")
}

// AcquireHostLock 获取 per-host 文件锁；timeout>0 时轮询等待，否则立即失败。
// 返回的函数释放锁，失败/中断时文件描述符关闭也会自动释放。
func AcquireHostLock(baseDir, host string, timeout time.Duration) (func(), error) {
	path := HostLockPath(baseDir, host)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, err
	}

	deadline := time.Now().Add(timeout)
	for {
		err = tryLockFile(f)
		if err == nil {
			break
		}
		if !errors.Is(err, errLockBusy) {
			_ = f.Close()
			return nil, fmt.Errorf("acquire host lock %s: %w", path, err)
		}
		if timeout <= 0 || time.Now().After(deadline) {
			_ = f.Close()
			return nil, fmt.Errorf("%w: %s", ErrHostLocked, host)
		}
		time.Sleep(50 * time.Millisecond)
	}

	_ = f.Truncate(0)
	_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
	_ = f.Sync()

	release := func() {
		_ = unlockFile(f)
		_ = f.Close()
	}
	return release, nil
}
