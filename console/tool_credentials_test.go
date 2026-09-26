package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// TestMain points tmux at an empty socket directory for the whole package: removing
// a credential unsets it in the tmux global environment, and no test may reach the
// developer's own tmux server.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "console-test-tmux-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Unsetenv("TMUX")
	os.Unsetenv("TMUX_PANE")
	os.Setenv("TMUX_TMPDIR", dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func cleanupTestTool(home string, tool *toolDef, envVars []string) error {
	return credentialStoreState.transaction(home, func(tx *credentialTransaction) error {
		_, err := cleanupToolCredentials(context.Background(), tx, tool, envVars)
		return err
	})
}

func TestLegacyCredentialMigration(t *testing.T) {
	home := t.TempDir()
	zsh := "export MANUAL_KEY='keep'\nexport ALPHA_KEY='one' # envhaven\n"
	bash := "export ALPHA_KEY='one' # envhaven\nexport BETA_KEY='two' # envhaven\n"
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte(zsh), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte(bash), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyCredentials(home); err != nil {
		t.Fatal(err)
	}
	storePath := credentialStorePath(home)
	store, err := os.ReadFile(storePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(store), "export ALPHA_KEY='one'") != 1 || !strings.Contains(string(store), "export BETA_KEY='two'") {
		t.Fatalf("migrated store =\n%s", store)
	}
	if info, err := os.Stat(storePath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("store mode = %v, %v; want 0600", info, err)
	}
	for _, rc := range rcFiles {
		data, err := os.ReadFile(filepath.Join(home, rc))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), legacyManagedMarker) {
			t.Fatalf("%s retained a legacy managed line:\n%s", rc, data)
		}
	}
	updatedZsh, err := os.ReadFile(filepath.Join(home, ".zshrc"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(updatedZsh), "export MANUAL_KEY='keep'") {
		t.Fatalf("manual export was not preserved:\n%s", updatedZsh)
	}

	before := string(store)
	if err := migrateLegacyCredentials(home); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(storePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != before {
		t.Fatalf("idempotent migration changed the store:\n%s", after)
	}
}

func TestConcurrentCredentialStoreUpdatesDoNotLoseKeys(t *testing.T) {
	home := t.TempDir()
	const updates = 32
	errors := make(chan error, updates)
	var writers sync.WaitGroup
	for i := range updates {
		writers.Add(1)
		go func() {
			defer writers.Done()
			name := fmt.Sprintf("KEY_%02d", i)
			errors <- setEnvironmentCredential(home, name, name+"-value")
		}()
	}
	writers.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	sources, err := readCredentialSources(home)
	if err != nil {
		t.Fatal(err)
	}
	for i := range updates {
		name := fmt.Sprintf("KEY_%02d", i)
		if !sources[name].managed {
			t.Fatalf("concurrent update lost %s", name)
		}
	}
}

func writeManagedStore(t *testing.T, home, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(home, ".config", "envhaven"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(credentialStorePath(home), []byte(credentialStoreHeader+"\n"+body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestManagedStoreRepeatedNameResolvesToLastLine(t *testing.T) {
	home := t.TempDir()
	writeManagedStore(t, home, "export OPENAI_API_KEY='old'\nexport OPENAI_API_KEY='new'\n")
	sources, err := readCredentialSources(home)
	if err != nil {
		t.Fatal(err)
	}
	if !sources["OPENAI_API_KEY"].managed {
		t.Fatalf("sources = %+v, want the rotated key managed", sources)
	}
	if err := setEnvironmentCredential(home, "OTHER_KEY", "value"); err != nil {
		t.Fatal(err)
	}
	store := string(readTestFile(t, credentialStorePath(home)))
	if strings.Count(store, "export OPENAI_API_KEY=") != 1 || !strings.Contains(store, "export OPENAI_API_KEY='new'") {
		t.Fatalf("store = %q, want one OPENAI_API_KEY line carrying the last value", store)
	}
}

func TestManagedStoreRefusesLinesItNeverWrites(t *testing.T) {
	for name, line := range map[string]string{
		"indented export": "  export OPENAI_API_KEY='sk-indented'\n",
		"bare assignment": "OPENAI_API_KEY='sk-bare'\n",
	} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			writeManagedStore(t, home, line)
			before := readTestFile(t, credentialStorePath(home))
			var storeErr *credentialStoreError
			if _, err := readCredentialSources(home); !errors.As(err, &storeErr) || !strings.Contains(err.Error(), "line 2") {
				t.Fatalf("read error = %v, want a store error naming line 2", err)
			}
			if err := setEnvironmentCredential(home, "OTHER_KEY", "value"); !errors.As(err, &storeErr) {
				t.Fatalf("set error = %v, want the store error", err)
			}
			if string(readTestFile(t, credentialStorePath(home))) != string(before) {
				t.Fatal("a refused store was rewritten")
			}
		})
	}
}

func TestLegacyCredentialMigrationLeavesDifferentValuesUntouched(t *testing.T) {
	home := t.TempDir()
	zshPath := filepath.Join(home, ".zshrc")
	bashPath := filepath.Join(home, ".bashrc")
	zsh := []byte("export API_KEY='one' # envhaven\n")
	bash := []byte("export API_KEY='two' # envhaven\n")
	if err := os.WriteFile(zshPath, zsh, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bashPath, bash, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyCredentials(home); err != nil {
		t.Fatalf("migration error = %v, want mismatched values left untouched", err)
	}
	if _, err := os.Stat(credentialStorePath(home)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("store exists after skipping a mismatched name: %v", err)
	}
	for path, want := range map[string][]byte{zshPath: zsh, bashPath: bash} {
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(want) {
			t.Fatalf("%s changed after skipping a mismatched name: %q", path, got)
		}
	}
	sources, err := readCredentialSources(home)
	if err != nil {
		t.Fatal(err)
	}
	if source := sources["API_KEY"]; source.managed || !source.manual {
		t.Fatalf("mismatched marked exports = %+v, want the user's", source)
	}
}

func TestLegacyCredentialMigrationLeavesStoreConflictUntouched(t *testing.T) {
	home := t.TempDir()
	if err := setEnvironmentCredential(home, "API_KEY", "current"); err != nil {
		t.Fatal(err)
	}
	storeBefore, err := os.ReadFile(credentialStorePath(home))
	if err != nil {
		t.Fatal(err)
	}
	rcPath := filepath.Join(home, ".zshrc")
	rcBefore := []byte("export API_KEY='legacy' # envhaven\n")
	if err := os.WriteFile(rcPath, rcBefore, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyCredentials(home); err != nil {
		t.Fatalf("migration error = %v, want the store conflict left untouched", err)
	}
	storeAfter, err := os.ReadFile(credentialStorePath(home))
	if err != nil {
		t.Fatal(err)
	}
	rcAfter, err := os.ReadFile(rcPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(storeAfter) != string(storeBefore) || string(rcAfter) != string(rcBefore) {
		t.Fatal("conflicting store or rc value changed")
	}
	sources, err := readCredentialSources(home)
	if err != nil {
		t.Fatal(err)
	}
	if source := sources["API_KEY"]; !source.managed || !source.manual {
		t.Fatalf("store conflict = %+v, want the store managed and the rc export the user's", source)
	}
}

func TestLegacyCredentialMigrationMovesConsistentNamesBesideAConflict(t *testing.T) {
	home := t.TempDir()
	zshPath := filepath.Join(home, ".zshrc")
	bashPath := filepath.Join(home, ".bashrc")
	zsh := "export API_KEY='one' # envhaven\nexport OTHER_KEY='same' # envhaven\n"
	bash := "export API_KEY='two' # envhaven\nexport OTHER_KEY='same' # envhaven\n"
	if err := os.WriteFile(zshPath, []byte(zsh), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bashPath, []byte(bash), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyCredentials(home); err != nil {
		t.Fatal(err)
	}
	store, err := os.ReadFile(credentialStorePath(home))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(store), "export OTHER_KEY='same'") || strings.Contains(string(store), "export API_KEY") {
		t.Fatalf("store = %q, want only the consistent name", store)
	}
	for path, want := range map[string]string{zshPath: "export API_KEY='one' # envhaven\n", bashPath: "export API_KEY='two' # envhaven\n"} {
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Fatalf("%s = %q, want only the mismatched line left", path, got)
		}
	}
}

func TestToolSetupFailureRollsBackCredentialStore(t *testing.T) {
	t.Run("restores existing store", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		if err := setEnvironmentCredential(home, "KEEP_KEY", "keep"); err != nil {
			t.Fatal(err)
		}
		before, err := os.ReadFile(credentialStorePath(home))
		if err != nil {
			t.Fatal(err)
		}
		script := failingSetupScript(t, home)
		tool := &toolDef{SetKeyCommand: []string{script}}
		if err := setToolCredential(context.Background(), home, tool, "NEW_KEY", "new secret"); err == nil {
			t.Fatal("setup failure was suppressed")
		}
		after, err := os.ReadFile(credentialStorePath(home))
		if err != nil {
			t.Fatal(err)
		}
		if string(after) != string(before) {
			t.Fatalf("store was not rolled back:\n%s", after)
		}
		assertSetupReceivedKey(t, home)
	})

	t.Run("restores absent store", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		script := failingSetupScript(t, home)
		tool := &toolDef{SetKeyCommand: []string{script}}
		if err := setToolCredential(context.Background(), home, tool, "NEW_KEY", "new secret"); err == nil {
			t.Fatal("setup failure was suppressed")
		}
		if _, err := os.Stat(credentialStorePath(home)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("credential store remains after rollback: %v", err)
		}
		assertSetupReceivedKey(t, home)
	})
}

func failingSetupScript(t *testing.T, home string) string {
	t.Helper()
	script := filepath.Join(home, "failing-setup")
	contents := "#!/bin/sh\nIFS= read -r key\nprintf %s \"$key\" >\"$HOME/setup-key\"\nexit 7\n"
	if err := os.WriteFile(script, []byte(contents), 0o700); err != nil {
		t.Fatal(err)
	}
	return script
}

func assertSetupReceivedKey(t *testing.T, home string) {
	t.Helper()
	key, err := os.ReadFile(filepath.Join(home, "setup-key"))
	if err != nil {
		t.Fatal(err)
	}
	if string(key) != "new secret" {
		t.Fatalf("setup stdin = %q, want exact key", key)
	}
}

func TestDirectLogoutFailurePreservesLocalCredentials(t *testing.T) {
	home := t.TempDir()
	t.Setenv("VENDOR_TEST_KEY", "")
	if err := setEnvironmentCredential(home, "VENDOR_TEST_KEY", "keep"); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(home, "logout-fails")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 9\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	tool := &toolDef{ID: "vendor", Name: "Vendor", EnvVars: []string{"VENDOR_TEST_KEY"}, LogoutCommand: []string{script}}
	instruction, conflicts, err := signOutTool(context.Background(), home, tool, []toolDef{*tool})
	if err == nil || instruction != "" || len(conflicts) != 0 {
		t.Fatalf("sign-out = (%q, %+v, %v), want vendor error before cleanup", instruction, conflicts, err)
	}
	store, err := os.ReadFile(credentialStorePath(home))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(store), "VENDOR_TEST_KEY") {
		t.Fatalf("local credential was removed after vendor failure:\n%s", store)
	}
}

func TestDirectLogoutReportsCleanupAfterVendorSuccess(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("VENDOR_TEST_KEY", "")
	if err := setEnvironmentCredential(home, "VENDOR_TEST_KEY", "remove"); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	credential := filepath.Join(outside, "credentials.json")
	if err := os.WriteFile(credential, []byte(`{"token":"keep"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(home, ".vendor")); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(home, "vendor-logout-ran")
	script := filepath.Join(home, "logout-succeeds")
	if err := os.WriteFile(script, []byte("#!/bin/sh\n: >\"$HOME/vendor-logout-ran\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	tool := &toolDef{
		ID:            "vendor",
		Name:          "Vendor",
		EnvVars:       []string{"VENDOR_TEST_KEY"},
		AuthFiles:     []string{".vendor/credentials.json"},
		LogoutCommand: []string{script},
	}
	instruction, conflicts, err := signOutTool(context.Background(), home, tool, []toolDef{*tool})
	if err == nil || len(conflicts) != 0 || !strings.Contains(instruction, "Vendor logout completed") {
		t.Fatalf("sign-out = (%q, %+v, %v), want explicit post-vendor cleanup failure", instruction, conflicts, err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("vendor logout did not run: %v", err)
	}
	if _, err := os.Stat(credential); err != nil {
		t.Fatalf("outside credential was changed: %v", err)
	}
	store, err := os.ReadFile(credentialStorePath(home))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(store), "VENDOR_TEST_KEY") {
		t.Fatalf("managed cleanup did not reach the explicitly reported partial state:\n%s", store)
	}
}

func TestAntigravityCleanupRemovesOnlyEnvHavenProviderMode(t *testing.T) {
	writeSettings := func(t *testing.T, home, settings string, owned bool) string {
		t.Helper()
		dir := filepath.Join(home, ".gemini", "antigravity-cli")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, "settings.json")
		if err := os.WriteFile(path, []byte(settings), 0o600); err != nil {
			t.Fatal(err)
		}
		if owned {
			if err := os.WriteFile(filepath.Join(dir, ".model-provider.envhaven"), []byte("gemini\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return path
	}

	t.Run("owned Gemini mode", func(t *testing.T) {
		home := t.TempDir()
		path := writeSettings(t, home, `{"modelProvider":"gemini","theme":"dark"}`, true)
		if err := setEnvironmentCredential(home, "GEMINI_API_KEY", "secret"); err != nil {
			t.Fatal(err)
		}
		tool := &toolDef{ID: "antigravity", EnvVars: []string{"GEMINI_API_KEY"}}
		if err := cleanupTestTool(home, tool, tool.EnvVars); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "modelProvider") || !strings.Contains(string(data), `"theme": "dark"`) {
			t.Fatalf("settings were not selectively cleaned:\n%s", data)
		}
		if fileExists(filepath.Join(home, antigravityProviderMarkerRel)) {
			t.Fatal("EnvHaven provider marker remains")
		}
		managed, err := os.ReadFile(credentialStorePath(home))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(managed), "GEMINI_API_KEY") {
			t.Fatalf("managed key remains:\n%s", managed)
		}
	})

	t.Run("user-owned Gemini mode", func(t *testing.T) {
		home := t.TempDir()
		path := writeSettings(t, home, `{"modelProvider":"gemini","theme":"dark"}`, false)
		tool := &toolDef{ID: "antigravity", EnvVars: []string{"GEMINI_API_KEY"}}
		if err := cleanupTestTool(home, tool, tool.EnvVars); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), `"modelProvider":"gemini"`) {
			t.Fatalf("user-owned provider was removed:\n%s", data)
		}
	})

	t.Run("user changed provider after preparation", func(t *testing.T) {
		home := t.TempDir()
		path := writeSettings(t, home, `{"modelProvider":"other","theme":"dark"}`, true)
		tool := &toolDef{ID: "antigravity", EnvVars: []string{"GEMINI_API_KEY"}}
		if err := cleanupTestTool(home, tool, tool.EnvVars); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), `"modelProvider":"other"`) {
			t.Fatalf("changed provider was removed:\n%s", data)
		}
		if fileExists(filepath.Join(home, antigravityProviderMarkerRel)) {
			t.Fatal("stale EnvHaven provider marker remains")
		}
	})
}

func TestDeleteGeminiCredentialCleansOnlyTheFinalManagedSource(t *testing.T) {
	writeOwnedProvider := func(t *testing.T, home string) string {
		t.Helper()
		dir := filepath.Join(home, ".gemini", "antigravity-cli")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		settings := filepath.Join(dir, "settings.json")
		if err := os.WriteFile(settings, []byte(`{"modelProvider":"gemini","theme":"dark"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ".model-provider.envhaven"), []byte("gemini\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return settings
	}

	t.Run("final managed source", func(t *testing.T) {
		home := t.TempDir()
		settings := writeOwnedProvider(t, home)
		if err := setEnvironmentCredential(home, "GEMINI_API_KEY", "secret"); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GEMINI_API_KEY", "")
		if err := deleteEnvironmentCredential(home, "GEMINI_API_KEY"); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(settings)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "modelProvider") || fileExists(filepath.Join(home, antigravityProviderMarkerRel)) {
			t.Fatalf("owned provider state remains: %s", data)
		}
	})

	t.Run("process source remains", func(t *testing.T) {
		home := t.TempDir()
		settings := writeOwnedProvider(t, home)
		if err := setEnvironmentCredential(home, "GEMINI_API_KEY", "secret"); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GEMINI_API_KEY", "process-secret")
		if err := deleteEnvironmentCredential(home, "GEMINI_API_KEY"); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(settings)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "modelProvider") || !fileExists(filepath.Join(home, antigravityProviderMarkerRel)) {
			t.Fatal("provider state was removed while a process credential remained")
		}
	})

	t.Run("manual shell source remains", func(t *testing.T) {
		home := t.TempDir()
		settings := writeOwnedProvider(t, home)
		if err := setEnvironmentCredential(home, "GEMINI_API_KEY", "managed-secret"); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte("export GEMINI_API_KEY='manual-secret'\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GEMINI_API_KEY", "")
		if err := deleteEnvironmentCredential(home, "GEMINI_API_KEY"); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(settings)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "modelProvider") || !fileExists(filepath.Join(home, antigravityProviderMarkerRel)) {
			t.Fatal("provider state was removed while a manual credential remained")
		}
	})

	t.Run("cleanup failure preserves managed key", func(t *testing.T) {
		home := t.TempDir()
		if err := setEnvironmentCredential(home, "GEMINI_API_KEY", "secret"); err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(home, ".gemini", "antigravity-cli")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "marker")
		if err := os.WriteFile(outside, []byte("gemini\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(dir, ".model-provider.envhaven")); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GEMINI_API_KEY", "")
		if err := deleteEnvironmentCredential(home, "GEMINI_API_KEY"); err == nil {
			t.Fatal("unsafe provider marker was accepted")
		}
		store, err := os.ReadFile(credentialStorePath(home))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(store), "GEMINI_API_KEY") {
			t.Fatal("managed key was removed before provider cleanup succeeded")
		}
	})
}

func TestManagedStoreRefusesDirectorySymlinkOutsideHome(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(home, ".config")); err != nil {
		t.Fatal(err)
	}
	if err := setEnvironmentCredential(home, "API_KEY", "secret"); err == nil {
		t.Fatal("managed store followed .config outside HOME")
	}
	if _, err := os.Stat(filepath.Join(outside, "envhaven", "environment")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("credential was written outside HOME: %v", err)
	}
}

func TestVendorSettingsFollowSymlinksInsideHome(t *testing.T) {
	linkInto := func(t *testing.T, target, link, contents string) {
		t.Helper()
		for _, dir := range []string{filepath.Dir(target), filepath.Dir(link)} {
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(target, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	assertLink := func(t *testing.T, link string) {
		t.Helper()
		if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("%s is no longer a symlink: %v, %v", link, info, err)
		}
	}

	t.Run("Antigravity settings inside home", func(t *testing.T) {
		home := t.TempDir()
		dir := filepath.Join(home, ".gemini", "antigravity-cli")
		target := filepath.Join(home, "dotfiles", "agy-settings.json")
		link := filepath.Join(dir, "settings.json")
		linkInto(t, target, link, `{"modelProvider":"gemini","theme":"dark"}`)
		if err := os.WriteFile(filepath.Join(dir, ".model-provider.envhaven"), []byte("gemini\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := setEnvironmentCredential(home, "GEMINI_API_KEY", "secret"); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GEMINI_API_KEY", "")
		if err := deleteEnvironmentCredential(home, "GEMINI_API_KEY"); err != nil {
			t.Fatal(err)
		}
		assertLink(t, link)
		data := string(readTestFile(t, target))
		if strings.Contains(data, "modelProvider") || !strings.Contains(data, `"theme": "dark"`) {
			t.Fatalf("link target was not selectively cleaned:\n%s", data)
		}
		if fileExists(filepath.Join(dir, ".model-provider.envhaven")) {
			t.Fatal("EnvHaven provider marker remains")
		}
		if strings.Contains(string(readTestFile(t, credentialStorePath(home))), "GEMINI_API_KEY") {
			t.Fatal("managed key remains")
		}
	})

	t.Run("Antigravity settings outside home stay refused", func(t *testing.T) {
		home := t.TempDir()
		dir := filepath.Join(home, ".gemini", "antigravity-cli")
		target := filepath.Join(t.TempDir(), "agy-settings.json")
		const settings = `{"modelProvider":"gemini"}`
		linkInto(t, target, filepath.Join(dir, "settings.json"), settings)
		if err := os.WriteFile(filepath.Join(dir, ".model-provider.envhaven"), []byte("gemini\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := setEnvironmentCredential(home, "GEMINI_API_KEY", "secret"); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GEMINI_API_KEY", "")
		if err := deleteEnvironmentCredential(home, "GEMINI_API_KEY"); !errors.Is(err, errUnsafeHomeFile) {
			t.Fatalf("delete error = %v, want the outside settings refused", err)
		}
		if string(readTestFile(t, target)) != settings {
			t.Fatal("settings outside home changed")
		}
		if !strings.Contains(string(readTestFile(t, credentialStorePath(home))), "GEMINI_API_KEY") {
			t.Fatal("managed key was removed before provider cleanup succeeded")
		}
	})

	t.Run("Qwen settings and dotenv inside home", func(t *testing.T) {
		home := t.TempDir()
		settingsTarget := filepath.Join(home, "dotfiles", "qwen-settings.json")
		envTarget := filepath.Join(home, "dotfiles", "qwen.env")
		settingsLink := filepath.Join(home, ".qwen", "settings.json")
		envLink := filepath.Join(home, ".qwen", ".env")
		const selection = `{"security":{"auth":{"selectedType":"openai"}},"model":{"name":"qwen"},` +
			`"modelProviders":{"openai":[{"id":"qwen","envKey":"DASHSCOPE_API_KEY"}]},`
		linkInto(t, settingsTarget, settingsLink, selection+`"env":{"OTHER_KEY":"keep"}}`)
		linkInto(t, envTarget, envLink, "DASHSCOPE_API_KEY=dotenv-secret\nOTHER=value\n")
		t.Setenv("DASHSCOPE_API_KEY", "")
		t.Setenv("OPENAI_API_KEY", "")
		def := toolDef{ID: "qwen", Name: "Qwen Code", EnvVars: []string{"OPENAI_API_KEY"}, AuthCheck: "qwen"}

		if got := checkAuth(def, home, credentialSources{}); got.status != "ready" || got.via == nil || *got.via != "qwen/.env" {
			t.Fatalf("Qwen auth through linked settings and dotenv = %+v, want ready via qwen/.env", got)
		}
		if err := os.WriteFile(settingsTarget, []byte(selection+`"env":{"DASHSCOPE_API_KEY":"settings-secret","OTHER_KEY":"keep"}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if envVars, err := toolCredentialEnvVars(home, &def); err != nil || !reflect.DeepEqual(envVars, []string{"DASHSCOPE_API_KEY"}) {
			t.Fatalf("Qwen credential = %v, %v; want DASHSCOPE_API_KEY", envVars, err)
		}
		if _, conflicts, err := signOutTool(context.Background(), home, &def, []toolDef{def}); err != nil || len(conflicts) != 0 {
			t.Fatalf("sign-out = (%+v, %v), want success", conflicts, err)
		}
		assertLink(t, settingsLink)
		assertLink(t, envLink)
		if settings := string(readTestFile(t, settingsTarget)); strings.Contains(settings, "settings-secret") || !strings.Contains(settings, "OTHER_KEY") {
			t.Fatalf("settings target was not selectively cleaned:\n%s", settings)
		}
		if env := string(readTestFile(t, envTarget)); strings.Contains(env, "DASHSCOPE_API_KEY") || !strings.Contains(env, "OTHER=value") {
			t.Fatalf("dotenv target was not selectively cleaned:\n%s", env)
		}
		if got := checkAuth(def, home, credentialSources{}); got.status != "needs-auth" {
			t.Fatalf("Qwen auth after sign-out = %q, want needs-auth", got.status)
		}
	})
}

func TestCredentialRemovalUnsetsTmuxGlobalEnvironment(t *testing.T) {
	home := t.TempDir()
	for _, name := range []string{"FIRST_KEY", "SECOND_KEY", "PROCESS_KEY", "KEPT_KEY"} {
		if err := setEnvironmentCredential(home, name, "secret"); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("FIRST_KEY", "")
	t.Setenv("SECOND_KEY", "")
	t.Setenv("KEPT_KEY", "")
	t.Setenv("PROCESS_KEY", "from-the-workspace-configuration")
	var calls [][]string
	previous := executeTmux
	executeTmux = func(_ context.Context, args ...string) (string, error) {
		calls = append(calls, args)
		return "", errors.New("no server running")
	}
	t.Cleanup(func() { executeTmux = previous })
	unset := func(name string) []string { return []string{"set-environment", "-g", "-u", name} }

	err := credentialStoreState.transaction(home, func(tx *credentialTransaction) error {
		return tx.remove([]string{"FIRST_KEY", "ABSENT_KEY", "SECOND_KEY", "PROCESS_KEY"})
	})
	if err != nil {
		t.Fatalf("remove = %v, want tmux failures ignored", err)
	}
	if want := [][]string{unset("FIRST_KEY"), unset("SECOND_KEY")}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("tmux calls = %q, want %q", calls, want)
	}
	store := string(readTestFile(t, credentialStorePath(home)))
	if strings.Contains(store, "FIRST_KEY") || strings.Contains(store, "SECOND_KEY") || strings.Contains(store, "PROCESS_KEY") || !strings.Contains(store, "KEPT_KEY") {
		t.Fatalf("store after removal:\n%s", store)
	}

	calls = nil
	if err := deleteEnvironmentCredential(home, "KEPT_KEY"); err != nil {
		t.Fatal(err)
	}
	if err := deleteEnvironmentCredential(home, "KEPT_KEY"); err != nil {
		t.Fatal(err)
	}
	if want := [][]string{unset("KEPT_KEY")}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("Environment delete tmux calls = %q, want %q", calls, want)
	}
}
