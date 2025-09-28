# Testing the Release Process

This guide explains how to test the automated release process, especially on your own fork before running it on the main repository.

## Overview

The release process includes several components that should be tested:
1. Version bumping across multiple files
2. NOTICE file generation for Apache compliance
3. Building all components (backend, frontend, Docker)
4. Creating release artifacts
5. Publishing to Docker Hub (main repo only)

## Testing on Your Fork

### Prerequisites

1. **Fork the Repository**
   ```bash
   # Fork via GitHub UI, then clone your fork
   git clone https://github.com/YOUR_USERNAME/texera.git
   cd texera
   ```

2. **Set Up Your Environment**
   - Java 11+ for backend
   - Node.js 18+ and Yarn for frontend
   - Docker for image builds
   - sbt for Scala builds

### Running the Test Workflow

We provide a special `test-release.yml` workflow that's safe to run on forks:

1. **Go to Actions Tab** in your forked repository
2. **Select "Test Release (Fork-Safe)"** workflow
3. **Click "Run workflow"**
4. **Configure test parameters:**
   - `version`: Test version (e.g., "1.0.0-test")
   - `skip_docker`: Check to skip Docker builds (faster)
5. **Click "Run workflow"**

The test workflow will:
- ✅ Test version bump script
- ✅ Generate NOTICE files
- ✅ Build backend services
- ✅ Build frontend application
- ✅ Test Docker image creation (optional)
- ✅ Create test artifacts
- ❌ NOT push to Docker Hub
- ❌ NOT create GitHub releases

### Manual Testing Steps

#### 1. Test Version Bumping

```bash
# Make the script executable
chmod +x scripts/bump-version.sh

# Test version bump (dry run - check changes)
./scripts/bump-version.sh 1.0.1-test

# Verify changes
git diff
cat VERSION
grep "version" core/build.sbt | head -1
grep '"version"' core/gui/package.json | head -1

# Reset if needed
git checkout -- .
```

#### 2. Test NOTICE Generation

```bash
# Make the script executable
chmod +x scripts/generate-notice.sh

# Generate NOTICE files
./scripts/generate-notice.sh

# Check generated file
ls -la NOTICE
head -50 NOTICE
```

#### 3. Test Backend Build

```bash
# Build all services
cd core
sbt clean compile

# Package one service as a test
sbt "project amber" dist

# Check the output
ls -la amber/target/universal/*.zip
```

#### 4. Test Frontend Build

```bash
# Install dependencies
cd core/gui
yarn install

# Build frontend
yarn build:ci

# Check the output
ls -la dist/
```

#### 5. Test Docker Build (Local)

```bash
# First build the application
cd core
sbt clean dist

# Generate NOTICE file
./scripts/generate-notice.sh

# Build a test Docker image
docker build \
  -f deployment/texera-web-application.dockerfile \
  -t texera-test:local \
  .
```

## Testing the Full Release Process

### On Your Fork (Safe Testing)

1. **Configure Test Secrets** (optional)
   - You can add your own Docker Hub credentials to test pushing
   - Go to Settings → Secrets → Actions
   - Add `DOCKER_USERNAME` and `DOCKER_TOKEN`
   - Images will push to your Docker Hub account

2. **Create a Test Release**
   ```bash
   # Bump version
   ./scripts/bump-version.sh 1.0.0-beta1

   # Commit changes
   git add -A
   git commit -m "chore: test release v1.0.0-beta1"

   # Create and push tag
   git tag v1.0.0-beta1
   git push origin main
   git push origin v1.0.0-beta1
   ```

3. **Monitor the Workflow**
   - Go to Actions tab
   - Watch the "Release" workflow run
   - Check for any errors

### Pre-Release Checklist

Before running the actual release on the main repository:

- [ ] All tests pass in CI
- [ ] Version bump script works correctly
- [ ] NOTICE file generates properly
- [ ] Backend builds successfully
- [ ] Frontend builds successfully
- [ ] Docker images build for both architectures
- [ ] Test workflow completes without errors
- [ ] Docker Hub credentials are configured (main repo)
- [ ] Release notes are prepared

## Troubleshooting Common Issues

### Version Bump Issues

**Problem**: Version not updating in all files
```bash
# Manually check each file
grep -n "version" core/build.sbt
grep -n '"version"' core/gui/package.json
cat VERSION
```

**Solution**: Ensure the script has correct sed commands for your OS (macOS vs Linux)

### NOTICE Generation Failures

**Problem**: Missing dependencies in NOTICE
```bash
# Check if tools are installed
which sbt
which yarn
which npm
```

**Solution**: Install missing tools or run in environment with all dependencies

### Docker Build Failures

**Problem**: Build context issues
```bash
# Ensure you're in the right directory
pwd  # Should be project root

# Check required files exist
ls -la deployment/*.dockerfile
ls -la core/amber/target/universal/*.zip
```

**Solution**: Build backend first with `sbt dist` before Docker builds

### GitHub Actions Issues

**Problem**: Workflow not triggering
- Ensure workflows are enabled in fork (Settings → Actions)
- Check workflow file syntax
- Verify tag format matches pattern `v*.*.*`

## Testing Artifacts

After a test run, verify the following artifacts:

1. **Backend ZIPs**: Check each service has a distribution ZIP
2. **Frontend TAR.GZ**: Verify frontend bundle is created
3. **NOTICE Files**: Ensure NOTICE is in all artifacts
4. **Docker Images**: If not skipped, verify images are built
5. **Release Bundle**: Check single-node deployment package

## Best Practices

1. **Always Test on Fork First**
   - Never test directly on the main repository
   - Use test versions like `1.0.0-test` or `1.0.0-beta`

2. **Clean Up Test Artifacts**
   ```bash
   # Remove test tags
   git tag -d v1.0.0-test
   git push origin --delete v1.0.0-test

   # Remove test Docker images
   docker rmi texera-test:local
   ```

3. **Incremental Testing**
   - Test components individually first
   - Run full test only after components work
   - Use `skip_docker` for faster iteration

4. **Document Issues**
   - Keep notes of any issues encountered
   - Update this guide with solutions
   - Share findings with the team

## Getting Help

If you encounter issues:

1. Check the [Release Documentation](RELEASE.md)
2. Review workflow logs in GitHub Actions
3. Open an issue with:
   - Error messages
   - Steps to reproduce
   - Environment details
   - Workflow run URL