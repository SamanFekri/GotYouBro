// Rejoin a split GotYouBro backup (Go, standard library only).
//
// Download all parts (and the .manifest.json) from Telegram into one folder, then:
//
//	go run ./restore ./downloads                  # → postgres-20260924T030000Z.sql.gz
//	go run ./restore -extract ./downloads         # → postgres-20260924T030000Z.sql
//	go run ./restore -out backup.sql.gz a.part001 a.part002
//
// With a manifest every part and the joined file are verified with SHA-256.
// Without one, files named *.partNNN are joined in order.
package main

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var partRE = regexp.MustCompile(`^(.*)\.part(\d{3,})$`)

type manifestPart struct {
	File   string `json:"file"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type manifest struct {
	File    string         `json:"file"`
	SHA256  string         `json:"sha256"`
	Parts   []manifestPart `json:"parts"`
	Restore string         `json:"restore"`
}

type partFile struct {
	path, sha256 string
}

func main() {
	out := flag.String("out", "", "output file (default: original name)")
	extract := flag.Bool("extract", false, "also gunzip the joined file")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: restore [-out file.gz] [-extract] <folder | files...>")
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(flag.Args(), *out, *extract); err != nil {
		log.Fatalf("Restore failed: %v", err)
	}
}

func run(inputs []string, out string, extract bool) error {
	files, err := collectFiles(inputs)
	if err != nil {
		return err
	}

	var m *manifest
	var parts []partFile
	outName := ""
	for _, f := range files {
		if strings.HasSuffix(f, ".manifest.json") {
			data, err := os.ReadFile(f)
			if err != nil {
				return err
			}
			m = &manifest{}
			if err := json.Unmarshal(data, m); err != nil {
				return fmt.Errorf("invalid manifest: %w", err)
			}
			byName := map[string]string{}
			for _, x := range files {
				byName[filepath.Base(x)] = x
			}
			for _, p := range m.Parts {
				path, ok := byName[p.File]
				if !ok {
					path = filepath.Join(filepath.Dir(f), p.File)
				}
				parts = append(parts, partFile{path, p.SHA256})
			}
			outName = m.File
			break
		}
	}
	if m == nil {
		type numbered struct {
			path string
			n    int
		}
		var found []numbered
		for _, f := range files {
			if match := partRE.FindStringSubmatch(filepath.Base(f)); match != nil {
				n, _ := strconv.Atoi(match[2])
				found = append(found, numbered{f, n})
				outName = match[1]
			}
		}
		if len(found) == 0 {
			return fmt.Errorf("no *.partNNN files or manifest found")
		}
		sort.Slice(found, func(i, j int) bool { return found[i].n < found[j].n })
		for _, x := range found {
			parts = append(parts, partFile{path: x.path})
		}
	}
	if out == "" {
		out = outName
	}

	log.Printf("Joining %d part(s) → %s", len(parts), out)
	dst, err := os.Create(out)
	if err != nil {
		return err
	}
	total := sha256.New()
	for i, p := range parts {
		if p.sha256 != "" {
			sum, err := fileSHA256(p.path)
			if err != nil {
				return fmt.Errorf("missing part %s: %w", filepath.Base(p.path), err)
			}
			if sum != p.sha256 {
				return fmt.Errorf("checksum mismatch in %s — download it again", filepath.Base(p.path))
			}
		}
		src, err := os.Open(p.path)
		if err != nil {
			return fmt.Errorf("missing part %s: %w", filepath.Base(p.path), err)
		}
		_, err = io.Copy(io.MultiWriter(dst, total), src)
		src.Close()
		if err != nil {
			return err
		}
		log.Printf("  ✓ %d/%d %s", i+1, len(parts), filepath.Base(p.path))
	}
	if err := dst.Close(); err != nil {
		return err
	}
	if m != nil {
		if hex.EncodeToString(total.Sum(nil)) != m.SHA256 {
			return fmt.Errorf("checksum of the joined file does not match the manifest")
		}
		log.Print("Checksums verified.")
	}

	if extract {
		target := strings.TrimSuffix(out, ".gz")
		if target == out {
			target = out + ".out"
		}
		if err := gunzip(out, target); err != nil {
			return err
		}
		log.Printf("Extracted → %s", target)
	}
	if m != nil && m.Restore != "" {
		hint := m.Restore
		if i := strings.LastIndex(hint, "&& "); i >= 0 {
			hint = hint[i+3:]
		}
		fmt.Printf("\nRestore with:\n  %s\n", hint)
	}
	return nil
}

func collectFiles(inputs []string) ([]string, error) {
	var files []string
	for _, in := range inputs {
		info, err := os.Stat(in)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			files = append(files, in)
			continue
		}
		entries, err := os.ReadDir(in)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			files = append(files, filepath.Join(in, e.Name()))
		}
	}
	return files, nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func gunzip(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	zr, err := gzip.NewReader(in)
	if err != nil {
		return err
	}
	defer zr.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, zr); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
