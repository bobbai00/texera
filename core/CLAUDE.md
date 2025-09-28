# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Apache Texera (Incubating) is a collaborative data science and AI/ML workflow platform that supports scalable data computation through a browser-based GUI. The system enables users to form workflows without writing code and supports real-time collaboration on data science projects similar to Google Docs.

## Architecture

### Multi-Module Scala/SBT Structure
The core system is built using Scala with an SBT multi-project structure:

- **amber/**: Main execution engine (Texera Web Application) - the workflow execution service using an actor-based model
- **workflow-core/**: Core workflow processing logic, tuple handling, and storage abstractions
- **workflow-operator/**: Individual workflow operators (filters, joins, aggregations, visualizations, UDFs, ML operators)
- **workflow-compiling-service/**: Compiles high-level workflows into executable plans
- **dao/**: Data Access Objects for database interactions using JOOQ
- **config/**: Configuration management with HOCON files
- **auth/**: Authentication and authorization services
- **config-service/**: Configuration management service
- **file-service/**: File upload/download and storage service
- **computing-unit-managing-service/**: Manages distributed computing resources
- **access-control-service/**: Access control and permissions management microservice
- **gui/**: Angular frontend application

### Key Technologies
- **Backend**: Scala 2.13.12, Akka Actors, Dropwizard, JOOQ
- **Frontend**: Angular 16, TypeScript, Monaco Editor, JointJS for workflow visualization
- **Build**: SBT for Scala services, Yarn for frontend
- **Storage**: Iceberg for result storage, PostgreSQL for metadata
- **Execution**: Actor-based distributed execution engine (Amber)

## Common Development Commands

### Building the System
```bash
# From core/ directory:

# Build all Scala services
./scripts/build-services.sh  # or: sbt clean dist

# Build frontend only
./scripts/gui.sh  # or: cd gui && yarn install && yarn build

# Build everything
./scripts/build.sh

# Generate JOOQ classes (auto-runs during SBT build)
sbt jooqCodegen
```

### Development Servers
```bash
# From core/ directory:

# Start frontend development server with collaboration support
./scripts/gui-dev.sh  # or: cd gui && yarn start

# Start main execution service (after building)
./scripts/server.sh  # or: cd amber && target/texera-*/bin/texera-web-application

# Start individual services
./scripts/config-service.sh
./scripts/file-service.sh
./scripts/workflow-compiling-service.sh
./scripts/computing-unit-managing-service.sh
./scripts/access-control-service.sh
```

### Testing
```bash
# Run all Scala tests
sbt test

# Run specific module tests
sbt "project WorkflowOperator" test
sbt "project amber" test
sbt "project WorkflowCore" test

# Run a single test class
sbt "amber/testOnly edu.uci.ics.amber.engine.e2e.DataProcessingSpec"

# Run frontend tests
cd gui && yarn test

# Run frontend tests in CI mode (no watch)
cd gui && yarn test:ci
```

### Frontend Development
```bash
cd gui

# Install dependencies
yarn install

# Development server with hot reload
yarn start  # includes y-websocket for collaboration

# Linting and formatting
yarn lint
yarn eslint:fix
yarn format:fix
yarn format:ci  # for CI validation

# Build for production
yarn build  # or yarn build:ci

# Bundle analysis
yarn analyze
```

### Code Quality
```bash
# Frontend linting and formatting (from gui/)
yarn prettier:fix    # Format code
yarn eslint:fix     # Fix ESLint issues
yarn format:fix     # Combined prettier-eslint formatting
```

## Key Architecture Concepts

### Workflow Execution Engine (Amber)
- Actor-based distributed execution using Akka
- Support for fault tolerance, checkpointing, and replay
- Interactive debugging capabilities with breakpoints
- Real-time reconfiguration during execution

### Operator System
- Modular operator architecture in `workflow-operator/`
- Operators for data sources, transformations, joins, ML, and visualizations
- Support for Python UDFs, R UDFs, and Java UDFs
- Extensive visualization operators (charts, plots, tables)

### Collaborative Features
- Real-time collaborative editing using Yjs and WebSockets
- Version control for workflows and results
- Shared computing resources and result caching

### Storage Architecture
- Iceberg tables for storing execution results
- PostgreSQL for metadata and user data
- File service for uploads and temporary storage
- Result export capabilities to various formats

## Testing Patterns

### Test Structure
- **Framework**: ScalaTest 3.2.15 with AnyFlatSpec style, ScalaMock for mocking
- **Naming**: Test files end with `Spec.scala`
- **Location**: `src/test/scala/` in each module
- **Resources**: Test data in `src/test/resources/`

### Test Categories
1. **Unit Tests**: Individual component testing (e.g., `TupleSpec.scala`)
2. **Operator Tests**: Test operator execution (e.g., `CartesianProductOpExecSpec.scala`)
3. **Integration Tests**: Actor-based workflow tests (e.g., `DataProcessingSpec.scala` in amber/e2e/)
4. **Engine Tests**: Distributed execution testing

### Key Test Locations
- `amber/src/test/` - Execution engine tests, e2e tests
- `workflow-operator/src/test/` - Operator-specific tests
- `workflow-core/src/test/` - Core data structure tests
- `dao/src/test/` - Database access tests

## Development Workflow

1. **Backend Changes**: Modify Scala code, run `sbt test` for affected modules
2. **Frontend Changes**: Use `cd gui && yarn start` for hot reload development
3. **Full Integration**: Run `./scripts/build.sh` and test full system
4. **Operator Development**: Add operators in `workflow-operator/`, test with unit tests and GUI
5. **Service Development**: Modify individual services, test with their specific endpoints

## Important Files and Directories

- `build.sbt` - Main SBT build configuration defining all modules
- `gui/package.json` - Frontend dependencies and scripts
- `scripts/` - Shell scripts for common development tasks
- `amber/src/main/resources/web-config.yml` - Main application configuration
- `config/src/main/resources/` - System configuration files
- `gui/src/app/workspace/` - Main workflow editor UI components

## Docker Deployment

### Building Docker Images
```bash
# From deployment/ directory:

# Build all images interactively
./build-all.sh

# Build specific service images
docker build -f texera-web-application.dockerfile -t texera/texera-web-application:latest ..
docker build -f computing-unit-worker.dockerfile -t texera/computing-unit-worker:latest ..
```

### Single-Node Deployment
```bash
# From deployment/single-node/ directory:

# Start all services with Docker Compose
docker-compose up -d

# Services included:
# - MinIO (S3-compatible storage)
# - PostgreSQL with PGroonga
# - LakeFS (dataset versioning)
# - All Texera microservices
```

## Python Integration

Python operators are supported through:
- Python workers that communicate via gRPC
- `amber/src/main/python/` - Python worker implementation
- Requirements files: `requirements.txt`, `operator-requirements.txt`, `r-requirements.txt`
- Language server support in `pyright-language-server/`

## Environment Variables

Key configuration environment variables (see deployment/single-node/.env):
- `TEXERA_HOST` - Host address for services
- `POSTGRES_*` - Database configuration
- `MINIO_*` - Object storage credentials
- `LAKEFS_*` - Data versioning configuration