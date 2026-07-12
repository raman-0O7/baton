// Package crypt provides optional age encryption of sync-repo artifacts
// (SR-3). When enabled, session payloads are encrypted before staging and
// decrypted after pull. Documented trade-off: the remote sees opaque
// blobs, so remote-side diffs/review of session content are impossible.
package crypt

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"filippo.io/age"
)

// header marks encrypted artifacts so Pull can tell them from plaintext.
var header = []byte("age-encryption.org/")

// IsEncrypted reports whether data looks like an age ciphertext (armored
// payloads are not used; binary format begins with the version line).
func IsEncrypted(data []byte) bool {
	return bytes.HasPrefix(data, header)
}

// Encrypt seals data to the given age recipients (X25519 public keys).
func Encrypt(data []byte, recipientKeys []string) ([]byte, error) {
	if len(recipientKeys) == 0 {
		return nil, errors.New("crypt: no age recipients configured")
	}
	var recipients []age.Recipient
	for _, k := range recipientKeys {
		r, err := age.ParseX25519Recipient(strings.TrimSpace(k))
		if err != nil {
			return nil, fmt.Errorf("crypt: bad recipient %q: %w", k, err)
		}
		recipients = append(recipients, r)
	}
	var buf bytes.Buffer
	w, err := age.Encrypt(&buf, recipients...)
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(data); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Decrypt opens an age ciphertext with the identity file at identityPath
// (age-keygen output; default ~/.config/baton/age.key).
func Decrypt(data []byte, identityPath string) ([]byte, error) {
	f, err := os.Open(identityPath)
	if err != nil {
		return nil, fmt.Errorf("crypt: open identity: %w", err)
	}
	defer f.Close()
	identities, err := age.ParseIdentities(f)
	if err != nil {
		return nil, fmt.Errorf("crypt: parse identity file: %w", err)
	}
	r, err := age.Decrypt(bytes.NewReader(data), identities...)
	if err != nil {
		return nil, fmt.Errorf("crypt: decrypt: %w", err)
	}
	return io.ReadAll(r)
}

// DefaultIdentityPath is where `baton init --encrypt` places the key.
func DefaultIdentityPath() (string, error) {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "baton", "age.key"), nil
}

// GenerateIdentity creates a new X25519 identity, writes it 0600 to path,
// and returns the public recipient string for the config.
func GenerateIdentity(path string) (recipient string, err error) {
	id, err := age.GenerateX25519Identity()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	body := fmt.Sprintf("# baton age identity — back this up; without it your synced data is unrecoverable\n%s\n", id.String())
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		return "", err
	}
	return id.Recipient().String(), nil
}
