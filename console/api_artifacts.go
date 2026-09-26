package main

// Artifact drop-folder listing, upload, download, deletion, and name safety.

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

const maxArtifactUpload = 100 << 20 // 100 MiB

// artifactsDir is a var so tests can point storage at a fixture directory.
var artifactsDir = "/config/artifacts"

type artifact struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

func handleArtifacts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		listArtifacts(w)
	case http.MethodPost:
		uploadArtifact(w, r)
	case http.MethodDelete:
		deleteArtifact(w, r)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func listArtifacts(w http.ResponseWriter) {
	arts := []artifact{}
	entries, err := os.ReadDir(artifactsDir)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusOK, map[string]any{"artifacts": arts})
			return
		}
		writeAPIError(w, http.StatusInternalServerError, "could not read artifacts")
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		arts = append(arts, artifact{Name: e.Name(), Size: info.Size(), Mtime: info.ModTime().Unix()})
	}
	sort.Slice(arts, func(i, j int) bool { return arts[i].Mtime > arts[j].Mtime })
	writeJSON(w, http.StatusOK, map[string]any{"artifacts": arts})
}

func uploadArtifact(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxArtifactUpload)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid upload")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "missing file")
		return
	}
	defer file.Close()
	name, ok := sanitizeArtifactName(header.Filename)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid filename")
		return
	}
	if err := os.MkdirAll(artifactsDir, 0o755); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "write failed")
		return
	}
	final := uniqueName(name)
	full := filepath.Join(artifactsDir, final)
	dst, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "write failed")
		return
	}
	if _, err := io.Copy(dst, file); err != nil {
		_ = dst.Close()
		_ = os.Remove(full)
		writeAPIError(w, http.StatusInternalServerError, "write failed")
		return
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(full)
		writeAPIError(w, http.StatusInternalServerError, "write failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": final})
}

// resolveArtifact accepts only an existing regular file under artifactsDir.
func resolveArtifact(w http.ResponseWriter, r *http.Request) (full string, info os.FileInfo, ok bool) {
	name, valid := sanitizeArtifactName(r.URL.Query().Get("name"))
	if !valid {
		writeAPIError(w, http.StatusBadRequest, "invalid name")
		return "", nil, false
	}
	full = filepath.Join(artifactsDir, name)
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		writeAPIError(w, http.StatusNotFound, "not found")
		return "", nil, false
	}
	return full, info, true
}

func deleteArtifact(w http.ResponseWriter, r *http.Request) {
	full, _, ok := resolveArtifact(w, r)
	if !ok {
		return
	}
	if err := os.Remove(full); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	writeOK(w)
}

func handleArtifactRaw(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	full, info, ok := resolveArtifact(w, r)
	if !ok {
		return
	}
	f, err := os.Open(full)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not found")
		return
	}
	defer f.Close()
	name := info.Name()
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	http.ServeContent(w, r, name, info.ModTime(), f)
}

// sanitizeArtifactName accepts only a bare filename inside artifactsDir. Control
// runes are refused in full (C0, DEL and C1): insert-path types the name into a
// pane with send-keys -l, and the pane's line editor reads DEL as Backspace.
func sanitizeArtifactName(name string) (string, bool) {
	if name == "" || name == "." || name == ".." {
		return "", false
	}
	if strings.Contains(name, "..") || name != filepath.Base(name) {
		return "", false
	}
	for _, ch := range name {
		if unicode.IsControl(ch) || ch == '"' || ch == '\\' {
			return "", false
		}
	}
	return name, true
}

func uniqueName(name string) string {
	if !fileExists(filepath.Join(artifactsDir, name)) {
		return name
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", stem, i, ext)
		if !fileExists(filepath.Join(artifactsDir, candidate)) {
			return candidate
		}
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
