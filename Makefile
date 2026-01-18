.PHONY: help install install-frontend install-controlplane install-sandbox \
	dev-frontend dev-controlplane dev-sandbox \
	build build-frontend build-controlplane build-sandbox \
	deploy-frontend deploy-controlplane \
	test test-frontend test-controlplane test-sandbox \
	lint lint-frontend typecheck-controlplane clean

help:
	@echo "Usage:"
	@echo "  make install           Install deps for all apps"
	@echo "  make dev-frontend      Run frontend dev server"
	@echo "  make dev-controlplane  Run controlplane worker dev server"
	@echo "  make dev-sandbox       Run sandbox server (local)"
	@echo "  make build             Build all apps"
	@echo "  make test              Run tests for all apps"

install: install-frontend install-controlplane

install-frontend:
	npm --prefix frontend install

install-controlplane:
	npm --prefix controlplane install

install-sandbox:
	@echo "Sandbox uses Go modules; run 'go mod download' inside sandbox if needed."

dev-frontend:
	npm --prefix frontend run dev

dev-controlplane:
	npm --prefix controlplane run dev

dev-sandbox:
	$(MAKE) -C sandbox run

build: build-frontend build-controlplane build-sandbox

build-frontend:
	npm --prefix frontend run build

build-controlplane:
	npm --prefix controlplane run deploy

build-sandbox:
	$(MAKE) -C sandbox build

test: test-frontend test-controlplane test-sandbox

test-frontend:
	npm --prefix frontend run test

test-controlplane:
	npm --prefix controlplane run test

test-sandbox:
	$(MAKE) -C sandbox test

lint: lint-frontend

lint-frontend:
	npm --prefix frontend run lint

typecheck-controlplane:
	npm --prefix controlplane run typecheck

deploy-frontend:
	npm --prefix frontend run workers:deploy

deploy-controlplane:
	wrangler deploy -c wrangler.production.toml

clean:
	$(MAKE) -C sandbox clean
