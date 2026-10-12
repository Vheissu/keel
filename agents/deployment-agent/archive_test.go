package main

import (
	"archive/zip"
	"bytes"
	"os"
	"strings"
	"testing"
)

func zipFixture(t *testing.T, headers []zip.FileHeader, content []byte) []byte {
	t.Helper()
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	for _, header := range headers {
		entry, err := writer.CreateHeader(&header)
		if err != nil {
			t.Fatal(err)
		}

		if strings.HasSuffix(header.Name, "/") {
			continue
		}

		if _, err := entry.Write(content); err != nil {
			t.Fatal(err)
		}
	}

	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	return data.Bytes()
}

func TestZIPSelectsDeclaredArchive(t *testing.T) {
	content := []byte("retained Docker archive")
	data := zipFixture(t, []zip.FileHeader{{Name: "dist/application.tar", Method: zip.Deflate}}, content)
	actual, err := imageArchive(data, "dist/application.tar")
	if err != nil || !bytes.Equal(actual, content) {
		t.Fatalf("declared entry not read: %v", err)
	}

	if _, err := imageArchive(data, "application.tar"); err == nil {
		t.Fatal("accepted missing entry")
	}

	if _, err := imageArchive([]byte("invalid"), "application.tar"); err == nil {
		t.Fatal("accepted malformed ZIP")
	}

	actual, err = imageArchive(content, "")
	if err != nil || !bytes.Equal(actual, content) {
		t.Fatal("raw archives changed")
	}
}

func TestZIPRejectsUnsafeEntries(t *testing.T) {
	symlink := zip.FileHeader{Name: "application.tar"}
	symlink.SetMode(os.ModeSymlink | 0777)
	for _, headers := range [][]zip.FileHeader{
		{{Name: "../application.tar"}},
		{{Name: "/application.tar"}},
		{{Name: "a\\application.tar"}},
		{{Name: "a/./application.tar"}},
		{{Name: "application.tar"}, {Name: "application.tar"}},
		{{Name: "application.tar"}, {Name: "application.tar/"}},
		{symlink},
		{{Name: "application.tar", Flags: 1}},
	} {
		data := zipFixture(t, headers, []byte("invalid"))
		if _, err := imageArchive(data, "application.tar"); err == nil {
			t.Fatalf("accepted unsafe headers: %+v", headers)
		}
	}
}

func TestZIPRejectsBombAndCorruption(t *testing.T) {
	data := zipFixture(t, []zip.FileHeader{{Name: "application.tar", Method: zip.Deflate}}, bytes.Repeat([]byte("x"), archiveLimit+1))
	if _, err := imageArchive(data, "application.tar"); err == nil {
		t.Fatal("accepted oversized expansion")
	}

	data = zipFixture(t, []zip.FileHeader{{Name: "application.tar", Method: zip.Store}}, []byte("docker-data"))
	index := bytes.Index(data, []byte("docker-data"))
	data[index] ^= 1
	if _, err := imageArchive(data, "application.tar"); err == nil {
		t.Fatal("accepted corrupt CRC")
	}

	headers := make([]zip.FileHeader, 1001)
	for i := range headers {
		headers[i] = zip.FileHeader{Name: "application.tar"}
	}

	if _, err := imageArchive(zipFixture(t, headers, nil), "application.tar"); err == nil {
		t.Fatal("accepted excessive entry count")
	}
}
