package main

// Credential-store persistence and path safety. Every mutation runs through an
// explicit credentialTransaction; vendor cleanup receives that transaction
// rather than sharing or acquiring a package-level lock of its own.

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const (
	credentialStoreRel       = ".config/envhaven/environment"
	credentialStoreHeader    = "# Managed by EnvHaven. Edit through the Environment panel."
	legacyManagedMarker      = " # envhaven"
	legacyPairReceiptPrefix  = "# EnvHaven legacy sidebar migration "
	legacyMigrationStoreStep = "managed-store"
)

var (
	rcFiles             = []string{".zshrc", ".bashrc"}
	rcAssignRe          = regexp.MustCompile(`^\s*export\s+(\w+)=["']?[^"'\n]+`)
	rcExportNameRe      = regexp.MustCompile(`^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=`)
	legacyPairReceiptRe = regexp.MustCompile(`^# EnvHaven legacy sidebar migration ([A-Za-z_][A-Za-z0-9_]*) ([0-9a-f]{64})$`)

	credentialStoreState credentialStore
)

type credentialSource struct {
	managed bool
	manual  bool
}

type credentialSources map[string]credentialSource

type credentialStore struct {
	mu sync.Mutex
}

type credentialTransaction struct {
	home string
}

type managedCredentialState struct {
	lines    map[string]string
	receipts map[string]string
}

// credentialStoreError is a problem in the managed store that only an edit to the
// file can fix. Its text holds the file path and at most a line number, never a
// variable or a value, so HTTP handlers show it to the user.
type credentialStoreError struct {
	problem string
}

func (err *credentialStoreError) Error() string {
	return "~/" + credentialStoreRel + ": " + err.problem
}

// credentialErrorMessage is the HTTP error text for a failed credential operation:
// the store problem when an edit can fix it, otherwise the fallback, because other
// errors can carry vendor command output.
func credentialErrorMessage(err error, fallback string) string {
	var storeErr *credentialStoreError
	if errors.As(err, &storeErr) {
		return storeErr.Error()
	}
	return fallback
}

// transaction runs a mutation after moving marked legacy exports into the store.
func (store *credentialStore) transaction(home string, operation func(*credentialTransaction) error) error {
	return store.withLock(home, func(tx *credentialTransaction) error {
		if err := tx.migrateLegacy(); err != nil {
			return err
		}
		return operation(tx)
	})
}

// withLock serializes store access without migrating. Reads take it directly, so
// they never write, and so does the startup migration, which runs its own.
func (store *credentialStore) withLock(home string, operation func(*credentialTransaction) error) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	return operation(&credentialTransaction{home: home})
}

func cleanCredentialValue(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsAny(value, "\x00\r\n") {
		return "", false
	}
	return value, true
}

func managedExportLine(name, value string) string {
	return "export " + name + "=" + shellSingleQuote(value)
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func credentialStorePath(home string) string {
	return filepath.Join(home, credentialStoreRel)
}

func (tx *credentialTransaction) readManagedCredentialState() (managedCredentialState, error) {
	state := managedCredentialState{lines: map[string]string{}, receipts: map[string]string{}}
	path := credentialStorePath(tx.home)
	if err := validateCredentialStorePath(tx.home, path); err != nil {
		return state, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	for number, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if match := legacyPairReceiptRe.FindStringSubmatch(line); match != nil {
			if _, exists := state.receipts[match[1]]; exists {
				return state, &credentialStoreError{fmt.Sprintf("line %d repeats a migration receipt", number+1)}
			}
			state.receipts[match[1]] = match[2]
			continue
		}
		if strings.HasPrefix(line, legacyPairReceiptPrefix) {
			return state, &credentialStoreError{fmt.Sprintf("line %d is not a valid migration receipt", number+1)}
		}
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		name, ok := exportName(line)
		if !ok {
			return state, &credentialStoreError{fmt.Sprintf("line %d is not a comment or an export NAME=value line", number+1)}
		}
		// A repeated name resolves to its last line, as sourcing the file does, so a
		// key rotated by appending an export works; the next write keeps one line.
		state.lines[name] = line
	}
	return state, nil
}

func (tx *credentialTransaction) readManagedCredentialLines() (map[string]string, error) {
	state, err := tx.readManagedCredentialState()
	return state.lines, err
}

func (tx *credentialTransaction) writeManagedCredentialState(state managedCredentialState) error {
	path := credentialStorePath(tx.home)
	_, err := ensureCredentialStoreDirectory(tx.home)
	if err != nil {
		return err
	}
	if err := validateCredentialStorePath(tx.home, path); err != nil {
		return err
	}
	receiptNames := make([]string, 0, len(state.receipts))
	for name := range state.receipts {
		receiptNames = append(receiptNames, name)
	}
	sort.Strings(receiptNames)
	names := make([]string, 0, len(state.lines))
	for name := range state.lines {
		names = append(names, name)
	}
	sort.Strings(names)
	var content strings.Builder
	content.WriteString(credentialStoreHeader)
	content.WriteByte('\n')
	for _, name := range receiptNames {
		content.WriteString(legacyPairReceiptPrefix)
		content.WriteString(name)
		content.WriteByte(' ')
		content.WriteString(state.receipts[name])
		content.WriteByte('\n')
	}
	for _, name := range names {
		content.WriteString(state.lines[name])
		content.WriteByte('\n')
	}
	return atomicReplaceFile(path, []byte(content.String()), 0o600)

}

// set and remove rewrite the whole state, so a receipt left by an interrupted
// startup migration survives until the next startup finishes it.
func (tx *credentialTransaction) set(name, value string) error {
	state, err := tx.readManagedCredentialState()
	if err != nil {
		return err
	}
	state.lines[name] = managedExportLine(name, value)
	return tx.writeManagedCredentialState(state)
}

func (tx *credentialTransaction) remove(names []string) error {
	state, err := tx.readManagedCredentialState()
	if err != nil {
		return err
	}
	var removed []string
	for _, name := range names {
		if _, ok := state.lines[name]; ok {
			delete(state.lines, name)
			removed = append(removed, name)
		}
	}
	if len(removed) == 0 {
		return nil
	}
	if err := tx.writeManagedCredentialState(state); err != nil {
		return err
	}
	unsetTmuxGlobalEnvironment(removed)
	return nil
}

// unsetTmuxGlobalEnvironment drops removed names from the tmux server's global
// environment. A server started from a shell that had sourced the store keeps a
// copy of every key there, and new windows inherit it until tmux restarts. A name
// the workspace process environment sets keeps its tmux value, which comes from the
// workspace configuration this removal leaves alone. Errors are ignored: without a
// running server there is nothing to clean.
func unsetTmuxGlobalEnvironment(names []string) {
	ctx, cancel := context.WithTimeout(context.Background(), tmuxCmdTimeout)
	defer cancel()
	for _, name := range names {
		if os.Getenv(name) == "" {
			_ = tmuxRun(ctx, "set-environment", "-g", "-u", name)
		}
	}
}

func ensureCredentialStoreDirectory(home string) (string, error) {
	homeReal, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", err
	}
	dir := home
	for _, part := range []string{".config", "envhaven"} {
		dir = filepath.Join(dir, part)
		info, err := os.Lstat(dir)
		if errors.Is(err, os.ErrNotExist) {
			if err := os.Mkdir(dir, 0o700); err != nil {
				return "", err
			}
		} else if err != nil {
			return "", err
		} else if !info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			return "", fmt.Errorf("refusing non-directory credential path: %s", dir)
		}
		resolved, err := filepath.EvalSymlinks(dir)
		if err != nil {
			return "", err
		}
		resolvedInfo, err := os.Stat(resolved)
		if err != nil || !resolvedInfo.IsDir() || !pathWithin(homeReal, resolved) {
			return "", fmt.Errorf("credential directory resolves outside home: %s", dir)
		}
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

func validateCredentialStorePath(home, path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return &credentialStoreError{"not a regular file"}
	}
	homeReal, err := filepath.EvalSymlinks(home)
	if err != nil {
		return err
	}
	pathReal, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	if !pathWithin(homeReal, pathReal) {
		return &credentialStoreError{"resolves outside home"}
	}
	return nil
}

func cloneCredentialLines(lines map[string]string) map[string]string {
	clone := make(map[string]string, len(lines))
	for name, line := range lines {
		clone[name] = line
	}
	return clone
}

func exportName(line string) (string, bool) {
	if !strings.HasPrefix(line, "export ") {
		return "", false
	}
	rest := strings.TrimPrefix(line, "export ")
	equals := strings.IndexByte(rest, '=')
	if equals <= 0 || strings.TrimSpace(rest[equals+1:]) == "" {
		return "", false
	}
	name := rest[:equals]
	return name, envNameRe.MatchString(name)
}

// readCredentialSources reports where each exported name comes from without writing
// anything. A marked `# envhaven` rc line reads as managed only when the next
// migration would move it into the store; every other rc export is the user's,
// including one in an rc file EnvHaven does not rewrite.
func (tx *credentialTransaction) readCredentialSources() (credentialSources, error) {
	sources := credentialSources{}
	managed, err := tx.readManagedCredentialLines()
	if err != nil {
		return nil, err
	}
	for name := range managed {
		source := sources[name]
		source.managed = true
		sources[name] = source
	}
	logical, legacy, err := tx.readLegacyRCSources()
	if err != nil {
		return nil, err
	}
	// The plan marks, in each source's remove set, exactly the lines the next
	// migration moves.
	markLegacyManagedLines(managed, legacy)
	for _, rc := range rcFiles {
		migrationSource := logical[rc]
		var lines []string
		if migrationSource != nil {
			lines = migrationSource.lines
		} else {
			data, err := os.ReadFile(filepath.Join(tx.home, rc))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			lines = strings.Split(string(data), "\n")
		}
		for index, line := range lines {
			match := rcAssignRe.FindStringSubmatch(line)
			if match == nil {
				continue
			}
			source := sources[match[1]]
			if migrationSource != nil && migrationSource.remove[index] {
				source.managed = true
			} else {
				source.manual = true
			}
			sources[match[1]] = source
		}
	}
	return sources, nil
}

func readCredentialSources(home string) (credentialSources, error) {
	var sources credentialSources
	err := credentialStoreState.withLock(home, func(tx *credentialTransaction) error {
		var err error
		sources, err = tx.readCredentialSources()
		return err
	})
	return sources, err
}

func listManagedCredentialNames(home string) (map[string]bool, error) {
	sources, err := readCredentialSources(home)
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	for name, source := range sources {
		if source.managed {
			names[name] = true
		}
	}
	return names, nil
}

// migrateLegacyCredentials is the startup migration, the only one that also
// recognizes the original sidebar's unmarked rc pairs.
func migrateLegacyCredentials(home string) error {
	return credentialStoreState.withLock(home, func(tx *credentialTransaction) error {
		return tx.migrateLegacyWithOps(legacyMigrationOps{rewrite: atomicRewrite, pairs: true})
	})
}

type legacySidebarExport struct {
	index int
	value string
}

type legacyRCSource struct {
	rel         string
	path        string
	data        []byte
	mode        os.FileMode
	info        os.FileInfo
	lines       []string
	assignments map[string]int
	sidebar     map[string]legacySidebarExport
	remove      map[int]bool
}

type legacyMigrationOps struct {
	rewrite   func(string, []byte) error
	afterStep func(string) error
	// pairs enables the unmarked sidebar-pair rule and its receipts. Only startup
	// sets it: after startup an identical pair is an export the user wrote.
	pairs bool
}

type fileSnapshot struct {
	path   string
	data   []byte
	mode   os.FileMode
	exists bool
}

// migrateLegacy moves explicitly marked exports into the store before a mutation.
// The older sidebar format, the same unmarked double-quoted export in both rc files,
// is left to the startup migration: see legacyMigrationOps.pairs.
func (tx *credentialTransaction) migrateLegacy() error {
	return tx.migrateLegacyWithOps(legacyMigrationOps{rewrite: atomicRewrite})
}

// migrateLegacyWithOps first handles explicitly marked exports, then, with ops.pairs,
// the older sidebar pairs. A receipt in the managed store lets an interrupted pair
// migration finish without treating an otherwise indistinguishable single manual
// export as EnvHaven-owned.
func (tx *credentialTransaction) migrateLegacyWithOps(ops legacyMigrationOps) error {
	if ops.rewrite == nil {
		ops.rewrite = atomicRewrite
	}
	current, err := tx.readManagedCredentialState()
	if err != nil {
		return err
	}
	stage := cloneManagedCredentialState(current)
	logical, sources, err := tx.readLegacyRCSources()
	if err != nil {
		return err
	}

	moved := markLegacyManagedLines(stage.lines, sources)
	for name, line := range moved {
		stage.lines[name] = line
	}
	writeStage := len(moved) > 0

	if ops.pairs {
		// Existing receipts are sufficient evidence even when a previous process removed
		// one member of the pair before it stopped.
		for name, digest := range stage.receipts {
			for _, source := range sources {
				candidate, ok := source.sidebar[name]
				if !ok || source.assignments[name] != 1 || legacyPairDigest(name, candidate.value) != digest {
					continue
				}
				if stage.lines[name] != managedExportLine(name, candidate.value) {
					continue
				}
				source.remove[candidate.index] = true
			}
		}
	}

	zsh := logical[".zshrc"]
	bash := logical[".bashrc"]
	if ops.pairs && zsh != nil && bash != nil && !sameHomeFile(zsh, bash) {
		var candidateNames []string
		for name, zshExport := range zsh.sidebar {
			bashExport, ok := bash.sidebar[name]
			if !ok || zsh.assignments[name] != 1 || bash.assignments[name] != 1 {
				continue
			}
			if zshExport.value != bashExport.value || stage.receipts[name] != "" {
				continue
			}
			candidateNames = append(candidateNames, name)
		}
		if len(candidateNames) > 0 {
			catalog, err := loadCatalog()
			if err != nil {
				return fmt.Errorf("load managed environment metadata: %w", err)
			}
			sort.Strings(candidateNames)
			for _, name := range candidateNames {
				if _, known := catalog.EnvVarMeta[name]; !known {
					continue
				}
				value := zsh.sidebar[name].value
				managedLine := managedExportLine(name, value)
				if existing, exists := stage.lines[name]; exists && existing != managedLine {
					continue
				}
				stage.lines[name] = managedLine
				stage.receipts[name] = legacyPairDigest(name, value)
				zsh.remove[zsh.sidebar[name].index] = true
				bash.remove[bash.sidebar[name].index] = true
				writeStage = true
			}
		}
	}

	hasRewrites := false
	for _, source := range sources {
		if len(source.remove) > 0 {
			hasRewrites = true
			break
		}
	}
	if !writeStage && !hasRewrites && (!ops.pairs || len(stage.receipts) == 0) {
		return nil
	}

	storeBefore, err := snapshotOptionalFile(credentialStorePath(tx.home))
	if err != nil {
		return err
	}
	if writeStage {
		if err := tx.writeManagedCredentialState(stage); err != nil {
			return rollbackLegacyMigration(err, storeBefore, nil)
		}
		if ops.afterStep != nil {
			if err := ops.afterStep(legacyMigrationStoreStep); err != nil {
				return err
			}
		}
	}

	var rewritten []*legacyRCSource
	for _, source := range sources {
		if len(source.remove) == 0 {
			continue
		}
		kept := make([]string, 0, len(source.lines)-len(source.remove))
		for index, line := range source.lines {
			if !source.remove[index] {
				kept = append(kept, line)
			}
		}
		rewritten = append(rewritten, source)
		if err := ops.rewrite(source.path, []byte(strings.Join(kept, "\n"))); err != nil {
			return rollbackLegacyMigration(err, storeBefore, rewritten)
		}
		if ops.afterStep != nil {
			if err := ops.afterStep(source.rel); err != nil {
				return err
			}
		}
	}

	if ops.pairs && len(stage.receipts) > 0 {
		final := cloneManagedCredentialState(stage)
		final.receipts = map[string]string{}
		if err := tx.writeManagedCredentialState(final); err != nil {
			return rollbackLegacyMigration(err, storeBefore, rewritten)
		}
	}
	return nil
}

// markLegacyManagedLines plans the marked `# envhaven` exports the migration moves
// into the store: it marks each moved line in its source's remove set and returns
// the export line of every moved name. A name moves only when all of its marked
// lines agree and match the store's line, if the store has one. Any other name
// stays user-owned, its lines untouched.
func markLegacyManagedLines(store map[string]string, sources []*legacyRCSource) map[string]string {
	type markedLine struct {
		source *legacyRCSource
		index  int
		export string
	}
	marked := map[string][]markedLine{}
	for _, source := range sources {
		for index, line := range source.lines {
			trimmed := strings.TrimRight(strings.TrimSuffix(line, "\r"), " \t")
			if !strings.HasSuffix(trimmed, legacyManagedMarker) {
				continue
			}
			exportLine := strings.TrimSuffix(trimmed, legacyManagedMarker)
			name, valid := exportName(exportLine)
			if !valid {
				continue
			}
			marked[name] = append(marked[name], markedLine{source: source, index: index, export: exportLine})
		}
	}
	moved := map[string]string{}
	for name, lines := range marked {
		want, stored := store[name]
		if !stored {
			want = lines[0].export
		}
		agree := true
		for _, line := range lines {
			agree = agree && line.export == want
		}
		if !agree {
			continue
		}
		for _, line := range lines {
			line.source.remove[line.index] = true
		}
		moved[name] = want
	}
	return moved
}

func (tx *credentialTransaction) readLegacyRCSources() (map[string]*legacyRCSource, []*legacyRCSource, error) {
	logical := map[string]*legacyRCSource{}
	byPath := map[string]*legacyRCSource{}
	var sources []*legacyRCSource
	for _, rel := range rcFiles {
		path, ok, err := mutableHomeFile(tx.home, rel)
		if errors.Is(err, errUnsafeHomeFile) {
			continue // read-only to EnvHaven: never a migration source, its exports stay the user's
		}
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			continue
		}
		if source := byPath[path]; source != nil {
			logical[rel] = source
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, nil, err
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, nil, err
		}
		source := &legacyRCSource{
			rel:         rel,
			path:        path,
			data:        data,
			mode:        info.Mode().Perm(),
			info:        info,
			lines:       strings.Split(string(data), "\n"),
			assignments: map[string]int{},
			sidebar:     map[string]legacySidebarExport{},
			remove:      map[int]bool{},
		}
		for index, line := range source.lines {
			line = strings.TrimSuffix(line, "\r")
			if match := rcExportNameRe.FindStringSubmatch(line); match != nil {
				source.assignments[match[1]]++
			}
			name, value, ok := parseLegacySidebarExport(line)
			if ok {
				source.sidebar[name] = legacySidebarExport{index: index, value: value}
			}
		}
		byPath[path] = source
		logical[rel] = source
		sources = append(sources, source)
	}
	return logical, sources, nil
}

func parseLegacySidebarExport(line string) (string, string, bool) {
	if !strings.HasPrefix(line, "export ") {
		return "", "", false
	}
	rest := strings.TrimPrefix(line, "export ")
	equals := strings.IndexByte(rest, '=')
	if equals <= 0 || !envNameRe.MatchString(rest[:equals]) {
		return "", "", false
	}
	value, ok := decodeLegacyDoubleQuoted(rest[equals+1:])
	if !ok || value == "" || strings.ContainsAny(value, "\x00\r\n") {
		return "", "", false
	}
	return rest[:equals], value, true
}

func decodeLegacyDoubleQuoted(quoted string) (string, bool) {
	if len(quoted) < 2 || quoted[0] != '"' || quoted[len(quoted)-1] != '"' {
		return "", false
	}
	body := quoted[1 : len(quoted)-1]
	var value strings.Builder
	for index := 0; index < len(body); index++ {
		switch body[index] {
		case '"', '$', '`':
			return "", false
		case '\\':
			if index+1 >= len(body) {
				return "", false
			}
			index++
			next := body[index]
			if next == '$' || next == '`' || next == '"' || next == '\\' {
				value.WriteByte(next)
			} else {
				value.WriteByte('\\')
				value.WriteByte(next)
			}
		default:
			value.WriteByte(body[index])
		}
	}
	return value.String(), true
}

func legacyPairDigest(name, value string) string {
	digest := sha256.Sum256([]byte(name + "\x00" + value))
	return fmt.Sprintf("%x", digest)
}

func sameHomeFile(first, second *legacyRCSource) bool {
	return first == second || os.SameFile(first.info, second.info)
}

func cloneManagedCredentialState(state managedCredentialState) managedCredentialState {
	clone := managedCredentialState{
		lines:    cloneCredentialLines(state.lines),
		receipts: make(map[string]string, len(state.receipts)),
	}
	for name, digest := range state.receipts {
		clone.receipts[name] = digest
	}
	return clone
}

func snapshotOptionalFile(path string) (fileSnapshot, error) {
	snapshot := fileSnapshot{path: path}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return snapshot, nil
	}
	if err != nil {
		return snapshot, err
	}
	if !info.Mode().IsRegular() {
		return snapshot, fmt.Errorf("refusing to snapshot non-regular file: %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return snapshot, err
	}
	snapshot.data = data
	snapshot.mode = info.Mode().Perm()
	snapshot.exists = true
	return snapshot, nil
}

func rollbackLegacyMigration(cause error, store fileSnapshot, sources []*legacyRCSource) error {
	errorsFound := []error{cause}
	sourceRestoreFailed := false
	for index := len(sources) - 1; index >= 0; index-- {
		source := sources[index]
		if err := atomicReplaceFile(source.path, source.data, source.mode); err != nil {
			errorsFound = append(errorsFound, fmt.Errorf("restore %s: %w", source.rel, err))
			sourceRestoreFailed = true
		}
	}
	if !sourceRestoreFailed {
		if err := restoreFileSnapshot(store); err != nil {
			errorsFound = append(errorsFound, fmt.Errorf("restore managed credential store: %w", err))
		}
	}
	return errors.Join(errorsFound...)
}

func restoreFileSnapshot(snapshot fileSnapshot) error {
	if snapshot.exists {
		return atomicReplaceFile(snapshot.path, snapshot.data, snapshot.mode)
	}
	err := os.Remove(snapshot.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(snapshot.path))
}

// errUnsafeHomeFile marks a home file EnvHaven must not rewrite: it resolves outside
// HOME or to something other than a regular file.
var errUnsafeHomeFile = errors.New("not a regular file inside home")

// mutableHomeFile resolves a file EnvHaven reads and rewrites in place: an rc file,
// or vendor settings. A symlink resolves to its target inside HOME, so a rewrite
// replaces the target and the user's link survives. A missing or dangling path
// reports (false, nil).
func mutableHomeFile(home, rel string) (string, bool, error) {
	resolved, err := filepath.EvalSymlinks(filepath.Join(home, rel))
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	homeReal, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", false, err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", false, err
	}
	if !info.Mode().IsRegular() || !pathWithin(homeReal, resolved) {
		return "", false, fmt.Errorf("%w: %s", errUnsafeHomeFile, rel)
	}
	return resolved, true, nil
}

func safeRegularHomeFile(home, rel string) (string, bool, error) {
	full := filepath.Join(home, rel)
	if !pathWithin(home, full) {
		return "", false, fmt.Errorf("path escapes home: %s", rel)
	}
	info, err := os.Lstat(full)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !info.Mode().IsRegular() {
		return "", false, fmt.Errorf("refusing non-regular credential file: %s", rel)
	}
	homeReal, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", false, err
	}
	fullReal, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", false, err
	}
	if !pathWithin(homeReal, fullReal) {
		return "", false, fmt.Errorf("credential file resolves outside home: %s", rel)
	}
	return fullReal, true, nil
}

func atomicRewrite(path string, data []byte) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("refusing to rewrite non-regular file: %s", path)
	}
	return atomicReplaceFile(path, data, info.Mode().Perm())
}

func atomicReplaceFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(filepath.Dir(path), ".envhaven-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(mode.Perm()); err != nil {
		tmp.Close()
		return err
	}
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
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	return syncDirectory(dir)
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func pathWithin(home, full string) bool {
	rel, err := filepath.Rel(home, full)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func homeDir() string {
	if home := os.Getenv("HOME"); home != "" {
		return home
	}
	return "/config"
}
