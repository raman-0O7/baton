package main

import (
	"fmt"
	"os"

	"github.com/raman-0O7/baton/internal/cli"
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
