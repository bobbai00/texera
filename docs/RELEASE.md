# Texera Release Process

This document describes the automated release process for Apache Texera.

## Overview

The release process is fully automated using GitHub Actions. When a version tag is pushed or the release workflow is manually triggered, it will:

1. Build all backend Scala services
2. Build the Angular frontend
3. Generate Apache NOTICE file for compliance
4. Build and publish multi-architecture Docker images
5. Create a GitHub release with all artifacts (including NOTICE)
6. Publish Docker images to Docker Hub

## Prerequisites

Before creating a release, ensure the following secrets are configured in GitHub repository settings:

- `DOCKER_USERNAME`: Docker Hub username
- `DOCKER_TOKEN`: Docker Hub access token

## Creating a Release

### Method 1: Using Version Tags (Recommended)

1. **Bump the version** using the provided script:
   ```bash
   ./scripts/bump-version.sh 1.1.0
   ```

2. **Review and commit** the version changes:
   ```bash
   git diff
   git commit -am "chore: bump version to 1.1.0"
   ```

3. **Create and push** a version tag:
   ```bash
   git tag v1.1.0
   git push origin main
   git push origin v1.1.0
   ```

   The release workflow will automatically trigger when the tag is pushed.

### Method 2: Manual Workflow Dispatch

1. Go to the [Actions tab](../../actions) in GitHub
2. Select the "Release" workflow
3. Click "Run workflow"
4. Enter the version number (e.g., "1.1.0")
5. Optionally mark as pre-release
6. Click "Run workflow"

## Release Artifacts

Each release includes:

### Backend Services
- `texera-web-application-*.zip` - Main application server
- `config-service-*.zip` - Configuration service
- `file-service-*.zip` - File management service
- `workflow-compiling-service-*.zip` - Workflow compilation service
- `computing-unit-managing-service-*.zip` - Computing resource manager

### Frontend
- `texera-frontend-*.tar.gz` - Angular web application

### Deployment Bundle
- `texera-single-node-*.tar.gz` - Complete single-node deployment with Docker Compose

### Docker Images
The following images are published to Docker Hub with both version-specific and `latest` tags:

- `texera/texera-web-application`
- `texera/computing-unit-master`
- `texera/computing-unit-worker`
- `texera/config-service`
- `texera/file-service`
- `texera/workflow-compiling-service`
- `texera/computing-unit-managing-service`
- `texera/pylsp`
- `texera/y-websocket-server`

All images are built for both `linux/amd64` and `linux/arm64` architectures.

## Version Management

The version is managed in three places:
- `VERSION` - Central version file
- `core/build.sbt` - Scala/SBT version
- `core/gui/package.json` - Frontend version

Use the `bump-version.sh` script to update all three simultaneously.

## Release Notes

Release notes are automatically generated from commit messages between the current and previous tags. They include:
- List of changes (commits)
- Docker image versions
- Installation instructions

## Deployment

After a release, users can deploy Texera using:

### Docker Compose (Recommended)
```bash
# Download and extract the release bundle
wget https://github.com/Texera/texera/releases/download/v1.1.0/texera-single-node-1.1.0.tar.gz
tar -xzf texera-single-node-1.1.0.tar.gz
cd texera-single-node-1.1.0

# Start services
docker-compose up -d
```

### Using Specific Docker Images
```bash
docker pull texera/texera-web-application:1.1.0
docker pull texera/computing-unit-worker:1.1.0
# ... pull other required images
```

## Troubleshooting

### Release Workflow Fails

1. **Check GitHub Actions logs** for specific error messages
2. **Verify Docker Hub credentials** are correctly set in repository secrets
3. **Ensure version format** follows semantic versioning (x.y.z)
4. **Check disk space** on runners if builds fail

### Docker Build Issues

- Ensure all required files are committed before tagging
- Check that Dockerfiles have proper build context
- Verify multi-architecture builds work locally using `docker buildx`

### Version Conflicts

- Always bump version before creating a release
- Don't reuse existing version numbers
- Use pre-release tags for testing (e.g., v1.1.0-rc1)

## Release Checklist

Before releasing:
- [ ] All tests pass in CI
- [ ] Version bumped appropriately
- [ ] CHANGELOG updated (if maintained)
- [ ] Documentation updated for new features
- [ ] Docker images build successfully locally
- [ ] Release notes prepared

## Semantic Versioning

Texera follows [Semantic Versioning](https://semver.org/):
- **MAJOR** version for incompatible API changes
- **MINOR** version for backwards-compatible functionality additions
- **PATCH** version for backwards-compatible bug fixes

Examples:
- `1.0.0` → `2.0.0` - Breaking changes
- `1.0.0` → `1.1.0` - New features
- `1.0.0` → `1.0.1` - Bug fixes