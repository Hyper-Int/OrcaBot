// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build linux

package pty

import (
	"os"
	"syscall"
	"unsafe"
)

func writeSilentPlatform(file *os.File, data []byte) (int, error) {
	fd := int(file.Fd())
	termios, err := ioctlGetTermios(fd)
	if err != nil {
		return file.Write(data)
	}
	original := *termios
	termios.Lflag &^= syscall.ECHO
	if err := ioctlSetTermios(fd, termios); err != nil {
		return file.Write(data)
	}

	n, writeErr := file.Write(data)

	restore := original
	_ = ioctlSetTermios(fd, &restore)
	return n, writeErr
}

func ioctlGetTermios(fd int) (*syscall.Termios, error) {
	var termios syscall.Termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(syscall.TCGETS), uintptr(unsafe.Pointer(&termios)))
	if errno != 0 {
		return nil, errno
	}
	return &termios, nil
}

func ioctlSetTermios(fd int, termios *syscall.Termios) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(syscall.TCSETS), uintptr(unsafe.Pointer(termios)))
	if errno != 0 {
		return errno
	}
	return nil
}
