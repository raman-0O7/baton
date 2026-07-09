// Package scrub is the mandatory redaction chokepoint (SR-1). The only
// path into the sync repo, gitstore.StageArtifact, requires a scrub.Result —
// committing unscrubbed data is a compile-time error by construction.
//
// Types here are the P1 contract freeze; the detection engine lands in P3.
package scrub

// RedactionType classifies what was redacted, for reporting.
type RedactionType string

const (
	RedactAWS        RedactionType = "aws-key"
	RedactGitHub     RedactionType = "github-token"
	RedactSlack      RedactionType = "slack-token"
	RedactPEM        RedactionType = "pem-block"
	RedactBearer     RedactionType = "bearer-token"
	RedactGenericKey RedactionType = "generic-api-key"
	RedactConnString RedactionType = "connection-string"
	RedactEntropy    RedactionType = "high-entropy"
)

// Redaction reports one replacement made by Scrub.
type Redaction struct {
	Type RedactionType
	// Offset/Length locate the replacement in the scrubbed output.
	Offset int
	Length int
}

// Result is scrubbed data plus its redaction report. Only Scrub constructs
// it (unexported field enforces this across packages).
type Result struct {
	data       []byte
	Redactions []Redaction
}

// Data returns the scrubbed bytes.
func (r Result) Data() []byte { return r.data }

// Policy configures detection. Zero value = strict defaults.
type Policy struct {
	// DisableEntropy turns off the entropy detector (patterns stay on).
	DisableEntropy bool
	// ExtraPatterns are project-specific additional regexes.
	ExtraPatterns []string
	// EntropyThreshold overrides the default Shannon-entropy cutoff when > 0.
	EntropyThreshold float64
}

// newResult is used by the Scrub implementation (and tests) in this package.
func newResult(data []byte, reds []Redaction) Result {
	return Result{data: data, Redactions: reds}
}
