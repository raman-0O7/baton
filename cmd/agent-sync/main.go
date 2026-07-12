package main

import (
	"fmt"
	"os"

	"agent-sync/internal/cli"
)

// version is stamped by goreleaser via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	cli.SetVersion(version)
	if err := cli.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
