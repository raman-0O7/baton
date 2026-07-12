package mcptrans

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/BurntSushi/toml"

	"github.com/raman-0O7/baton/internal/model"
)

// --- claudecode: {"mcpServers": {name: {command, args, env, type, url, headers}}}

type claudeServer struct {
	Type    string            `json:"type,omitempty"` // "stdio" (default), "http", "sse"
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

type claudeFile struct {
	MCPServers map[string]claudeServer `json:"mcpServers"`
}

func parseClaude(data []byte) ([]model.MCPServer, error) {
	var f claudeFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("mcptrans: parse claudecode config: %w", err)
	}
	var out []model.MCPServer
	for name, s := range f.MCPServers {
		transport := model.MCPTransport(s.Type)
		if s.Type == "" {
			transport = model.MCPStdio
			if s.URL != "" {
				transport = model.MCPHTTP
			}
		}
		out = append(out, model.MCPServer{
			Name: name, Transport: transport,
			Command: s.Command, Args: s.Args, Env: s.Env,
			URL: s.URL, Headers: s.Headers,
		})
	}
	return sortServers(out), nil
}

func emitClaude(servers []model.MCPServer) ([]byte, error) {
	f := claudeFile{MCPServers: map[string]claudeServer{}}
	for _, s := range servers {
		cs := claudeServer{
			Command: s.Command, Args: s.Args, Env: s.Env,
			URL: s.URL, Headers: s.Headers,
		}
		if s.Transport != model.MCPStdio {
			cs.Type = string(s.Transport)
		}
		f.MCPServers[s.Name] = cs
	}
	return marshalJSON(f)
}

// --- opencode: {"mcp": {name: {type: "local"|"remote", command: [...], environment, url, headers, enabled}}}

type opencodeServer struct {
	Type        string            `json:"type"`
	Command     []string          `json:"command,omitempty"`
	Environment map[string]string `json:"environment,omitempty"`
	URL         string            `json:"url,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Enabled     *bool             `json:"enabled,omitempty"`
}

type opencodeFile struct {
	Schema string                    `json:"$schema,omitempty"`
	MCP    map[string]opencodeServer `json:"mcp"`
}

func parseOpencode(data []byte) ([]model.MCPServer, error) {
	var f opencodeFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("mcptrans: parse opencode config: %w", err)
	}
	var out []model.MCPServer
	for name, s := range f.MCP {
		m := model.MCPServer{Name: name, Env: s.Environment, URL: s.URL, Headers: s.Headers}
		if s.Type == "remote" {
			m.Transport = model.MCPHTTP
		} else {
			m.Transport = model.MCPStdio
			if len(s.Command) > 0 {
				m.Command = s.Command[0]
				m.Args = s.Command[1:]
			}
		}
		out = append(out, m)
	}
	return sortServers(out), nil
}

func emitOpencode(servers []model.MCPServer) ([]byte, error) {
	f := opencodeFile{Schema: "https://opencode.ai/config.json", MCP: map[string]opencodeServer{}}
	for _, s := range servers {
		os := opencodeServer{Environment: s.Env, Headers: s.Headers}
		switch s.Transport {
		case model.MCPStdio:
			os.Type = "local"
			if s.Command != "" {
				os.Command = append([]string{s.Command}, s.Args...)
			}
		default: // http and sse are both "remote" for opencode
			os.Type = "remote"
			os.URL = s.URL
		}
		f.MCP[s.Name] = os
	}
	return marshalJSON(f)
}

// --- codex: config.toml [mcp_servers.name] command/args/env, or url for remote

type codexServer struct {
	Command string            `toml:"command,omitempty"`
	Args    []string          `toml:"args,omitempty"`
	Env     map[string]string `toml:"env,omitempty"`
	URL     string            `toml:"url,omitempty"`
	Headers map[string]string `toml:"http_headers,omitempty"`
}

type codexFile struct {
	MCPServers map[string]codexServer `toml:"mcp_servers"`
}

func parseCodex(data []byte) ([]model.MCPServer, error) {
	var f codexFile
	if err := toml.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("mcptrans: parse codex config: %w", err)
	}
	var out []model.MCPServer
	for name, s := range f.MCPServers {
		m := model.MCPServer{
			Name: name, Command: s.Command, Args: s.Args, Env: s.Env,
			URL: s.URL, Headers: s.Headers,
		}
		if s.URL != "" {
			m.Transport = model.MCPHTTP
		} else {
			m.Transport = model.MCPStdio
		}
		out = append(out, m)
	}
	return sortServers(out), nil
}

func emitCodex(servers []model.MCPServer) ([]byte, error) {
	f := codexFile{MCPServers: map[string]codexServer{}}
	for _, s := range servers {
		f.MCPServers[s.Name] = codexServer{
			Command: s.Command, Args: s.Args, Env: s.Env,
			URL: s.URL, Headers: s.Headers,
		}
	}
	var buf bytes.Buffer
	if err := toml.NewEncoder(&buf).Encode(f); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// --- canonical at-rest form (sync repo mcp/servers.toml)

type canonicalFile struct {
	Servers []model.MCPServer `toml:"servers"`
}

// ParseCanonical reads the sync-repo servers.toml.
func ParseCanonical(data []byte) ([]model.MCPServer, error) {
	var f canonicalFile
	if err := toml.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("mcptrans: parse canonical servers.toml: %w", err)
	}
	return sortServers(f.Servers), nil
}

// EmitCanonical renders the sync-repo servers.toml.
func EmitCanonical(servers []model.MCPServer) ([]byte, error) {
	var buf bytes.Buffer
	if err := toml.NewEncoder(&buf).Encode(canonicalFile{Servers: sortServers(servers)}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
