# Texera 2.0 build entrypoints. TypeSpec under api/ is the only hand-written description of
# the API; everything under gen/ and every *.gen.* file is generated here and committed.
SHELL := /bin/bash
GOBIN := $(shell go env GOPATH)/bin
CATALOG_SPEC_31 := ../gen/openapi/3.1.0/Texera.Catalog.openapi.yaml
CATALOG_SPEC_30 := ../gen/openapi/3.0.0/Texera.Catalog.openapi.yaml
ENGINE_SPEC_30 := ../gen/openapi/3.0.0/Texera.Engine.openapi.yaml

.PHONY: generate generate-openapi generate-go generate-ts check-drift test

generate: generate-openapi generate-go generate-ts

generate-openapi:
	cd api && ./node_modules/.bin/tsp compile . --pretty=false

generate-go: generate-openapi
	cd catalog && $(GOBIN)/oapi-codegen -config oapi-codegen.yaml $(CATALOG_SPEC_30)
	cd catalog && $(GOBIN)/oapi-codegen -config oapi-codegen-engine.yaml $(ENGINE_SPEC_30)
	cd catalog && go run ./cmd/catalogen -spec $(CATALOG_SPEC_31) -root ..

generate-ts: generate-openapi generate-go
	cd packages/catalog-client && bun run generate

check-drift: generate
	git diff --exit-code -- gen packages/catalog-client/src/gen ':(glob)catalog/**/*.gen.*' ':(glob)packages/**/*.gen.*'

test:
	cd catalog && go test -p 1 ./...
	cd agent-runtime && bun test
	cd frontend-next && bun run test
