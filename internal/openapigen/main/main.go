// Command openapigen renders pkg/apiclient/client.gen.go from api/openapi.yaml.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/singll/silkspool/internal/openapigen"
)

func main() {
	specPath := flag.String("spec", "api/openapi.yaml", "OpenAPI spec path")
	outPath := flag.String("out", "pkg/apiclient/client.gen.go", "generated client path")
	flag.Parse()

	specData, err := os.ReadFile(*specPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read spec: %v\n", err)
		os.Exit(1)
	}
	generated, err := openapigen.Generate(specData)
	if err != nil {
		fmt.Fprintf(os.Stderr, "generate: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*outPath, generated, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "write client: %v\n", err)
		os.Exit(1)
	}
}
