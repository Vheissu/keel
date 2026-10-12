package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"regexp"
	"strings"
)

const archiveLimit = 25 * 1024 * 1024

var archivePathPattern = regexp.MustCompile(`^[a-zA-Z0-9_-][a-zA-Z0-9._-]*(/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)*$`)

func validArchivePath(path string) bool {
	return len(path) <= 200 && archivePathPattern.MatchString(path)
}

// Read only the declared entry into bounded memory. Never extract publisher paths.
// The release still identifies the original ZIP digest, not a repackaged artifact.
func imageArchive(data []byte, path string) ([]byte, error) {
	if len(data) > archiveLimit {
		return nil, errors.New("artifact exceeds archive limit")
	}

	if path == "" {
		return data, nil
	}

	if !validArchivePath(path) {
		return nil, errors.New("invalid archive path")
	}

	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(reader.File) > 1000 {
		return nil, errors.New("invalid ZIP archive")
	}

	seen := map[string]bool{}
	var selected *zip.File
	var total uint64
	for _, file := range reader.File {
		name := strings.TrimSuffix(file.Name, "/")
		if !validArchivePath(name) || seen[name] || file.Flags&1 != 0 || (!file.Mode().IsRegular() && !file.Mode().IsDir()) {
			return nil, errors.New("unsafe ZIP entry")
		}

		seen[name] = true
		if file.UncompressedSize64 > archiveLimit {
			return nil, errors.New("ZIP entry exceeds archive limit")
		}

		total += file.UncompressedSize64
		if total > archiveLimit {
			return nil, errors.New("ZIP contents exceed archive limit")
		}

		if file.Name == path && file.Mode().IsRegular() {
			selected = file
		}
	}

	if selected == nil {
		return nil, errors.New("declared Docker archive is missing")
	}

	entry, err := selected.Open()
	if err != nil {
		return nil, errors.New("cannot open Docker archive")
	}

	defer entry.Close()
	content, err := io.ReadAll(io.LimitReader(entry, archiveLimit+1))
	if err != nil || len(content) > archiveLimit || uint64(len(content)) != selected.UncompressedSize64 {
		return nil, errors.New("invalid Docker archive contents")
	}

	return content, nil
}
