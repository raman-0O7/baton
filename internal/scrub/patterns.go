package scrub

import "regexp"

// pattern couples a compiled regex with the redaction type it reports and
// which capture group holds the secret (0 = whole match). Group-based
// patterns redact only the value, keeping surrounding context readable.
type pattern struct {
	re    *regexp.Regexp
	typ   RedactionType
	group int
}

var patterns = []pattern{
	// AWS access key IDs are globally unique prefixes; the secret-key form
	// only appears as an assignment.
	{regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`), RedactAWS, 0},
	{regexp.MustCompile(`(?i)aws_secret_access_key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{30,})`), RedactAWS, 1},

	// GitHub tokens: classic (ghp_...), app/oauth variants, fine-grained PATs.
	{regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{20,255}\b`), RedactGitHub, 0},
	{regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{22,255}\b`), RedactGitHub, 0},

	{regexp.MustCompile(`\bxox[baprs]-[A-Za-z0-9-]{10,}`), RedactSlack, 0},

	// PEM private key blocks. (?s) spans newlines; the same regex also hits
	// \n-escaped blocks inside JSON strings because escapes are plain bytes.
	{regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`), RedactPEM, 0},

	{regexp.MustCompile(`(?i)\bbearer\s+([A-Za-z0-9._~+/=-]{20,})`), RedactBearer, 1},

	// Assignment-shaped generic secrets: key[:=] value. Only the value is
	// redacted. 16-char minimum keeps short identifiers and numbers out.
	{regexp.MustCompile(`(?i)\b(api[_-]?key|apikey|access[_-]?key|secret|client[_-]?secret|token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["']?([^\s"',;]{16,})`), RedactGenericKey, 2},
	// Vendor key shapes that appear bare (OpenAI/Anthropic/Stripe style).
	{regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{20,}\b`), RedactGenericKey, 0},

	// userinfo credentials in URLs: scheme://user:password@host → password.
	{regexp.MustCompile(`\b[a-z][a-z0-9+.-]*://[^/\s:@]+:([^@\s/]{4,})@`), RedactConnString, 1},
}

// entropy-detector exclusions: shapes that look high-entropy but are
// well-known non-secrets. Git SHAs and UUIDs are hard zero-FP requirements.
var entropyExclusions = []*regexp.Regexp{
	regexp.MustCompile(`^[0-9a-f]{40}$`), // git SHA-1
	regexp.MustCompile(`^[0-9a-f]{64}$`), // git SHA-256
	regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`), // UUID
}
