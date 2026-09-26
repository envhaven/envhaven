package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func useLegacySidebarCatalog(t *testing.T) {
	t.Helper()
	previous := toolDefsPath
	toolDefsPath = filepath.Join("testdata", "legacy-sidebar", "catalog.json")
	t.Cleanup(func() { toolDefsPath = previous })
}

func writeLegacyRC(t *testing.T, home, name, contents string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(home, name)
	if err := os.WriteFile(path, []byte(contents), mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func readTestFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestLegacySidebarCredentialMigration(t *testing.T) {
	useLegacySidebarCatalog(t)
	home := t.TempDir()
	fixtureDir := filepath.Join("testdata", "legacy-sidebar")
	zshBefore := readTestFile(t, filepath.Join(fixtureDir, "zshrc"))
	bashBefore := readTestFile(t, filepath.Join(fixtureDir, "bashrc"))
	zshPath := writeLegacyRC(t, home, ".zshrc", string(zshBefore), 0o640)
	bashPath := writeLegacyRC(t, home, ".bashrc", string(bashBefore), 0o600)

	if err := migrateLegacyCredentials(home); err != nil {
		t.Fatal(err)
	}
	state, err := (&credentialTransaction{home: home}).readManagedCredentialState()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"ANTHROPIC_API_KEY": managedExportLine("ANTHROPIC_API_KEY", "legacy'secret"),
		"OPENAI_API_KEY":    managedExportLine("OPENAI_API_KEY", `legacy"quote\path`),
	}
	if len(state.lines) != len(want) || len(state.receipts) != 0 {
		t.Fatalf("managed state = %#v, receipts = %#v", state.lines, state.receipts)
	}
	for name, line := range want {
		if state.lines[name] != line {
			t.Errorf("managed %s = %q, want %q", name, state.lines[name], line)
		}
	}
	for path, mode := range map[string]os.FileMode{zshPath: 0o640, bashPath: 0o600} {
		data := readTestFile(t, path)
		if strings.Contains(string(data), "ANTHROPIC_API_KEY") || strings.Contains(string(data), "OPENAI_API_KEY") {
			t.Fatalf("%s retained historical exports:\n%s", path, data)
		}
		if !strings.Contains(string(data), `export MANUAL_KEY="keep"`) {
			t.Fatalf("%s lost a manual export:\n%s", path, data)
		}
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("%s mode = %v, %v; want %o", path, info, err, mode)
		}
	}

	storeBefore := readTestFile(t, credentialStorePath(home))
	zshAfter := readTestFile(t, zshPath)
	bashAfter := readTestFile(t, bashPath)
	if err := migrateLegacyCredentials(home); err != nil {
		t.Fatal(err)
	}
	if string(readTestFile(t, credentialStorePath(home))) != string(storeBefore) ||
		string(readTestFile(t, zshPath)) != string(zshAfter) ||
		string(readTestFile(t, bashPath)) != string(bashAfter) {
		t.Fatal("idempotent migration changed persisted files")
	}
}

func TestLegacySidebarMigrationLeavesAmbiguousExportsUserOwned(t *testing.T) {
	useLegacySidebarCatalog(t)
	line := "export ANTHROPIC_API_KEY=\"same\"\n"
	cases := []struct {
		name string
		zsh  string
		bash string
	}{
		{name: "single rc file", zsh: line},
		{name: "different decoded values", zsh: line, bash: "export ANTHROPIC_API_KEY=\"other\"\n"},
		{name: "duplicate in zsh", zsh: line + line, bash: line},
		{name: "duplicate in bash", zsh: line, bash: line + line},
		{name: "unknown metadata", zsh: "export USER_API_KEY=\"same\"\n", bash: "export USER_API_KEY=\"same\"\n"},
		{name: "single quoted", zsh: "export ANTHROPIC_API_KEY='same'\n", bash: "export ANTHROPIC_API_KEY='same'\n"},
		{name: "whitespace variant", zsh: "export ANTHROPIC_API_KEY = \"same\"\n", bash: "export ANTHROPIC_API_KEY = \"same\"\n"},
		{name: "dynamic value", zsh: "export ANTHROPIC_API_KEY=\"$TOKEN\"\n", bash: "export ANTHROPIC_API_KEY=\"$TOKEN\"\n"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			before := map[string]string{}
			if test.zsh != "" {
				writeLegacyRC(t, home, ".zshrc", test.zsh, 0o600)
				before[".zshrc"] = test.zsh
			}
			if test.bash != "" {
				writeLegacyRC(t, home, ".bashrc", test.bash, 0o600)
				before[".bashrc"] = test.bash
			}
			if err := migrateLegacyCredentials(home); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(credentialStorePath(home)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("managed store exists for ambiguous input: %v", err)
			}
			for name, want := range before {
				if got := string(readTestFile(t, filepath.Join(home, name))); got != want {
					t.Fatalf("%s changed: %q, want %q", name, got, want)
				}
			}
		})
	}
}

func TestLegacySidebarMigrationPreservesStorePrecedence(t *testing.T) {
	useLegacySidebarCatalog(t)
	t.Run("matching store value", func(t *testing.T) {
		home := t.TempDir()
		if err := setEnvironmentCredential(home, "ANTHROPIC_API_KEY", "same"); err != nil {
			t.Fatal(err)
		}
		line := "export ANTHROPIC_API_KEY=\"same\"\n"
		zsh := writeLegacyRC(t, home, ".zshrc", line, 0o600)
		bash := writeLegacyRC(t, home, ".bashrc", line, 0o600)
		if err := migrateLegacyCredentials(home); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(readTestFile(t, zsh)), "ANTHROPIC_API_KEY") ||
			strings.Contains(string(readTestFile(t, bash)), "ANTHROPIC_API_KEY") {
			t.Fatal("matching historical pair was not removed")
		}
		state, err := (&credentialTransaction{home: home}).readManagedCredentialState()
		if err != nil {
			t.Fatal(err)
		}
		if state.lines["ANTHROPIC_API_KEY"] != managedExportLine("ANTHROPIC_API_KEY", "same") || len(state.receipts) != 0 {
			t.Fatalf("managed state = %#v, receipts = %#v", state.lines, state.receipts)
		}
	})

	t.Run("conflicting store value", func(t *testing.T) {
		home := t.TempDir()
		if err := setEnvironmentCredential(home, "ANTHROPIC_API_KEY", "managed"); err != nil {
			t.Fatal(err)
		}
		storeBefore := readTestFile(t, credentialStorePath(home))
		line := "export ANTHROPIC_API_KEY=\"shell\"\n"
		zsh := writeLegacyRC(t, home, ".zshrc", line, 0o600)
		bash := writeLegacyRC(t, home, ".bashrc", line, 0o600)
		if err := migrateLegacyCredentials(home); err != nil {
			t.Fatal(err)
		}
		if string(readTestFile(t, zsh)) != line || string(readTestFile(t, bash)) != line {
			t.Fatal("conflicting shell precedence was changed")
		}
		if string(readTestFile(t, credentialStorePath(home))) != string(storeBefore) {
			t.Fatal("conflicting managed value was changed")
		}
	})
}

func TestLegacySidebarMigrationHandlesRCSymlinksSafely(t *testing.T) {
	useLegacySidebarCatalog(t)
	line := "export ANTHROPIC_API_KEY=\"same\"\n"

	t.Run("distinct targets inside home", func(t *testing.T) {
		home := t.TempDir()
		dotfiles := filepath.Join(home, "dotfiles")
		if err := os.Mkdir(dotfiles, 0o700); err != nil {
			t.Fatal(err)
		}
		zshTarget := writeLegacyRC(t, dotfiles, "zshrc", line, 0o600)
		bashTarget := writeLegacyRC(t, dotfiles, "bashrc", line, 0o600)
		if err := os.Symlink(filepath.Join("dotfiles", "zshrc"), filepath.Join(home, ".zshrc")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join("dotfiles", "bashrc"), filepath.Join(home, ".bashrc")); err != nil {
			t.Fatal(err)
		}
		if err := migrateLegacyCredentials(home); err != nil {
			t.Fatal(err)
		}
		if info, err := os.Lstat(filepath.Join(home, ".zshrc")); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("zsh symlink changed: %v, %v", info, err)
		}
		if info, err := os.Lstat(filepath.Join(home, ".bashrc")); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("bash symlink changed: %v, %v", info, err)
		}
		if strings.Contains(string(readTestFile(t, zshTarget)), "ANTHROPIC_API_KEY") ||
			strings.Contains(string(readTestFile(t, bashTarget)), "ANTHROPIC_API_KEY") {
			t.Fatal("safe symlink targets retained the migrated pair")
		}
	})

	t.Run("same target is ambiguous", func(t *testing.T) {
		home := t.TempDir()
		target := writeLegacyRC(t, home, "shared-rc", line, 0o600)
		if err := os.Symlink("shared-rc", filepath.Join(home, ".zshrc")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("shared-rc", filepath.Join(home, ".bashrc")); err != nil {
			t.Fatal(err)
		}
		if err := migrateLegacyCredentials(home); err != nil {
			t.Fatal(err)
		}
		if string(readTestFile(t, target)) != line {
			t.Fatal("one physical rc file was treated as a pair")
		}
		if _, err := os.Stat(credentialStorePath(home)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("managed store exists for one physical rc file: %v", err)
		}
	})

	t.Run("target outside home stays user-owned", func(t *testing.T) {
		home := t.TempDir()
		outsideContent := line + "export MARKED_KEY='kept' # envhaven\n"
		outside := writeLegacyRC(t, t.TempDir(), "zshrc", outsideContent, 0o600)
		if err := os.Symlink(outside, filepath.Join(home, ".zshrc")); err != nil {
			t.Fatal(err)
		}
		writeLegacyRC(t, home, ".bashrc", line, 0o600)
		if err := migrateLegacyCredentials(home); err != nil {
			t.Fatal(err)
		}
		if string(readTestFile(t, outside)) != outsideContent {
			t.Fatal("outside rc target changed")
		}
		if _, err := os.Stat(credentialStorePath(home)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("managed store exists after skipping an unsafe rc: %v", err)
		}
		sources, err := readCredentialSources(home)
		if err != nil {
			t.Fatal(err)
		}
		if source := sources["MARKED_KEY"]; source.managed || !source.manual {
			t.Fatalf("marked export in an rc EnvHaven cannot rewrite = %+v, want manual", source)
		}
	})

	t.Run("dangling rc symlink is ignored", func(t *testing.T) {
		home := t.TempDir()
		if err := os.Symlink(filepath.Join(home, "dotfiles", "bashrc"), filepath.Join(home, ".bashrc")); err != nil {
			t.Fatal(err)
		}
		writeLegacyRC(t, home, ".zshrc", "export MANUAL_KEY='keep'\n", 0o600)
		if _, err := readCredentialSources(home); err != nil {
			t.Fatalf("read with a dangling rc link: %v", err)
		}
		if err := migrateLegacyCredentials(home); err != nil {
			t.Fatalf("startup migration with a dangling rc link: %v", err)
		}
		if err := setEnvironmentCredential(home, "API_KEY", "secret"); err != nil {
			t.Fatalf("set with a dangling rc link: %v", err)
		}
	})
}

func TestLegacySidebarMigrationRecoversAfterInterruption(t *testing.T) {
	useLegacySidebarCatalog(t)
	for _, step := range []string{legacyMigrationStoreStep, ".zshrc", ".bashrc"} {
		t.Run(step, func(t *testing.T) {
			home := t.TempDir()
			line := "export ANTHROPIC_API_KEY=\"interrupt-secret\"\n"
			zsh := writeLegacyRC(t, home, ".zshrc", line, 0o600)
			bash := writeLegacyRC(t, home, ".bashrc", line, 0o600)
			interrupted := errors.New("simulated interruption")
			err := credentialStoreState.withLock(home, func(tx *credentialTransaction) error {
				return tx.migrateLegacyWithOps(legacyMigrationOps{
					rewrite: atomicRewrite,
					pairs:   true,
					afterStep: func(completed string) error {
						if completed == step {
							return interrupted
						}
						return nil
					},
				})
			})
			if !errors.Is(err, interrupted) {
				t.Fatalf("migration error = %v, want interruption", err)
			}
			store := string(readTestFile(t, credentialStorePath(home)))
			if !strings.Contains(store, legacyPairReceiptPrefix+"ANTHROPIC_API_KEY ") ||
				!strings.Contains(store, managedExportLine("ANTHROPIC_API_KEY", "interrupt-secret")) {
				t.Fatalf("durable migration state missing:\n%s", store)
			}

			// Runtime reads and writes leave the pending receipt for the next startup.
			zshBefore, bashBefore := readTestFile(t, zsh), readTestFile(t, bash)
			if _, err := readCredentialSources(home); err != nil {
				t.Fatal(err)
			}
			if err := setEnvironmentCredential(home, "UNRELATED_KEY", "value"); err != nil {
				t.Fatal(err)
			}
			store = string(readTestFile(t, credentialStorePath(home)))
			if !strings.Contains(store, legacyPairReceiptPrefix+"ANTHROPIC_API_KEY ") {
				t.Fatalf("runtime write dropped the pending receipt:\n%s", store)
			}
			if string(readTestFile(t, zsh)) != string(zshBefore) || string(readTestFile(t, bash)) != string(bashBefore) {
				t.Fatal("runtime transaction finished the startup pair migration")
			}

			if err := migrateLegacyCredentials(home); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(readTestFile(t, zsh)), "ANTHROPIC_API_KEY") ||
				strings.Contains(string(readTestFile(t, bash)), "ANTHROPIC_API_KEY") {
				t.Fatal("recovery did not finish both rc rewrites")
			}
			store = string(readTestFile(t, credentialStorePath(home)))
			if strings.Contains(store, legacyPairReceiptPrefix) {
				t.Fatalf("completed migration retained its receipt:\n%s", store)
			}
		})
	}
}

func TestLegacySidebarMigrationRollsBackOrdinaryWriteFailure(t *testing.T) {
	useLegacySidebarCatalog(t)
	home := t.TempDir()
	if err := setEnvironmentCredential(home, "KEEP_KEY", "keep"); err != nil {
		t.Fatal(err)
	}
	storeBefore := readTestFile(t, credentialStorePath(home))
	line := "export ANTHROPIC_API_KEY=\"rollback-secret\"\n"
	zsh := writeLegacyRC(t, home, ".zshrc", line, 0o640)
	bash := writeLegacyRC(t, home, ".bashrc", line, 0o600)
	injected := errors.New("injected rc write failure")
	rewrites := 0
	err := credentialStoreState.withLock(home, func(tx *credentialTransaction) error {
		return tx.migrateLegacyWithOps(legacyMigrationOps{
			pairs: true,
			rewrite: func(path string, data []byte) error {
				rewrites++
				if rewrites == 2 {
					return injected
				}
				return atomicRewrite(path, data)
			},
		})
	})
	if !errors.Is(err, injected) {
		t.Fatalf("migration error = %v, want injected failure", err)
	}
	if string(readTestFile(t, credentialStorePath(home))) != string(storeBefore) {
		t.Fatal("managed store was not rolled back")
	}
	for path, mode := range map[string]os.FileMode{zsh: 0o640, bash: 0o600} {
		if string(readTestFile(t, path)) != line {
			t.Fatalf("%s was not rolled back", path)
		}
		info, statErr := os.Stat(path)
		if statErr != nil || info.Mode().Perm() != mode {
			t.Fatalf("%s mode = %v, %v; want %o", path, info, statErr, mode)
		}
	}
}

func TestLegacySidebarMigrationRetainsStoreWhenRCRollbackFails(t *testing.T) {
	useLegacySidebarCatalog(t)
	home := t.TempDir()
	line := "export ANTHROPIC_API_KEY=\"recovery-secret\"\n"
	zsh := writeLegacyRC(t, home, ".zshrc", line, 0o600)
	bash := writeLegacyRC(t, home, ".bashrc", line, 0o600)
	injected := errors.New("injected rc write failure")
	rewrites := 0
	err := credentialStoreState.withLock(home, func(tx *credentialTransaction) error {
		return tx.migrateLegacyWithOps(legacyMigrationOps{
			pairs: true,
			rewrite: func(path string, data []byte) error {
				rewrites++
				if rewrites == 1 {
					return atomicRewrite(path, data)
				}
				if err := os.Remove(zsh); err != nil {
					return err
				}
				if err := os.Mkdir(zsh, 0o700); err != nil {
					return err
				}
				return injected
			},
		})
	})
	if !errors.Is(err, injected) || !strings.Contains(err.Error(), "restore .zshrc") {
		t.Fatalf("migration error = %v, want write and rollback failures", err)
	}
	store := string(readTestFile(t, credentialStorePath(home)))
	if !strings.Contains(store, managedExportLine("ANTHROPIC_API_KEY", "recovery-secret")) ||
		!strings.Contains(store, legacyPairReceiptPrefix+"ANTHROPIC_API_KEY ") {
		t.Fatalf("managed recovery state was rolled back after rc restore failed:\n%s", store)
	}
	if string(readTestFile(t, bash)) != line {
		t.Fatal("restorable rc file was not rolled back")
	}

	if err := os.RemoveAll(zsh); err != nil {
		t.Fatal(err)
	}
	if err := migrateLegacyCredentials(home); err != nil {
		t.Fatal(err)
	}
	store = string(readTestFile(t, credentialStorePath(home)))
	if strings.Contains(store, legacyPairReceiptPrefix) || strings.Contains(string(readTestFile(t, bash)), "ANTHROPIC_API_KEY") {
		t.Fatalf("recovery did not finish after the rc path was repaired:\n%s", store)
	}
}

func TestRuntimeTransactionsLeaveUnmarkedPairsToStartup(t *testing.T) {
	useLegacySidebarCatalog(t)
	home := t.TempDir()
	line := "export OPENAI_API_KEY=\"sk-user\"\n"
	zsh := writeLegacyRC(t, home, ".zshrc", "alias ll='ls -l'\n"+line, 0o600)
	bash := writeLegacyRC(t, home, ".bashrc", line, 0o600)
	zshBefore, bashBefore := readTestFile(t, zsh), readTestFile(t, bash)

	sources, err := readCredentialSources(home)
	if err != nil {
		t.Fatal(err)
	}
	if source := sources["OPENAI_API_KEY"]; source.managed || !source.manual {
		t.Fatalf("runtime pair reads as %+v, want the user's export", source)
	}
	if err := setEnvironmentCredential(home, "UNRELATED_KEY", "value"); err != nil {
		t.Fatal(err)
	}
	if string(readTestFile(t, zsh)) != string(zshBefore) || string(readTestFile(t, bash)) != string(bashBefore) {
		t.Fatal("a runtime transaction migrated an unmarked pair")
	}
	if strings.Contains(string(readTestFile(t, credentialStorePath(home))), "OPENAI_API_KEY") {
		t.Fatal("a runtime transaction moved an unmarked pair into the store")
	}

	if err := migrateLegacyCredentials(home); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(readTestFile(t, zsh)), "OPENAI_API_KEY") || strings.Contains(string(readTestFile(t, bash)), "OPENAI_API_KEY") {
		t.Fatal("startup migration no longer moves the original sidebar pair")
	}
	if !strings.Contains(string(readTestFile(t, credentialStorePath(home))), managedExportLine("OPENAI_API_KEY", "sk-user")) {
		t.Fatal("startup migration did not store the original sidebar pair")
	}
}

func TestCredentialReadsNeverWrite(t *testing.T) {
	useLegacySidebarCatalog(t)
	home := t.TempDir()
	if err := setEnvironmentCredential(home, "STORED_KEY", "stored"); err != nil {
		t.Fatal(err)
	}
	pair := "export ANTHROPIC_API_KEY=\"pair\"\n"
	zsh := writeLegacyRC(t, home, ".zshrc", pair+"export MARKED_KEY='marked' # envhaven\n", 0o600)
	bash := writeLegacyRC(t, home, ".bashrc", pair, 0o600)
	paths := []string{credentialStorePath(home), zsh, bash}
	before := map[string]string{}
	for _, path := range paths {
		before[path] = string(readTestFile(t, path))
	}

	sources, err := readCredentialSources(home)
	if err != nil {
		t.Fatal(err)
	}
	if !sources["STORED_KEY"].managed || !sources["MARKED_KEY"].managed || sources["MARKED_KEY"].manual {
		t.Fatalf("sources = %+v, want the store and the marked export managed", sources)
	}
	if source := sources["ANTHROPIC_API_KEY"]; source.managed || !source.manual {
		t.Fatalf("unmarked pair = %+v, want manual until startup migrates it", source)
	}
	for _, path := range paths {
		if got := string(readTestFile(t, path)); got != before[path] {
			t.Fatalf("read changed %s:\n%s", path, got)
		}
	}
}
