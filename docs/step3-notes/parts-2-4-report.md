Three commits are on `feat/sce-step3-lane` over 55c14da26, each tested on its own; nothing pushed, tree clean.

- `2b9dcc571` feat(workflow-core): tidy an Iceberg table under its readers
- `8c16902ac` feat(workflow-core): keep an execution's log in the lake
- `60d3821e7` feat(workflow-core): store statistics and console as records

## Brief 2 (`2b9dcc571`)

Interface, all `private[storage]` in `core.storage.result.iceberg`:

```scala
IcebergAppender.append(table: Table, records: Iterable[Record], filePrefix: String, properties: Map[String, String] = Map.empty): Unit
IcebergAppender.setProperties(table: Table, properties: Map[String, String]): Unit
IcebergReader.read[T](table: Table, columns: Seq[String], filter: Expression = alwaysTrue, afterPlan: () => Unit = () => ())(collect: Iterator[Record] => T): T
IcebergTidy.tidy(table: Table, atEnd: Boolean): Unit
IcebergTidy.mergeSmallFiles(table: Table, targetBytes: Long, beforeCommit: () => Unit = () => ()): Int
IcebergTidy.rewriteManifests(table: Table): Unit
IcebergTidy.expire(table: Table, retainLast: Int, olderThanMs: Long): Unit
IcebergTidy.TargetFileBytes (32 MB), RetainSnapshots (5), RetainMillis (60000)
StorageConfig.icebergTableCommitIntervalMs: Long   // storage.iceberg.table.commit.interval-ms = 30000
```

Deviations:
- **`IcebergReader` is new.** The brief left "plan again once" to each store; it is now in one place beside the tidy.
- **Merge order.** `validateFromSnapshot` does not fail a merge that an append overtook: the merge commits above the append and rows read out of order (a spec shows it). The merged file now takes the data sequence number of the newest file it replaces, and the reader orders by data sequence number. `validateFromSnapshot` stays because without it a merge fails once early snapshots are expired.
- **S3 missing files.** The reader also starts over on the AWS SDK's `NoSuchKeyException`. On Lakekeeper, `S3FileIO` reports the manifest list of an expired snapshot that way, not as `NotFoundException`.
- **File names.** The appender takes a prefix and adds 32 random hex digits itself, not a caller-built name with 8. `statistics_<8 hex>` has nothing else to keep names apart.
- **Always a transaction.** Every append is one transaction, with or without properties; on Lakekeeper it cost 58 ms against 55 ms for a bare fast append.
- **End-of-run expiry** uses `Long.MaxValue` as the cutoff, not "now", so a snapshot from the same millisecond does not survive.
- **No-op tidies.** A table with one manifest is not rewritten and a table with no snapshot is skipped.
- **Spec catalog.** The specs use a Hadoop catalog of their own, not `LocalHadoopIcebergCatalog`. Under `STORAGE_ICEBERG_CATALOG_TYPE=postgres`, `IcebergCatalogInstanceSpec` replaces the shared entry with fakes and 26 tests failed in the full suite.

## Brief 3 (`8c16902ac`)

```scala
VFSResourceType.EXECUTION_LOG; VFSURIFactory.createExecutionLogURI(wid, eid, warehouse = None)
StorageConfig.icebergTableExecutionLogNamespace   // "execution-log"
ResultSchema.executionLogSchema
final class NoSuchExecutionTableException(val uri: URI)
final case class ExecutionLogEntry(seq: Long, timeMs: Long, kind: String, state: Option[String], detail: Option[String]) {
  def reason: Option[String]; def output: Option[ExecutionOutput] }
ExecutionLogEntry.state(seq, timeMs, state: String, reason: Option[String] = None, errors: Seq[WorkflowFatalError] = Nil)
ExecutionLogEntry.output(seq, timeMs, output: ExecutionOutput)
final case class ExecutionOutput(port: GlobalPortIdentity, uri: URI, outputMode: String)
final case class ExecutionLabel(state: Option[String], stateSeq: Long, stateTimeMs: Long, reason: Option[String], beatMs: Long, beatEveryMs: Long) { def ended: Boolean }
ExecutionLogStore: StateKind, OutputKind, States, EndStates, the six property names, MaxReasonLength (500)
  logUri(wid, eid, warehouse: Option[String]): URI
  create(uri, nowMs: Long, beatEveryMs: Long): Unit
  append(uri, entries: Seq[ExecutionLogEntry], nowMs: Long): Unit
  beat(uri, nowMs: Long): Unit
  label(uri): Option[ExecutionLabel]
  read(uri): Seq[ExecutionLogEntry]
  outputs(uri): Seq[ExecutionOutput]
  tidy(uri, atEnd: Boolean): Unit
  drop(uri): Unit
```

Deviations:
- **No public `ExecutionLogDetail`.** Rows are built with `ExecutionLogEntry.state` / `.output` and read through `entry.reason` / `entry.output`. The label's reason rule is then one function, which the closing job also needs for an ending it finds in the rows. There is no `errorsOf`: nothing reads errors back as `WorkflowFatalError`.
- **`ExecutionLabel.reason` is an `Option`**, not an empty string; both readers pass null on.
- **Writes to a missing table** throw `NoSuchExecutionTableException`; the brief was silent and the recorder needs the signal.
- **`append` also refuses** an unknown kind or state.
- **The 500-character cut** never splits a surrogate pair.
- **Python enum value** is `"executionlog"` (the lowercase segment), not `"executionLog"`; I also updated the comment in `document_factory.py` and its test.
- **Spec fixture.** `ExecutionPlanStoreSpec`'s catalog set-up moved into a shared trait, `EmbeddedJdbcCatalog`; no assertion changed.

## Brief 4 (`60d3821e7`)

```scala
VFSURIFactory.createConsoleMessagesURI(wid, eid, warehouse: Option[String]): URI
final case class RuntimeStatisticsRow(operatorId, timeMs, inputTupleCnt, inputTupleSize, outputTupleCnt, outputTupleSize,
                                      dataProcessingTime, controlProcessingTime, idleTime, numWorkers: Int, status: Int)
RuntimeStatisticsStore: Columns: Set[String]; statisticsUri(wid, eid, warehouse); create(uri); append(uri, rows: Seq[RuntimeStatisticsRow])
  read(uri, columns: Set[String] = Columns): Seq[RuntimeStatisticsRow]; tidy(uri, atEnd); drop(uri)
final case class ConsoleRow(seq, timeMs, operatorId, workerId, msgType, source, title, message)
ConsoleMessageStore: consoleUri(wid, eid, warehouse); create(uri); append(uri, rows: Seq[ConsoleRow])
  read(uri, operatorId: Option[String], afterSeq: Long, limit: Int): (Seq[ConsoleRow], Boolean); tidy(uri, atEnd); drop(uri)
```

Deviations:
- **Console `read` stops when the page is full.** The brief read every matching row, sorted and cut. It now takes rows in append order, treats a row whose `seq` is not above those before it as a repeat, and stops one row past the limit. In return `append` requires `seq` to rise within and across appends.
- **Statistics `read`** refuses a column name it does not have.
- **The new console URI overload** has no default for `warehouse`; Scala allows defaults on only one overload.

## Tests

| Suite | Count |
|---|---|
| WorkflowCore | 1248 passed (was 1144) |
| Config | 107 passed (was 105) |
| WorkflowExecutionService unit suite | 2677 passed |
| Python `test_vfs_uri_factory` + `test_document_factory` | 45 passed |
| `IcebergAppenderSpec` / `IcebergReaderSpec` / `IcebergTidySpec` | 9 / 9 / 10 |
| `ExecutionLogStoreSpec` | 28 |
| `RuntimeStatisticsStoreSpec` / `ConsoleMessageStoreSpec` | 17 / 24 |

- **Checks:** `scalafixAll --check` and `scalafmtCheckAll` pass. Hand-made breaks of the behaviours the specs pin each failed a spec.
- **REST catalog:** the specs cannot be pointed at one from outside, so I ran them with a local, uncommitted patch that swaps the catalog. It is kept in the session scratchpad under `step3-lane/rest/`. All six new specs passed on the final head against Lakekeeper 0.11.0 on RustFS (step 0's lake).
- **Lock:** held three times, at most 5 minutes each, and the lake was taken down every time.
- **Measured on Lakekeeper:**

| Operation | Time |
|---|---|
| Append | 55–60 ms |
| Beat (properties only) | 12–13 ms |
| Table load | 3–4 ms |
| Tidy after 50 appends | 0.5–1 s |
| Read of 50 files, before tidy | 0.2–0.6 s |
| Read of 50 files, after tidy | 11–22 ms |

## What the callers-to-be still need

- **Briefs 5/6:** append log rows in `seq` order, since the label is set from the last state row of the batch. Statistics rows have no `seq`, so a retried append can store a sample twice. The console's "N messages were not stored" row must take a `seq` above the rows before it. `STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS` is not yet in the unit manager's environment list.
- **Brief 11:** nothing returns a table's stored bytes. `DocumentFactory.icebergTableOf` is `private[storage]`, and `IcebergDocument.getTotalFileSize` reads an outage as a missing table. The "append that skips the label" case has no store seam; inject the label function into `ExecutionCloser`.
- **Brief 14:** nothing lists a namespace's tables by name prefix. A port's state URI is `VFSURIFactory.stateURI(createPortBaseURI(wid, eid, output.port, warehouse))`.
- **Later specs:** Lakekeeper returns `table.snapshots()` in no chronological order; one of my tests tripped on it.

## Open issues

- A commit that fails leaves its data file (or `merged_` file) in the store, as `IcebergTableWriter` does.
- A console page still decodes its first data file from the start; after the end tidy that is up to 32 MB.
- `ExecutionLogStore.create` is two commits (table, then beat properties), so a reader in between sees a beat of 0.
- Suites that rely on the shared default catalog are order-dependent under catalog type `postgres` or `hadoop`; this predates my change.
- The database `texera_iceberg_catalog_sce_step3_lane` is still in `texera-tripwire-pg`.