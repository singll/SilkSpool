.PHONY: all build init-out clean

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

# Clean build output
clean:
	@echo "==> Cleaning $(OUT_DIR)/..."
	@rm -rf $(OUT_DIR)
	@echo "==> Done."

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
