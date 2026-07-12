package engine

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"

	"github.com/raman-0O7/baton/internal/mcptrans"
	"github.com/raman-0O7/baton/internal/model"
	"github.com/raman-0O7/baton/internal/scrub"
)

// mcpRepoPath is the canonical MCP server list in the sync repo.
const mcpRepoPath = "mcp/servers.toml"

// secretsPath is the device-local secrets store (never synced; the sync
// repo lives elsewhere entirely, but keep it 0600 regardless).
func secretsPath() (string, error) {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "baton", "secrets.toml"), nil
}

func loadSecrets() (map[string]string, error) {
	p, err := secretsPath()
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	if _, err := toml.DecodeFile(p, &out); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return out, nil
		}
		return nil, err
	}
	return out, nil
}

func saveSecrets(secrets map[string]string) error {
	p, err := secretsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(p+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := toml.NewEncoder(f).Encode(secrets); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}

// MCPImport parses an agent-native MCP config, externalizes its secrets
// into the local store (SR-2), merges the servers into the canonical list
// (by name — imported entries win), commits, and pushes.
func (e *Engine) MCPImport(agent, configPath string) (added int, err error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return 0, err
	}
	incoming, err := mcptrans.ParseAgent(agent, data)
	if err != nil {
		return 0, err
	}
	stripped, refs := mcptrans.Strip(incoming)

	if len(refs) > 0 {
		secrets, err := loadSecrets()
		if err != nil {
			return 0, err
		}
		for _, r := range refs {
			secrets[r.Name] = r.Value
		}
		if err := saveSecrets(secrets); err != nil {
			return 0, err
		}
	}

	current, err := e.mcpCanonical()
	if err != nil {
		return 0, err
	}
	byName := map[string]model.MCPServer{}
	for _, s := range current {
		byName[s.Name] = s
	}
	for _, s := range stripped {
		byName[s.Name] = s
	}
	merged := make([]model.MCPServer, 0, len(byName))
	for _, s := range byName {
		merged = append(merged, s)
	}

	doc, err := mcptrans.EmitCanonical(merged)
	if err != nil {
		return 0, err
	}
	res, err := scrub.Scrub(doc, scrub.Policy{})
	if err != nil {
		return 0, err
	}
	if err := e.Store.StageArtifact(mcpRepoPath, res); err != nil {
		return 0, err
	}
	if _, err := e.Store.Commit(fmt.Sprintf("mcp: import %s config from %s", agent, e.Cfg.DeviceID)); err != nil {
		return 0, err
	}
	if _, err := e.pushBestEffort(); err != nil {
		return 0, err
	}
	return len(stripped), nil
}

// MCPEmit renders the canonical server list in an agent's native syntax,
// resolving secret placeholders from the local store. Unresolvable
// placeholders stay in place and are returned so the user can add them on
// this device.
func (e *Engine) MCPEmit(agent string) (data []byte, missing []string, err error) {
	servers, err := e.mcpCanonical()
	if err != nil {
		return nil, nil, err
	}
	secrets, err := loadSecrets()
	if err != nil {
		return nil, nil, err
	}
	resolved, missing := mcptrans.Resolve(servers, secrets)
	data, err = mcptrans.EmitAgent(agent, resolved)
	return data, missing, err
}

func (e *Engine) mcpCanonical() ([]model.MCPServer, error) {
	data, err := e.Store.ReadArtifact(mcpRepoPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return mcptrans.ParseCanonical(data)
}
