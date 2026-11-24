.PHONY: help dev test test-live release
.DEFAULT_GOAL := help

ARGS ?=
BRANCH ?= main
BUMP ?=
DRY_RUN ?=
LIVE_TEST ?=
SKIP_GH_RELEASE ?=
SKIP_VERIFY ?=
ALLOW_BRANCH ?=
NPM_TAG ?=
NPM_OTP ?=

help: ## Show available make targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

dev: ## Run CLI in dev mode with bun dev (pass flags via ARGS="...")
	bun dev $(ARGS)

test: ## Run unit test suite
	npm test

test-live: ## Run live Supabase integration tests
	npm run test:live

release: ## Run full release flow (supports DRY_RUN=1, BUMP=patch|minor|major|current, LIVE_TEST=1, SKIP_GH_RELEASE=1)
	@BRANCH="$(BRANCH)" BUMP="$(BUMP)" DRY_RUN="$(DRY_RUN)" LIVE_TEST="$(LIVE_TEST)" SKIP_GH_RELEASE="$(SKIP_GH_RELEASE)" SKIP_VERIFY="$(SKIP_VERIFY)" ALLOW_BRANCH="$(ALLOW_BRANCH)" NPM_TAG="$(NPM_TAG)" NPM_OTP="$(NPM_OTP)" ./scripts/release.sh
