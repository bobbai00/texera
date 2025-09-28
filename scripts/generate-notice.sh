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

# Script to generate Apache-compliant NOTICE file from dependencies

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
NOTICE_FILE="$PROJECT_ROOT/NOTICE"

echo "Generating Apache NOTICE file..."

# Start with the base NOTICE content
cat > "$NOTICE_FILE" << 'EOF'
Apache Texera (Incubating)
Copyright 2024 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (http://www.apache.org/).

================================================================================
THIRD-PARTY DEPENDENCIES
================================================================================

This product includes the following third-party components:

EOF

# Add Backend (Scala/Java) Dependencies
echo "--------------------------------------------------------------------------------" >> "$NOTICE_FILE"
echo "Backend Dependencies (Scala/Java)" >> "$NOTICE_FILE"
echo "--------------------------------------------------------------------------------" >> "$NOTICE_FILE"
echo "" >> "$NOTICE_FILE"

# Generate backend dependency list using sbt
cd "$PROJECT_ROOT/core"
if command -v sbt &> /dev/null; then
    echo "Extracting Scala/Java dependencies..."
    # Use sbt to get dependency tree and extract unique dependencies
    sbt -Dsbt.log.noformat=true "show dependencyTree" 2>/dev/null | \
        grep -E "^\[info\].*:.*:.*" | \
        sed 's/\[info\]//' | \
        sed 's/^[[:space:]]*//' | \
        sed 's/[├─│└ ]*//' | \
        sort -u | \
        while IFS=: read -r group artifact version rest; do
            if [[ ! -z "$group" && ! -z "$artifact" && ! -z "$version" ]]; then
                # Skip internal modules
                if [[ "$group" != "edu.uci.ics"* ]]; then
                    echo "- $group:$artifact:$version" >> "$NOTICE_FILE"
                fi
            fi
        done
else
    echo "Warning: sbt not found. Backend dependencies will be incomplete." >&2
    echo "- Backend dependencies require sbt to extract" >> "$NOTICE_FILE"
fi

echo "" >> "$NOTICE_FILE"

# Add Frontend (JavaScript/TypeScript) Dependencies
echo "--------------------------------------------------------------------------------" >> "$NOTICE_FILE"
echo "Frontend Dependencies (JavaScript/TypeScript)" >> "$NOTICE_FILE"
echo "--------------------------------------------------------------------------------" >> "$NOTICE_FILE"
echo "" >> "$NOTICE_FILE"

# Generate frontend dependency list from package.json
if [ -f "$PROJECT_ROOT/core/gui/package.json" ]; then
    echo "Extracting JavaScript/TypeScript dependencies..."
    cd "$PROJECT_ROOT/core/gui"

    if command -v yarn &> /dev/null; then
        # Use yarn to list dependencies with licenses
        yarn licenses list --json 2>/dev/null | \
            grep -E '"name":|"version":|"license":' | \
            paste -d' ' - - - | \
            sed 's/"name"://g; s/"version"://g; s/"license"://g; s/"//g; s/,//g' | \
            while read -r name version license; do
                if [[ ! -z "$name" && ! -z "$version" ]]; then
                    echo "- $name@$version (License: $license)" >> "$NOTICE_FILE"
                fi
            done
    elif command -v npm &> /dev/null; then
        # Fallback to npm if yarn is not available
        npm ls --json --depth=0 2>/dev/null | \
            jq -r '.dependencies | to_entries[] | "- \(.key)@\(.value.version)"' >> "$NOTICE_FILE" 2>/dev/null || \
            echo "- Frontend dependencies require yarn or npm with jq to extract" >> "$NOTICE_FILE"
    else
        echo "Warning: Neither yarn nor npm found. Frontend dependencies will be incomplete." >&2
        echo "- Frontend dependencies require yarn or npm to extract" >> "$NOTICE_FILE"
    fi
else
    echo "Warning: package.json not found" >&2
fi

echo "" >> "$NOTICE_FILE"

# Add Python Dependencies
echo "--------------------------------------------------------------------------------" >> "$NOTICE_FILE"
echo "Python Dependencies" >> "$NOTICE_FILE"
echo "--------------------------------------------------------------------------------" >> "$NOTICE_FILE"
echo "" >> "$NOTICE_FILE"

# Extract Python dependencies from requirements files
for req_file in "$PROJECT_ROOT/core/amber/requirements.txt" "$PROJECT_ROOT/core/amber/operator-requirements.txt"; do
    if [ -f "$req_file" ]; then
        echo "From $(basename $req_file):" >> "$NOTICE_FILE"
        grep -v "^#" "$req_file" | grep -v "^$" | while read -r line; do
            echo "- $line" >> "$NOTICE_FILE"
        done
        echo "" >> "$NOTICE_FILE"
    fi
done

# Add Special Notices for Apache Projects
cat >> "$NOTICE_FILE" << 'EOF'
--------------------------------------------------------------------------------
Special Notices
--------------------------------------------------------------------------------

This product includes software from the Apache Software Foundation including but
not limited to:
- Apache Spark
- Apache Arrow
- Apache Commons libraries
- Apache Log4j

This product includes software developed by the Akka project (https://akka.io/).

This product includes software developed by the Angular team (https://angular.io/).

This product includes JointJS (https://www.jointjs.com/), which is dual licensed
under the Mozilla Public License 2.0 and commercial license.

This product includes Monaco Editor (https://microsoft.github.io/monaco-editor/),
developed by Microsoft Corporation.

This product includes Yjs (https://yjs.dev/), a CRDT framework with CRDT Algorithm
distributed under the MIT License.

================================================================================
For complete license information for all dependencies, please refer to the
individual LICENSE files distributed with each component.
================================================================================
EOF

echo "✓ NOTICE file generated at: $NOTICE_FILE"

echo ""
echo "NOTICE file has been generated"