SONARLINT_VERSION = 4.25.1
SONARLINT_BUILD = 77914
SONARLINT_BASE_URL = https://github.com/SonarSource/sonarlint-vscode/releases/download

# Platforms
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)
PLATFORM := $(strip $(if $(filter Darwin,$(UNAME_S)),\
$(if $(filter arm64,$(UNAME_M)),darwin-arm64,darwin-x64),\
$(if $(filter Linux,$(UNAME_S)),linux-x64,)))

# Dependencies
DEPS_DIR = sonarlint-deps
VSIX_NAME = sonarlint-vscode$(if $(PLATFORM),-$(PLATFORM))-$(SONARLINT_VERSION).vsix
JAVA_CMD = $(if $(PLATFORM),$$(find $(DEPS_DIR)/jre -name java -type f | head -1),java)

LSP_JAR = $(DEPS_DIR)/server/sonarlint-ls.jar
JS_JAR = $(DEPS_DIR)/analyzers/sonarjs.jar
SCAN = node scan.js --sonarlint-lsp "$(LSP_JAR)" --analyzers "$(JS_JAR)" --java "$(JAVA_CMD)"
ARGS = $(filter-out $@,$(MAKECMDGOALS))

help:
	@echo "make rules    - List all rules"
	@echo "make analyze  - Analyze files: make analyze file.js"
	@echo "make debug    - Debug analyze: make debug file.js"
	@echo "make test     - Analyze test samples"
	@echo "make clean    - Remove dependencies"

$(LSP_JAR):
	@rm -rf $(DEPS_DIR)
	@mkdir -p $(DEPS_DIR)
	@echo "Downloading $(VSIX_NAME) for $(UNAME_S) $(UNAME_M)..."
	@cd $(DEPS_DIR) && \
		curl -sL "$(SONARLINT_BASE_URL)/$(SONARLINT_VERSION)%2B$(SONARLINT_BUILD)/$(VSIX_NAME)" > sonar.zip && \
		unzip -q sonar.zip -d tmp && \
		mv tmp/extension/analyzers tmp/extension/server . && \
		if [ -d tmp/extension/jre ]; then mv tmp/extension/jre .; fi && \
		rm -rf sonar.zip tmp

rules: $(LSP_JAR)
	@$(SCAN) list-rules

analyze: $(LSP_JAR)
	@$(SCAN) analyze $(ARGS)

debug: $(LSP_JAR)
	@$(SCAN) --debug analyze $(ARGS)

test: $(LSP_JAR)
	@$(SCAN) analyze test-samples/*.js

clean:
	@rm -rf $(DEPS_DIR)

.PHONY: help rules analyze debug test clean
%:
	@:
