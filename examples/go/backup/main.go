// GotYouBro backup client for Go (standard library only).
//
// Dumps a database, gzips it, splits it into parts that fit the server's upload limit and
// uploads every part. Split backups also get a small manifest (<name>.manifest.json) so
// ./restore can verify and rejoin the parts.
//
//	go run ./backup sqlite   ./data/app.db
//	go run ./backup postgres postgres://user:pass@localhost:5432/app
//	go run ./backup mysql    mysql://user:pass@localhost:3306/app
//	go run ./backup mongodb  mongodb://localhost:27017/app
//	go run ./backup file     ./uploads.tar
//
// Flags go before the arguments: -name <prefix>  -part-size-mb <n>  -keep
// Env: GOTYOUBRO_URL, GOTYOUBRO_TOKEN
// Requires the matching CLI tool: sqlite3, mysqldump, pg_dump or mongodump.
package main

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"hash"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	mb          = 1024 * 1024
	maxAttempts = 5
)

var (
	baseURL = strings.TrimRight(getenv("GOTYOUBRO_URL", "http://localhost:6969"), "/")
	token   = os.Getenv("GOTYOUBRO_TOKEN")
	client  = &http.Client{Timeout: 15 * time.Minute}
	unsafe  = regexp.MustCompile(`[^\w.-]+`)
)

var restoreHints = map[string]string{
	"sqlite":   "gunzip -c {file} > app.db",
	"mysql":    "gunzip -c {file} | mysql -u root -p",
	"postgres": "gunzip -c {file} | psql postgres://user:pass@host:5432/app",
	"mongodb":  "gunzip -c {file} | mongorestore --uri=mongodb://host:27017 --archive",
	"file":     "gunzip -c {file} > restored-file",
}

// ---------------------------------------------------------------- dump sources

type source struct {
	ext    string
	reader io.ReadCloser
	cmd    *exec.Cmd // nil for plain files
}

func openSource(kind, target, workDir string) (*source, error) {
	switch kind {
	case "sqlite":
		if _, err := os.Stat(target); err != nil {
			return nil, err
		}
		// `.backup` takes a consistent snapshot even while the app is writing.
		snapshot := filepath.Join(workDir, "snapshot.sqlite")
		cmd := exec.Command("sqlite3", target, fmt.Sprintf(".backup '%s'", strings.ReplaceAll(snapshot, "'", "''")))
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("sqlite3: %w", err)
		}
		f, err := os.Open(snapshot)
		return &source{ext: "sqlite", reader: f}, err
	case "mysql":
		args, err := mysqlArgs(target, workDir)
		if err != nil {
			return nil, err
		}
		return spawn("sql", nil, "mysqldump", args...)
	case "postgres":
		// Move the password into PGPASSWORD so it doesn't show up in `ps`.
		env, dbname := os.Environ(), target
		if strings.HasPrefix(target, "postgres://") || strings.HasPrefix(target, "postgresql://") {
			u, err := url.Parse(target)
			if err != nil {
				return nil, err
			}
			if pw, ok := u.User.Password(); ok {
				env = append(env, "PGPASSWORD="+pw)
				u.User = url.User(u.User.Username())
			}
			dbname = u.String()
		}
		return spawn("sql", env, "pg_dump", "--no-owner", "--no-privileges", "--dbname="+dbname)
	case "mongodb":
		return spawn("archive", nil, "mongodump", "--uri="+target, "--archive")
	case "file":
		f, err := os.Open(target)
		return &source{ext: filepath.Base(target), reader: f}, err
	}
	return nil, fmt.Errorf("unknown source type %q (sqlite, mysql, postgres, mongodb, file)", kind)
}

// mysqlArgs accepts `mysql://user:pass@host:3306/db` or just `db` (then ~/.my.cnf / defaults
// are used). The password goes into a private options file instead of the command line.
func mysqlArgs(target, workDir string) ([]string, error) {
	args := []string{"--single-transaction", "--routines", "--triggers", "--events"}
	database := target
	if strings.HasPrefix(target, "mysql://") {
		u, err := url.Parse(target)
		if err != nil {
			return nil, err
		}
		database = strings.TrimPrefix(u.Path, "/")
		if h := u.Hostname(); h != "" {
			args = append(args, "--host="+h)
		}
		if p := u.Port(); p != "" {
			args = append(args, "--port="+p)
		}
		if name := u.User.Username(); name != "" {
			args = append(args, "--user="+name)
		}
		if pw, ok := u.User.Password(); ok {
			cnf := filepath.Join(workDir, "client.cnf")
			escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(pw)
			if err := os.WriteFile(cnf, []byte("[client]\npassword=\""+escaped+"\"\n"), 0o600); err != nil {
				return nil, err
			}
			args = append([]string{"--defaults-extra-file=" + cnf}, args...) // must be the first option
		}
	}
	if database == "" {
		return nil, fmt.Errorf("MySQL: no database name in the target")
	}
	return append(args, "--databases", database), nil
}

func spawn(ext string, env []string, name string, args ...string) (*source, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = env // nil → inherit the current environment
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("cannot run %s: %w", name, err)
	}
	return &source{ext: ext, reader: stdout, cmd: cmd}, nil
}

// ---------------------------------------------------------------- splitting

type part struct {
	path string
	size int64
	hash hash.Hash
}

// partWriter cuts incoming bytes into fixed-size part files and hashes everything.
type partWriter struct {
	dir, baseName string
	partSize      int64
	parts         []*part
	file          *os.File
	total         int64
	hash          hash.Hash
}

func (w *partWriter) Write(p []byte) (int, error) {
	w.hash.Write(p)
	w.total += int64(len(p))
	written := 0
	for len(p) > 0 {
		if len(w.parts) == 0 || w.parts[len(w.parts)-1].size >= w.partSize {
			if err := w.nextPart(); err != nil {
				return written, err
			}
		}
		cur := w.parts[len(w.parts)-1]
		n := int64(len(p))
		if room := w.partSize - cur.size; n > room {
			n = room
		}
		if _, err := w.file.Write(p[:n]); err != nil {
			return written, err
		}
		cur.hash.Write(p[:n])
		cur.size += n
		written += int(n)
		p = p[n:]
	}
	return written, nil
}

func (w *partWriter) nextPart() error {
	if w.file != nil {
		if err := w.file.Close(); err != nil {
			return err
		}
	}
	path := filepath.Join(w.dir, fmt.Sprintf("%s.part%03d", w.baseName, len(w.parts)+1))
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	w.file = f
	w.parts = append(w.parts, &part{path: path, hash: sha256.New()})
	return nil
}

func (w *partWriter) Close() error {
	if w.file != nil {
		return w.file.Close()
	}
	return nil
}

// ---------------------------------------------------------------- upload

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type backupResult struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	Idempotent bool   `json:"idempotent"`
}

// serverMaxBytes asks the server for the largest file it accepts for this token.
func serverMaxBytes() int64 {
	req, _ := http.NewRequest(http.MethodGet, baseURL+"/api/v1/service", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	var body struct {
		Data struct {
			Limits struct {
				MaxBackupBytes int64 `json:"maxBackupBytes"`
			} `json:"limits"`
		} `json:"data"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil {
		return 0
	}
	return body.Data.Limits.MaxBackupBytes
}

func uploadFile(path, name string) (*backupResult, error) {
	key := name
	if len(key) > 128 {
		key = key[len(key)-128:]
	}
	for attempt := 1; ; attempt++ {
		result, status, retryAfter, err := uploadOnce(path, name, key)
		switch {
		case err == nil:
			return result, nil
		case status == http.StatusTooManyRequests:
			log.Printf("  rate limited, waiting %s…", retryAfter)
			time.Sleep(retryAfter)
			attempt-- // rate limiting isn't a failed attempt
		case (status == 0 || status >= 500 || status == http.StatusRequestTimeout) && attempt < maxAttempts:
			wait := time.Duration(min(60, (1<<attempt)*2)) * time.Second
			log.Printf("  %v — retrying in %s (attempt %d/%d)", err, wait, attempt+1, maxAttempts)
			time.Sleep(wait)
		default:
			return nil, fmt.Errorf("upload of %s failed: %w", name, err)
		}
	}
}

func uploadOnce(path, name, key string) (*backupResult, int, time.Duration, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, -1, 0, err
	}
	defer f.Close()
	info, _ := f.Stat()

	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/v1/backups/raw?wait=true", f)
	if err != nil {
		return nil, -1, 0, err
	}
	req.ContentLength = info.Size()
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Filename", url.PathEscape(name))
	// Same key on retry: a delivered part is never sent twice, a failed one is retried.
	req.Header.Set("Idempotency-Key", key)

	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, 0, err // network error → retry
	}
	defer resp.Body.Close()
	var body struct {
		Data  backupResult `json:"data"`
		Error apiError     `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if resp.StatusCode < 300 {
		return &body.Data, resp.StatusCode, 0, nil // 200 delivered, 202 still being delivered
	}
	retryAfter := 60 * time.Second
	if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
		retryAfter = time.Duration(s) * time.Second
	}
	return nil, resp.StatusCode, retryAfter, fmt.Errorf("%d %s %s", resp.StatusCode, body.Error.Code, body.Error.Message)
}

// ---------------------------------------------------------------- main

type manifestPart struct {
	File   string `json:"file"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type manifest struct {
	Format    string         `json:"format"`
	File      string         `json:"file"`
	Source    string         `json:"source"`
	CreatedAt string         `json:"createdAt"`
	Size      int64          `json:"size"`
	SHA256    string         `json:"sha256"`
	Parts     []manifestPart `json:"parts"`
	Restore   string         `json:"restore"`
}

func main() {
	name := flag.String("name", "", "file name prefix (default: the source type)")
	partSizeMB := flag.Float64("part-size-mb", 0, "split size (default: 95% of the server limit)")
	keep := flag.Bool("keep", false, "keep the local parts")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: backup [-name x] [-part-size-mb n] [-keep] <sqlite|mysql|postgres|mongodb|file> <target>")
	}
	flag.Parse()
	if flag.NArg() != 2 {
		flag.Usage()
		os.Exit(2)
	}
	if token == "" {
		log.Fatal("Set GOTYOUBRO_TOKEN")
	}
	if err := run(flag.Arg(0), flag.Arg(1), *name, *partSizeMB, *keep); err != nil {
		log.Fatalf("Backup failed: %v", err)
	}
}

func run(kind, target, prefix string, partSizeMB float64, keep bool) error {
	workDir, err := os.MkdirTemp("", "gotyoubro-")
	if err != nil {
		return err
	}
	if !keep {
		defer os.RemoveAll(workDir)
	}

	// 1. Dump → gzip → parts
	src, err := openSource(kind, target, workDir)
	if err != nil {
		return err
	}
	if prefix == "" {
		prefix = kind
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	baseName := unsafe.ReplaceAllString(fmt.Sprintf("%s-%s.%s.gz", prefix, stamp, src.ext), "_")

	partSize := int64(partSizeMB * mb)
	if partSize <= 0 {
		max := serverMaxBytes()
		if max <= 0 {
			max = 50 * mb
		}
		partSize = max * 95 / 100 // leave headroom below the limit
	}
	log.Printf("Dumping %s → %s (parts of %.1f MB)", kind, baseName, float64(partSize)/mb)

	writer := &partWriter{dir: workDir, baseName: baseName, partSize: partSize, hash: sha256.New()}
	gz, _ := gzip.NewWriterLevel(writer, gzip.BestCompression)
	_, copyErr := io.Copy(gz, src.reader)
	src.reader.Close()
	if err := errors.Join(copyErr, gz.Close(), writer.Close()); err != nil {
		return err
	}
	if src.cmd != nil {
		if err := src.cmd.Wait(); err != nil {
			return fmt.Errorf("%s: %w", src.cmd.Path, err)
		}
	}

	// 2. One part → upload as a plain .gz file. Several parts → parts + manifest.
	type upload struct{ path, name string }
	var uploads []upload
	if len(writer.parts) == 1 {
		single := filepath.Join(workDir, baseName)
		if err := os.Rename(writer.parts[0].path, single); err != nil {
			return err
		}
		uploads = append(uploads, upload{single, baseName})
	} else {
		m := manifest{
			Format:    "gotyoubro-split-v1",
			File:      baseName,
			Source:    kind,
			CreatedAt: time.Now().UTC().Format(time.RFC3339),
			Size:      writer.total,
			SHA256:    hex.EncodeToString(writer.hash.Sum(nil)),
			Restore:   "go run ./restore <folder with the parts> && " + strings.ReplaceAll(restoreHints[kind], "{file}", baseName),
		}
		for _, p := range writer.parts {
			m.Parts = append(m.Parts, manifestPart{filepath.Base(p.path), p.size, hex.EncodeToString(p.hash.Sum(nil))})
			uploads = append(uploads, upload{p.path, filepath.Base(p.path)})
		}
		manifestPath := filepath.Join(workDir, baseName+".manifest.json")
		data, _ := json.MarshalIndent(m, "", "  ")
		if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
			return err
		}
		uploads = append(uploads, upload{manifestPath, filepath.Base(manifestPath)})
	}

	// 3. Upload sequentially (keeps parts in order in the Telegram chat).
	for i, u := range uploads {
		info, _ := os.Stat(u.path)
		log.Printf("[%d/%d] uploading %s (%.1f MB)", i+1, len(uploads), u.name, float64(info.Size())/mb)
		res, err := uploadFile(u.path, u.name)
		if err != nil {
			return err
		}
		again := ""
		if res.Idempotent {
			again = " (already uploaded)"
		}
		log.Printf("  ✓ %s%s — backup %s", res.Status, again, res.ID)
	}
	log.Printf("Done: %.1f MB in %d file(s).", float64(writer.total)/mb, len(uploads))
	if keep {
		log.Printf("Local copy kept in %s", workDir)
	}
	return nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
