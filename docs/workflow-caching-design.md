# Workflow Caching System Design

## Overview

The Texera workflow caching system enables automatic caching and reuse of operator execution results at the physical plan level. When operators and their upstream dependencies haven't changed, cached results can be reused instead of re-executing the entire workflow, significantly improving performance for iterative workflow development and repeated executions.

## Key Features

- **Physical Plan Level Caching**: Operates at the physical operator port level for fine-grained cache management
- **Content-Based Cache Keys**: Uses SHA-256 hashing of operator properties and upstream dependencies
- **Automatic Cache Invalidation**: Cache keys change automatically when operator configuration or upstream dependencies change
- **IcebergDocument Integration**: Reuses existing result storage infrastructure
- **LRU Cache Eviction**: Supports automatic cleanup of old cache entries based on last access time

## Architecture

### Components

#### 1. WorkflowCacheKeyGenerator
**Location**: `amber/src/main/scala/org/apache/texera/web/service/WorkflowCacheKeyGenerator.scala`

Generates deterministic cache keys for physical operators based on:
- Operator type and configuration
- Operator code (for UDF/Python operators)
- Recursively computed upstream operator cache keys
- Output port identifier

**Key Methods**:
- `getCacheKey(opId: PhysicalOpIdentity, portId: PortIdentity): String`
  - Returns a hex-encoded SHA-256 hash uniquely identifying the computation
  - Includes all upstream dependencies transitively

- `getOperatorContentHash(opId: PhysicalOpIdentity): String`
  - Computes hash of operator's own properties (without dependencies)

#### 2. WorkflowCacheService
**Location**: `amber/src/main/scala/org/apache/texera/web/service/WorkflowCacheService.scala`

Manages cache storage, lookup, and eviction using the `workflow_cache` database table.

**Key Methods**:
- `lookupCache(cacheKey: String): Option[CachedResult]`
  - Looks up cached results by cache key
  - Updates access statistics (last_accessed, access_count)
  - Verifies cached result files still exist

- `storeCache(cacheKey, operatorId, portId, resultUri, resultSize, tupleCount, schema)`
  - Stores new cache entries
  - Uses INSERT ... ON CONFLICT DO UPDATE for idempotency

- `lookupCachedResultsForPlan(physicalPlan, cacheKeyGenerator): Map[(PhysicalOpIdentity, PortIdentity), CachedResult]`
  - Batch lookup for all operators in a plan

- `evictOldCacheEntries(olderThan: Timestamp): Int`
  - Removes cache entries not accessed since specified timestamp
  - Useful for LRU-based cache cleanup

- `getCacheStatistics(): Map[String, Any]`
  - Returns cache statistics (total entries, size, tuples, avg access count)

#### 3. Database Schema
**Location**: `sql/texera_ddl.sql` and `sql/updates/16.sql`

**Table**: `workflow_cache`

| Column | Type | Description |
|--------|------|-------------|
| cache_key | VARCHAR(64) PRIMARY KEY | SHA-256 hash of operator and dependencies |
| operator_id | VARCHAR(100) | Logical operator ID |
| port_id | VARCHAR(100) | Output port ID |
| result_uri | TEXT | URI to IcebergDocument storage |
| result_size | INT | Size in bytes |
| tuple_count | BIGINT | Number of tuples |
| schema_json | TEXT | Serialized schema |
| created_time | TIMESTAMP | When cache entry was created |
| last_accessed | TIMESTAMP | Last access time (for LRU) |
| access_count | INT | Number of times accessed |

**Indexes**:
- Primary key on `cache_key`
- Index on `last_accessed` for efficient eviction queries

#### 4. CacheSourceOpExec
**Location**: `common/workflow-operator/src/main/scala/org/apache/amber/operator/source/cache/CacheSourceOpExec.scala`

A source operator executor that reads from cached IcebergDocument storage. Can be used to replace cached operators in the physical plan to skip execution.

**Usage**:
```scala
val cacheSource = new CacheSourceOpExec(cachedResultUri)
val tuples = cacheSource.produceTuple()
```

#### 5. ExecutionResultService Integration
**Location**: `amber/src/main/scala/org/apache/texera/web/service/ExecutionResultService.scala`

**Modifications**:
- Initializes `WorkflowCacheKeyGenerator` when attaching to execution
- Calls `storeToCacheOnCompletion()` when workflow execution completes successfully
- Stores all operator output port results to cache with appropriate metadata

## Workflow Execution Flow with Caching

### Current Implementation: Cache Storage Only

```
┌─────────────────────────────────────────────────────────────────┐
│                    WORKFLOW SUBMISSION                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│            WorkflowCompiler.compile()                           │
│  - Expands logical plan → physical plan                        │
│  - (Future: Check for cached operators)                        │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│         ExecutionResultService.attachToExecution()             │
│  - Initializes WorkflowCacheKeyGenerator                       │
│  - Sets up result monitoring                                   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│               WORKFLOW EXECUTION                                │
│  - Operators execute normally                                  │
│  - Results written to IcebergDocument                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│        EXECUTION COMPLETES (State = COMPLETED)                  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│     ExecutionResultService.storeToCacheOnCompletion()          │
│  ┌─────────────────────────────────────────────────────┐       │
│  │ For each operator output port:                      │       │
│  │ 1. Generate cache key using WorkflowCacheKeyGen     │       │
│  │ 2. Get result URI, size, tuple count, schema        │       │
│  │ 3. Store to workflow_cache table via CacheService   │       │
│  └─────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### Future Enhancement: Cache Lookup and Reuse

The system is designed to support cache lookup in future iterations:

```
┌─────────────────────────────────────────────────────────────────┐
│            WorkflowCompiler.compile()                           │
│  ┌─────────────────────────────────────────────────────┐       │
│  │ 1. Expand logical plan → physical plan              │       │
│  │ 2. Initialize WorkflowCacheKeyGenerator             │       │
│  │ 3. For each operator output port:                   │       │
│  │    - Generate cache key                             │       │
│  │    - Look up in WorkflowCacheService                │       │
│  │    - If cache hit:                                  │       │
│  │      a) Mark operator as cached                     │       │
│  │      b) Option 1: Replace with CacheSourceOpExec    │       │
│  │      c) Option 2: Set flag to skip execution        │       │
│  └─────────────────────────────────────────────────────┘       │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│               WORKFLOW EXECUTION                                │
│  - Cached operators: Read from cache (skip execution)          │
│  - Non-cached operators: Execute normally                      │
└─────────────────────────────────────────────────────────────────┘
```

## Cache Key Generation Algorithm

The cache key for an operator output port is computed as:

```
CacheKey(Op, Port) = SHA256(
  OperatorHash(Op) +
  UpstreamKeys(Op) +
  PortId
)

OperatorHash(Op) = SHA256({
  logicalOpId,
  opExecInitInfo,
  code (if applicable),
  parallelizable,
  partitionRequirement,
  isOneToManyOp
})

UpstreamKeys(Op) = [
  CacheKey(UpstreamOp1, UpstreamPort1),
  CacheKey(UpstreamOp2, UpstreamPort2),
  ...
] (sorted)
```

**Key Properties**:
- **Deterministic**: Same operator configuration always produces same key
- **Cascading Invalidation**: Changing any upstream operator invalidates downstream caches
- **Fine-Grained**: Per-port granularity allows reuse of some operator outputs even if others change
- **Collision-Resistant**: SHA-256 provides strong collision resistance

## Cache Invalidation Strategy

Cache invalidation is **automatic and implicit**:

1. **Operator Property Changes**: If any operator property changes, its content hash changes, producing a different cache key
2. **Upstream Dependency Changes**: If any upstream operator changes, all downstream cache keys change recursively
3. **No Explicit Invalidation Needed**: The cache key itself encodes all dependencies

This approach provides:
- ✅ Correctness: Stale data is never returned
- ✅ Simplicity: No manual invalidation logic
- ⚠️  Storage Growth: Old cache entries persist until explicitly evicted

**Manual Eviction Options**:
```scala
// Evict entries older than 30 days
val thirtyDaysAgo = new Timestamp(System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000)
cacheService.evictOldCacheEntries(thirtyDaysAgo)

// Clear all cache
cacheService.clearAllCache()
```

## Database Migration

To enable caching on an existing Texera installation:

```bash
# Apply the migration
psql -d texera_db -f sql/updates/16.sql
```

Or for a fresh installation, the `workflow_cache` table is included in `sql/texera_ddl.sql`.

## Usage Example

### Storing to Cache (Automatic)

Cache storage happens automatically when a workflow execution completes successfully. No user action required.

### Looking Up Cache (Programmatic)

```scala
// Create cache service and key generator
val cacheService = new WorkflowCacheService()
val keyGenerator = new WorkflowCacheKeyGenerator(physicalPlan)

// Look up cache for a specific operator port
val cacheKey = keyGenerator.getCacheKey(operatorId, portId)
val cachedResult = cacheService.lookupCache(cacheKey)

cachedResult match {
  case Some(result) =>
    println(s"Cache hit! URI: ${result.resultUri}, Tuples: ${result.tupleCount}")
    // Use CacheSourceOpExec to read cached data
    val cacheSource = new CacheSourceOpExec(result.resultUri)
    val tuples = cacheSource.produceTuple()

  case None =>
    println("Cache miss - execute operator normally")
}

// Batch lookup for entire plan
val allCachedResults = cacheService.lookupCachedResultsForPlan(physicalPlan, keyGenerator)
println(s"Found ${allCachedResults.size} cached operator outputs")
```

### Cache Statistics

```scala
val stats = cacheService.getCacheStatistics()
println(s"Total cache entries: ${stats("totalEntries")}")
println(s"Total size: ${stats("totalSizeBytes")} bytes")
println(s"Total tuples cached: ${stats("totalTuples")}")
println(s"Average access count: ${stats("avgAccessCount")}")
```

## Performance Considerations

### Benefits
- **Faster Workflow Iteration**: Reuse results when refining downstream operators
- **Reduced Computation**: Skip expensive operators that haven't changed
- **Development Efficiency**: Quickly test workflow modifications

### Overhead
- **Cache Key Computation**: SHA-256 hashing for each operator (negligible, ~microseconds)
- **Database Lookups**: One query per operator port (can be batched)
- **Storage Space**: Cached results consume disk space (same as regular results)

### Recommendations
- **Enable for development/testing** environments where workflows are frequently modified
- **Periodic eviction** of old cache entries to manage storage
- **Monitor cache hit rate** to assess effectiveness

## Implementation Status

### ✅ Completed
1. **Cache Key Generator**: Fully implemented with recursive upstream dependency hashing
2. **Cache Service**: Database operations for lookup, storage, eviction, statistics
3. **Database Schema**: Table and indexes created
4. **Cache Storage Integration**: Automatic storage on workflow completion
5. **CacheSourceOpExec**: Operator for reading cached results

### 🔄 Future Work
1. **Cache Lookup Integration**: Modify WorkflowCompiler to check cache before execution
2. **Physical Plan Optimization**: Replace cached operators with CacheSourceOpExec
3. **Configuration Options**:
   - Enable/disable caching globally or per-workflow
   - Cache size limits
   - TTL-based eviction policies
4. **Cache Hit/Miss Metrics**: Track and expose cache effectiveness metrics
5. **Frontend Integration**:
   - Display cache status in UI
   - Allow manual cache invalidation
   - Show cache statistics
6. **Selective Caching**: Allow users to mark specific operators as cacheable/non-cacheable

## Design Decisions

### Why Physical Plan Level?
- **Fine Granularity**: Different physical workers may produce different outputs
- **Accurate Dependency Tracking**: Physical plan has actual execution dependencies
- **Parallelism Awareness**: Cache keys include parallelization strategy

### Why Port-Level Caching?
- **Operator Output Granularity**: Different output ports may have different results
- **Partial Reuse**: Some ports may be cached while others are not
- **Matches Storage Model**: IcebergDocument storage is already per-port

### Why Content-Based Keys vs. Version Numbers?
- **No Coordination Needed**: No global version counter to manage
- **Automatic Invalidation**: Dependencies are automatically encoded
- **Distributed-Friendly**: Works across multiple Texera instances sharing storage

## Limitations

1. **Non-Deterministic Operators**: Operators with random/timestamp outputs will never have cache hits
2. **External Data Sources**: Changes in external data won't invalidate cache (e.g., database table changes)
3. **Storage Growth**: Cache entries accumulate over time; manual eviction required
4. **No Cache Warming**: Cache is populated only through actual executions

## Conclusion

The Texera workflow caching system provides a robust foundation for automatic result reuse at the physical operator port level. The current implementation handles cache storage after successful executions. Future work will integrate cache lookup into the workflow compilation process to enable transparent cache-based execution skipping.

The design prioritizes **correctness** (never serving stale data) and **simplicity** (automatic invalidation) over maximum cache hit rates. This makes it suitable for development and testing scenarios where workflows are frequently modified incrementally.
