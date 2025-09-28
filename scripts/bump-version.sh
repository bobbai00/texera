#!/bin/bash
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

set -e

# Script to bump version across all Texera components

if [ $# -ne 1 ]; then
    echo "Usage: $0 <new_version>"
    echo "Example: $0 1.1.0"
    exit 1
fi

NEW_VERSION=$1

# Validate version format
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+)?$ ]]; then
    echo "Error: Invalid version format. Use semantic versioning (e.g., 1.0.0 or 1.0.0-alpha)"
    exit 1
fi

echo "Bumping version to $NEW_VERSION..."

# Get the script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Update VERSION file
echo "$NEW_VERSION" > "$PROJECT_ROOT/VERSION"
echo "✓ Updated VERSION file"

# Update core/build.sbt (line ~110)
if [ -f "$PROJECT_ROOT/core/build.sbt" ]; then
    # Use sed to update the version in build.sbt - specifically around line 110
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s/version := \"[^\"]*\"/version := \"$NEW_VERSION\"/" "$PROJECT_ROOT/core/build.sbt"
    else
        # Linux
        sed -i "s/version := \"[^\"]*\"/version := \"$NEW_VERSION\"/" "$PROJECT_ROOT/core/build.sbt"
    fi
    echo "✓ Updated core/build.sbt (version := \"$NEW_VERSION\")"
fi

# Update core/gui/package.json
if [ -f "$PROJECT_ROOT/core/gui/package.json" ]; then
    # Use a temporary file for JSON manipulation
    if command -v jq &> /dev/null; then
        # If jq is available, use it for proper JSON handling
        jq ".version = \"$NEW_VERSION\"" "$PROJECT_ROOT/core/gui/package.json" > "$PROJECT_ROOT/core/gui/package.json.tmp"
        mv "$PROJECT_ROOT/core/gui/package.json.tmp" "$PROJECT_ROOT/core/gui/package.json"
    else
        # Fallback to sed
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$PROJECT_ROOT/core/gui/package.json"
        else
            # Linux
            sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$PROJECT_ROOT/core/gui/package.json"
        fi
    fi
    echo "✓ Updated core/gui/package.json"
fi

# Update docker-compose files in deployment/single-node if needed
DOCKER_COMPOSE_FILE="$PROJECT_ROOT/deployment/single-node/docker-compose.yml"
if [ -f "$DOCKER_COMPOSE_FILE" ]; then
    # Update image tags if they use version tags
    if grep -q "texera/.*:latest" "$DOCKER_COMPOSE_FILE"; then
        echo "ℹ Docker compose file uses 'latest' tags. Consider updating to version-specific tags for releases."
    fi
fi

echo ""
echo "Version bumped to $NEW_VERSION successfully!"