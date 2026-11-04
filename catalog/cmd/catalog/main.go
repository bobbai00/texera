// Command catalog runs the Texera 2.0 catalog: the control plane's resources, versions,
// grants, executions, lineage, files, units and the MCP servers.
package main

import (
	"fmt"
	"os"

	"github.com/apache/texera/catalog/internal/config"
)

func main() {
	if _, err := config.FromEnv(); err != nil {
		fmt.Fprintln(os.Stderr, "catalog:", err)
		os.Exit(1)
	}
	// The contract reset is in progress: the store, ports, adapters and services land in the
	// next commits and this command wires them (see docs/texera-2-0/PLAN.md, M1 S4 and S5).
	fmt.Fprintln(os.Stderr, "catalog: the server is being rebuilt on contract v2; see docs/texera-2-0/PLAN.md")
	os.Exit(2)
}
