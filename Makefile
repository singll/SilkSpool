.PHONY: all build init-out clean build-rdp build-rdp-gateway build-rdp6-agent

BINARY_NAME := spool
CMD_PATH := ./cmd/spool/
OUT_DIR := out

# Default target
all: build init-out

# Build the Go binary into out/
build:
	@echo "==> Building $(BINARY_NAME)..."
	@mkdir -p $(OUT_DIR)
	go build -o $(OUT_DIR)/$(BINARY_NAME) $(CMD_PATH)
	@echo "==> Built: $(OUT_DIR)/$(BINARY_NAME)"

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
	GOOS=linux GOARCH=amd64 go build -o $(OUT_DIR)/$(BINARY_NAME)-linux-amd64 $(CMD_PATH)

build-darwin:
	@echo "==> Building for darwin/arm64..."
	@mkdir -p $(OUT_DIR)
	GOOS=darwin GOARCH=arm64 go build -o $(OUT_DIR)/$(BINARY_NAME)-darwin-arm64 $(CMD_PATH)

build-windows:
	@echo "==> Building for windows/amd64..."
	@mkdir -p $(OUT_DIR)
	GOOS=windows GOARCH=amd64 go build -o $(OUT_DIR)/$(BINARY_NAME)-windows-amd64.exe $(CMD_PATH)

# RDP 安全网关组件（静态交叉编译到 linux/amd64：txhk 与 istoreos 均为 x86_64+musl，
# CGO_ENABLED=0 产出无运行时依赖的单文件，经 spool sync push 部署。见 doc/RDP-GUARD.md）
build-rdp: build-rdp-gateway build-rdp6-agent

build-rdp-gateway:
	@echo "==> Building rdp-gateway (linux/amd64, static)..."
	@mkdir -p $(OUT_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags='-s -w' -o $(OUT_DIR)/rdp-gateway ./cmd/rdp-gateway

build-rdp6-agent:
	@echo "==> Building rdp6-agent (linux/amd64, static)..."
	@mkdir -p $(OUT_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags='-s -w' -o $(OUT_DIR)/rdp6-agent ./cmd/rdp6-agent
