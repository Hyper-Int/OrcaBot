.PHONY: build test test-integration test-integration-local run clean docker-build docker-run deploy

# Binary name
BINARY=orcabot-sandbox

# Go build flags
GOFLAGS=-ldflags="-s -w"

# Default target
all: build

# Build Go binary locally
build:
	go build $(GOFLAGS) -o bin/$(BINARY) ./cmd/server

# Run unit tests
test:
	go test -v ./...

# Run integration tests against deployed API
test-integration:
	./scripts/test-api.sh

# Run integration tests against local server
test-integration-local:
	./scripts/test-api.sh http://localhost:8080

# Run server locally (uses /tmp/orcabot-workspace for local dev)
run: build
	WORKSPACE_BASE=/tmp/orcabot-workspace ./bin/$(BINARY)

# Clean build artifacts
clean:
	rm -rf bin/
	go clean

# Build Docker image
docker-build:
	docker build -f docker/Dockerfile -t orcabot-sandbox .

# Run Docker container locally
docker-run: docker-build
	docker run --rm -it -p 8080:8080 orcabot-sandbox

# Deploy to Fly.io
deploy:
	fly deploy --build-arg TALKITO_VERSION=$$(date +%s)

# Deploy without cache (full rebuild)
deploy-fresh:
	fly deploy --no-cache

# Show Fly app status
status:
	fly status

# Tail Fly logs
logs:
	fly logs

# SSH into running Fly machine
ssh:
	fly ssh console
