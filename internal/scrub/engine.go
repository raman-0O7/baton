package scrub

import (
	"fmt"
	"math"
	"regexp"
	"sort"
)

// defaultEntropyThreshold (bits per byte) sits between English/base32-ish
// text (≲4.2) and random base64/hex-mixed material (≳4.7). Measured on the
// clean corpus: paths, import lines, UUIDs and SHAs all score below it.
const defaultEntropyThreshold = 4.5

// minEntropyToken is the shortest run the entropy detector considers.
// Short random strings score high by chance; 24 keeps noise out.
const minEntropyToken = 24

// span is one candidate redaction in input coordinates.
type span struct {
	start, end int
	typ        RedactionType
}

// Scrub redacts secrets from data per policy and returns the Result token
// required by gitstore.StageArtifact. Detection layers:
//
//  1. pattern detectors (patterns.go), value-group aware
//  2. user-supplied Policy.ExtraPatterns (whole-match)
//  3. Shannon-entropy detector over base64url-charset runs, unless disabled
//
// Replacements are the literal bytes "[REDACTED:<type>]" — quote- and
// backslash-free, so valid JSON in yields valid JSON out.
func Scrub(data []byte, policy Policy) (Result, error) {
	var spans []span

	for _, p := range patterns {
		spans = appendPatternSpans(spans, data, p)
	}
	for _, expr := range policy.ExtraPatterns {
		re, err := regexp.Compile(expr)
		if err != nil {
			return Result{}, fmt.Errorf("scrub: invalid extra pattern %q: %w", expr, err)
		}
		spans = appendPatternSpans(spans, data, pattern{re: re, typ: RedactGenericKey})
	}

	spans = resolveOverlaps(spans)

	if !policy.DisableEntropy {
		threshold := policy.EntropyThreshold
		if threshold <= 0 {
			threshold = defaultEntropyThreshold
		}
		spans = appendEntropySpans(spans, data, threshold)
		spans = resolveOverlaps(spans)
	}

	if len(spans) == 0 {
		return newResult(data, nil), nil
	}

	// Rebuild output with replacements, recording output-relative offsets.
	out := make([]byte, 0, len(data))
	reds := make([]Redaction, 0, len(spans))
	prev := 0
	for _, sp := range spans {
		out = append(out, data[prev:sp.start]...)
		marker := "[REDACTED:" + string(sp.typ) + "]"
		reds = append(reds, Redaction{Type: sp.typ, Offset: len(out), Length: len(marker)})
		out = append(out, marker...)
		prev = sp.end
	}
	out = append(out, data[prev:]...)
	return newResult(out, reds), nil
}

func appendPatternSpans(spans []span, data []byte, p pattern) []span {
	for _, m := range p.re.FindAllSubmatchIndex(data, -1) {
		g := p.group * 2
		if g+1 >= len(m) || m[g] < 0 {
			continue
		}
		spans = append(spans, span{start: m[g], end: m[g+1], typ: p.typ})
	}
	return spans
}

// resolveOverlaps sorts spans and drops any overlapping an earlier winner:
// leftmost wins; on ties the longer span wins.
func resolveOverlaps(spans []span) []span {
	if len(spans) < 2 {
		return spans
	}
	sort.Slice(spans, func(i, j int) bool {
		if spans[i].start != spans[j].start {
			return spans[i].start < spans[j].start
		}
		return spans[i].end > spans[j].end
	})
	out := spans[:1]
	for _, sp := range spans[1:] {
		if sp.start < out[len(out)-1].end {
			continue
		}
		out = append(out, sp)
	}
	return out
}

// isTokenByte reports membership in the base64url-superset charset the
// entropy detector tokenizes on.
func isTokenByte(b byte) bool {
	switch {
	case b >= 'a' && b <= 'z', b >= 'A' && b <= 'Z', b >= '0' && b <= '9':
		return true
	case b == '+', b == '/', b == '=', b == '_', b == '-':
		return true
	}
	return false
}

// appendEntropySpans scans maximal token runs outside existing spans.
// A run is flagged only when ALL hold:
//   - length ≥ minEntropyToken
//   - not an excluded well-known shape (SHA, UUID)
//   - fewer than two '/' bytes — multi-segment paths score surprisingly
//     high when they mix case and digits; standard-base64 secrets with 2+
//     slashes slip this detector but assignment-shaped ones are still
//     caught by the pattern layer
//   - mixes ≥ 2 of {lower, upper, digit} — prose and lowercase path runs
//     are near-single-class and never qualify
//   - Shannon entropy ≥ threshold bits/byte
func appendEntropySpans(spans []span, data []byte, threshold float64) []span {
	covered := make([]span, len(spans))
	copy(covered, spans)

	i := 0
	for i < len(data) {
		if !isTokenByte(data[i]) {
			i++
			continue
		}
		j := i
		for j < len(data) && isTokenByte(data[j]) {
			j++
		}
		if j-i >= minEntropyToken && !overlapsAny(covered, i, j) {
			tok := data[i:j]
			if !isExcludedShape(tok) && slashCount(tok) < 2 && classMix(tok) >= 2 && shannon(tok) >= threshold {
				spans = append(spans, span{start: i, end: j, typ: RedactEntropy})
			}
		}
		i = j
	}
	return spans
}

func overlapsAny(spans []span, start, end int) bool {
	for _, sp := range spans {
		if start < sp.end && sp.start < end {
			return true
		}
	}
	return false
}

func isExcludedShape(tok []byte) bool {
	for _, re := range entropyExclusions {
		if re.Match(tok) {
			return true
		}
	}
	return false
}

func slashCount(tok []byte) int {
	n := 0
	for _, b := range tok {
		if b == '/' {
			n++
		}
	}
	return n
}

// classMix counts distinct character classes present: lower, upper, digit.
func classMix(tok []byte) int {
	var lower, upper, digit bool
	for _, b := range tok {
		switch {
		case b >= 'a' && b <= 'z':
			lower = true
		case b >= 'A' && b <= 'Z':
			upper = true
		case b >= '0' && b <= '9':
			digit = true
		}
	}
	n := 0
	for _, ok := range []bool{lower, upper, digit} {
		if ok {
			n++
		}
	}
	return n
}

// shannon computes entropy in bits per byte.
func shannon(tok []byte) float64 {
	var freq [256]int
	for _, b := range tok {
		freq[b]++
	}
	total := float64(len(tok))
	var h float64
	for _, c := range freq {
		if c == 0 {
			continue
		}
		p := float64(c) / total
		h -= p * math.Log2(p)
	}
	return h
}
