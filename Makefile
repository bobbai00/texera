# Texera 2.0 build entrypoints. Generated code is committed under gen/ and regenerated here.
SHELL := /bin/bash
GOBIN := $(shell go env GOPATH)/bin

.PHONY: generate generate-openapi generate-go generate-ts check-drift test

generate: generate-openapi generate-go generate-ts

generate-openapi:
	cd api && ./node_modules/.bin/tsp compile . --pretty=false

generate-go: generate-openapi
	cd catalog && $(GOBIN)/oapi-codegen -config oapi-codegen.yaml ../gen/openapi/3.0.0/Texera.Catalog.openapi.yaml
	cd catalog && $(GOBIN)/oapi-codegen -config oapi-codegen-engine.yaml ../gen/openapi/3.0.0/Texera.Engine.openapi.yaml
	cd catalog && go run ./cmd/mcpgen -spec ../gen/openapi/3.1.0/Texera.Catalog.openapi.yaml -out internal/mcp/tools.gen.go

generate-ts: generate-openapi
	cd packages/catalog-client && bun run generate

check-drift: generate
	git diff --exit-code -- gen catalog/internal/api catalog/internal/mcp/tools.gen.go packages/catalog-client/src/gen

test:
	cd catalog && go test -p 1 ./...
	cd agent-runtime && bun test
	cd frontend-next && bun run test
