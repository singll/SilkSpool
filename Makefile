.PHONY: all build init-out clean dist-clean \
       build-linux build-darwin build-windows \
       test vet lint check openapi

BINARY_NAME := spool
CMD_PATH := ./cmd/spool/
OUT_DIR := out

VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "1.2.0")
BUILD_TIME := $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
LDFLAGS := -X github.com/singll/silkspool/internal/cli.Version=$(VERSION) -X github.com/singll/silkspool/internal/cli.BuildTime=$(BUILD_TIME) -X github.com/singll/silkspool/internal/cli.GitCommit=$(GIT_COMMIT)

# Default target
all: build init-out

# Build the Go binary into out/
build:
	@echo "==> Building $(BINARY_NAME)..."
	@mkdir -p $(OUT_DIR)
	go build -ldflags "$(LDFLAGS)" -o $(OUT_DIR)/$(BINARY_NAME) $(CMD_PATH)
	@echo "==> Built: $(OUT_DIR)/$(BINARY_NAME) (version=$(VERSION) commit=$(GIT_COMMIT))"

# Initialize out/ directory structure (idempotent)
init-out:
	@echo "==> Initializing $(OUT_DIR)/ directory..."

	# Copy bundles (prebuilt assets)
	@if [ -d "bundles" ]; then \
		rm -rf $(OUT_DIR)/bundles; \
		cp -r bundles $(OUT_DIR)/bundles; \
		echo "    Copied bundles/"; \
	fi

	# Copy example config if silkspool.yaml doesn't exist yet
	@if [ ! -f "$(OUT_DIR)/silkspool.yaml" ] && [ -f "silkspool.yaml.example" ]; then \
		cp silkspool.yaml.example $(OUT_DIR)/silkspool.yaml; \
		echo "    Created $(OUT_DIR)/silkspool.yaml (please edit it)"; \
	else \
		echo "    $(OUT_DIR)/silkspool.yaml already exists, skipping"; \
	fi

	# Create runtime directories
	@mkdir -p $(OUT_DIR)/hosts
	@mkdir -p $(OUT_DIR)/keys
	@mkdir -p $(OUT_DIR)/backups
	@touch $(OUT_DIR)/hosts/.gitkeep
	@touch $(OUT_DIR)/keys/.gitkeep
	@touch $(OUT_DIR)/backups/.gitkeep
	@echo "    Created hosts/, keys/, backups/"

	@echo "==> $(OUT_DIR)/ is ready."
	@echo "    Run './$(OUT_DIR)/$(BINARY_NAME) --help' to get started."

# Clean build artifacts (preserves user data: hosts/, keys/, backups/, silkspool.yaml)
clean:
	@echo "==> Cleaning build artifacts..."
	@rm -f $(OUT_DIR)/$(BINARY_NAME)
	@rm -rf $(OUT_DIR)/bundles
	@echo "==> Done. (hosts/, keys/, backups/, silkspool.yaml preserved)"

# Dist-clean: remove entire out/ directory (destructive)
dist-clean:
	@echo "==> WARNING: This will delete ALL files in $(OUT_DIR)/ including hosts/, keys/, backups/"
	@echo "==> Press Ctrl+C to cancel, or wait 3 seconds to continue..."
	@sleep 3
	@rm -rf $(OUT_DIR)
	@echo "==> Done. $(OUT_DIR)/ completely removed."

# Cross-compile helpers (optional)
build-linux:
	@echo "==> Building for linux/amd64..."
	@mkdir -p $(OUT_DIR)
	GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(OUT_DIR)/$(BINARY_NAME)-linux-amd64 $(CMD_PATH)

build-darwin:
	@echo "==> Building for darwin/arm64..."
	@mkdir -p $(OUT_DIR)
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(OUT_DIR)/$(BINARY_NAME)-darwin-arm64 $(CMD_PATH)

build-windows:
	@echo "==> Building for windows/amd64..."
	@mkdir -p $(OUT_DIR)
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(OUT_DIR)/$(BINARY_NAME)-windows-amd64.exe $(CMD_PATH)

# Test
test:
	@echo "==> Running tests..."
	go test ./...

# Vet
vet:
	@echo "==> Running go vet..."
	go vet ./...

# Lint (requires golangci-lint)
lint:
	@echo "==> Running golangci-lint..."
	golangci-lint run ./...

# Regenerate the typed API client from api/openapi.yaml
openapi:
	@echo "==> Generating pkg/apiclient/client.gen.go..."
	go run ./internal/openapigen/main -spec api/openapi.yaml -out pkg/apiclient/client.gen.go
	@echo "==> Generated."

# Check = vet + test
check: vet test
	@echo "==> All checks passed."
