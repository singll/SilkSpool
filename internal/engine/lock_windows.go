//go:build windows

package engine

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

var errLockBusy = errors.New("lock is busy")

func tryLockFile(f *os.File) error {
	var overlapped windows.Overlapped
	err := windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &overlapped)
	if err != nil {
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, syscall.ERROR_IO_PENDING) {
			return errLockBusy
		}
		return err
	}
	return nil
}

func unlockFile(f *os.File) error {
	var overlapped windows.Overlapped
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlapped)
}
