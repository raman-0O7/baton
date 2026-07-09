package scrub

// Scrub redacts secrets from data per policy and returns the Result token
// required by gitstore.StageArtifact.
//
// P1 STUB: passthrough, zero detection. P3 replaces this file with the
// pattern+entropy engine and corpus tests. P4 (the first real push path)
// must not merge before P3 does — tracked in IMPLEMENTATION_PLAN.md.
func Scrub(data []byte, policy Policy) (Result, error) {
	return newResult(data, nil), nil
}
