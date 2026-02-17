.PHONY: build test test-integration test-integration-local run clean docker-build docker-run deploy drain invalidate-warm-pool

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
# After deploy, invalidates the warm pool so new dashboards get fresh machines.
# The cron reaper (reapUntrackedFlyResources) will destroy the orphaned Fly machines.
deploy:
	fly deploy --build-arg TALKITO_VERSION=$$(date +%s)
	@$(MAKE) invalidate-warm-pool

# Deploy without cache (full rebuild)
deploy-fresh:
	fly deploy --no-cache
	@$(MAKE) invalidate-warm-pool

# Destroy all running sandbox machines (use after deploy to clear stale state)
drain:
	@echo "Destroying all orcabot-sandbox machines..."
	@fly machines list -a orcabot-sandbox --json | jq -r '.[].id' | xargs -I{} fly machines destroy {} -a orcabot-sandbox --force
	@echo "Done. New terminals will spin up fresh VMs."

# Invalidate warm pool after sandbox deploy.
# Clears the warm_machines D1 table so no new dashboards get assigned stale-image machines.
# The cron reaper (reapUntrackedFlyResources) will destroy the now-orphaned Fly machines.
# Image is auto-discovered from running machines — no config pinning needed.
invalidate-warm-pool:
	@echo "Invalidating warm pool..."
	@cd ../controlplane && npx wrangler d1 execute orcabot-db-production --command="DELETE FROM warm_machines" -c wrangler.production.toml --remote 2>/dev/null && echo "Cleared warm_machines (production DB)" || echo "Warning: failed to clear warm_machines (production)"
	@echo "Warm pool invalidated. Cron will replenish with latest image within 1 minute."

# Show Fly app status
status:
	fly status

# Tail Fly logs
logs:
	fly logs

# SSH into running Fly machine
ssh:
	fly ssh console
