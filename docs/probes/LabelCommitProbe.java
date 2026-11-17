import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.apache.iceberg.CatalogProperties;
import org.apache.iceberg.DataFile;
import org.apache.iceberg.HasTableOperations;
import org.apache.iceberg.PartitionSpec;
import org.apache.iceberg.Schema;
import org.apache.iceberg.Snapshot;
import org.apache.iceberg.Table;
import org.apache.iceberg.TableMetadata;
import org.apache.iceberg.Transaction;
import org.apache.iceberg.aws.s3.S3FileIO;
import org.apache.iceberg.catalog.Namespace;
import org.apache.iceberg.catalog.TableIdentifier;
import org.apache.iceberg.data.GenericRecord;
import org.apache.iceberg.data.Record;
import org.apache.iceberg.data.parquet.GenericParquetWriter;
import org.apache.iceberg.io.DataWriter;
import org.apache.iceberg.parquet.Parquet;
import org.apache.iceberg.rest.RESTCatalog;
import org.apache.iceberg.types.Types;

/**
 * Step 3 design, the one unverified assumption: an execution-log row and the table properties
 * that repeat it ("the label") go to Lakekeeper in ONE commit through Iceberg Java's REST catalog,
 * and a reader never sees one without the other.
 *
 * Phase A: N commits, each one Transaction = newFastAppend(one row) + updateProperties(state-seq).
 *          Readers loadTable in a loop and compare the property with the snapshot's total-records.
 * Phase B: the same, as two separate commits (append, then properties): the control that shows the
 *          readers' check can see a gap at all.
 * Phase C: properties-only commits ("beats"): no snapshot is added, the label stays.
 * Phase D: the state row, a tidy-like rewrite of manifests and a beat in between, then the label
 *          is still what the last transaction wrote.
 */
public class LabelCommitProbe {
  static final String SEQ = "texera.execution.state-seq";
  static final String STATE = "texera.execution.state";
  static final String BEAT = "texera.execution.beat-ms";

  static final Schema SCHEMA =
      new Schema(
          Types.NestedField.optional(1, "seq", Types.LongType.get()),
          Types.NestedField.optional(2, "timeMs", Types.LongType.get()),
          Types.NestedField.optional(3, "kind", Types.StringType.get()),
          Types.NestedField.optional(4, "state", Types.StringType.get()),
          Types.NestedField.optional(5, "detail", Types.StringType.get()));

  static RESTCatalog catalog(String uri, String warehouse) {
    RESTCatalog c = new RESTCatalog();
    Map<String, String> p = new HashMap<>();
    p.put("warehouse", warehouse);
    p.put(CatalogProperties.URI, uri);
    p.put(CatalogProperties.FILE_IO_IMPL, S3FileIO.class.getName());
    c.initialize("probe", p);
    return c;
  }

  static DataFile writeRow(Table table, String name, long seq) throws Exception {
    DataWriter<Record> w =
        Parquet.writeData(table.io().newOutputFile(table.location() + "/" + name))
            .forTable(table)
            .createWriterFunc((s, mt) -> GenericParquetWriter.create(s, mt))
            .overwrite()
            .build();
    try {
      GenericRecord r = GenericRecord.create(SCHEMA);
      r.setField("seq", seq);
      r.setField("timeMs", System.currentTimeMillis());
      r.setField("kind", "state");
      r.setField("state", seq % 2 == 0 ? "PAUSED" : "RUNNING");
      r.setField("detail", null);
      w.write(r);
    } finally {
      w.close();
    }
    return w.toDataFile();
  }

  static long rows(Table t) {
    Snapshot s = t.currentSnapshot();
    return s == null ? 0L : Long.parseLong(s.summary().getOrDefault("total-records", "0"));
  }

  static long seq(Table t) {
    return Long.parseLong(t.properties().getOrDefault(SEQ, "0"));
  }

  static TableMetadata meta(Table t) {
    return ((HasTableOperations) t).operations().refresh();
  }

  static String pct(List<Double> xs, double p) {
    double[] a = xs.stream().mapToDouble(Double::doubleValue).sorted().toArray();
    if (a.length == 0) return "-";
    return String.format("%.1f", a[(int) Math.min(a.length - 1, Math.floor(p * a.length))]);
  }

  /** Runs `commits` commits while `readers` threads load the table; returns {loads, labelAhead, rowAhead, distinct}. */
  static long[] race(String uri, String wh, TableIdentifier id, int commits, int readers, boolean oneCommit, List<Double> ms)
      throws Exception {
    RESTCatalog wc = catalog(uri, wh);
    Table table = wc.loadTable(id);
    long start = rows(table);
    AtomicBoolean stop = new AtomicBoolean(false);
    AtomicLong loads = new AtomicLong();
    AtomicLong labelAhead = new AtomicLong();
    AtomicLong rowAhead = new AtomicLong();
    AtomicLong distinct = new AtomicLong();
    List<Thread> ts = new ArrayList<>();
    for (int r = 0; r < readers; r++) {
      Thread t =
          new Thread(
              () -> {
                RESTCatalog rc = catalog(uri, wh);
                long last = -1;
                while (!stop.get()) {
                  Table seen = rc.loadTable(id);
                  long rws = rows(seen);
                  long sq = seq(seen);
                  loads.incrementAndGet();
                  if (sq > rws) labelAhead.incrementAndGet();
                  if (sq < rws) rowAhead.incrementAndGet();
                  if (rws != last) {
                    distinct.incrementAndGet();
                    last = rws;
                  }
                }
              });
      t.setDaemon(true);
      t.start();
      ts.add(t);
    }
    for (long i = start + 1; i <= start + commits; i++) {
      DataFile df = writeRow(table, (oneCommit ? "a" : "b") + "_state_" + i, i);
      long t0 = System.nanoTime();
      if (oneCommit) {
        Transaction tx = table.newTransaction();
        tx.newFastAppend().appendFile(df).commit();
        tx.updateProperties()
            .set(SEQ, Long.toString(i))
            .set(STATE, i % 2 == 0 ? "PAUSED" : "RUNNING")
            .set(BEAT, Long.toString(System.currentTimeMillis()))
            .commit();
        tx.commitTransaction();
      } else {
        table.newFastAppend().appendFile(df).commit();
        table
            .updateProperties()
            .set(SEQ, Long.toString(i))
            .set(STATE, i % 2 == 0 ? "PAUSED" : "RUNNING")
            .set(BEAT, Long.toString(System.currentTimeMillis()))
            .commit();
      }
      ms.add((System.nanoTime() - t0) / 1e6);
    }
    stop.set(true);
    for (Thread t : ts) t.join();
    return new long[] {loads.get(), labelAhead.get(), rowAhead.get(), distinct.get()};
  }

  public static void main(String[] args) throws Exception {
    String uri = args[0];
    String wh = args[1];
    int n = Integer.parseInt(args[2]);
    RESTCatalog c = catalog(uri, wh);
    Namespace ns = Namespace.of("step3-probe");
    try {
      c.createNamespace(ns);
    } catch (Exception e) {
      // exists
    }
    TableIdentifier id = TableIdentifier.of(ns, "wid_1_eid_" + System.currentTimeMillis() + "_executionlog");
    Map<String, String> props = new HashMap<>();
    props.put("format-version", "2");
    Table table = c.createTable(id, SCHEMA, PartitionSpec.unpartitioned(), props);
    System.out.println("table " + id + " at " + table.location());

    // One transaction, looked at closely.
    TableMetadata before = meta(table);
    DataFile first = writeRow(table, "a_state_1", 1);
    Transaction tx = table.newTransaction();
    tx.newFastAppend().appendFile(first).commit();
    tx.updateProperties().set(SEQ, "1").set(STATE, "RUNNING").set(BEAT, "1").commit();
    // Nothing is visible to another client until commitTransaction.
    Table midway = catalog(uri, wh).loadTable(id);
    System.out.println(
        "before commitTransaction, another client sees: snapshots="
            + (midway.currentSnapshot() == null ? 0 : 1)
            + " seq=" + midway.properties().get(SEQ));
    tx.commitTransaction();
    TableMetadata after = meta(table);
    System.out.println(
        "one transaction: metadata-log entries " + before.previousFiles().size() + " -> " + after.previousFiles().size()
            + ", last-sequence-number " + before.lastSequenceNumber() + " -> " + after.lastSequenceNumber()
            + ", snapshots " + before.snapshots().size() + " -> " + after.snapshots().size()
            + ", seq property=" + after.properties().get(SEQ)
            + ", metadata file changed=" + !String.valueOf(before.metadataFileLocation()).equals(after.metadataFileLocation()));

    List<Double> a = new ArrayList<>();
    long[] ra = race(uri, wh, id, n, 3, true, a);
    System.out.println(
        "PHASE A one transaction x" + n + ": loads=" + ra[0] + " distinctStatesSeen=" + ra[3]
            + " labelAheadOfRow=" + ra[1] + " rowAheadOfLabel=" + ra[2]
            + " commit p50/p95 ms=" + pct(a, 0.5) + "/" + pct(a, 0.95));
    Table t1 = c.loadTable(id);
    System.out.println("  after A: rows=" + rows(t1) + " seq=" + seq(t1) + " snapshots=" + meta(t1).snapshots().size());

    List<Double> b = new ArrayList<>();
    long[] rb = race(uri, wh, id, n, 3, false, b);
    System.out.println(
        "PHASE B two commits x" + n + " (control): loads=" + rb[0] + " distinctStatesSeen=" + rb[3]
            + " labelAheadOfRow=" + rb[1] + " rowAheadOfLabel=" + rb[2]
            + " commit p50/p95 ms=" + pct(b, 0.5) + "/" + pct(b, 0.95));

    // Phase C: beats.
    Table held = c.loadTable(id);
    long snapsBefore = meta(held).snapshots().size();
    long snapIdBefore = held.currentSnapshot().snapshotId();
    long seqBefore = seq(held);
    List<Double> beats = new ArrayList<>();
    int nb = Math.max(150, n / 2);
    for (int i = 0; i < nb; i++) {
      long t0 = System.nanoTime();
      held.updateProperties().set(BEAT, Long.toString(System.currentTimeMillis())).commit();
      beats.add((System.nanoTime() - t0) / 1e6);
    }
    Table t2 = c.loadTable(id);
    System.out.println(
        "PHASE C " + nb + " beats: snapshots " + snapsBefore + " -> " + meta(t2).snapshots().size()
            + ", current snapshot unchanged=" + (t2.currentSnapshot().snapshotId() == snapIdBefore)
            + ", seq " + seqBefore + " -> " + seq(t2)
            + ", metadata-log entries=" + meta(t2).previousFiles().size()
            + ", beat p50/p95 ms=" + pct(beats, 0.5) + "/" + pct(beats, 0.95));

    // Phase D: a manifest rewrite and snapshot expiry (what a tidy commits) do not touch the label.
    held.rewriteManifests().clusterBy(f -> "all").commit();
    held.expireSnapshots().expireOlderThan(System.currentTimeMillis()).retainLast(1).cleanExpiredFiles(true).commit();
    Table t3 = c.loadTable(id);
    System.out.println(
        "PHASE D after rewriteManifests + expire(retainLast 1): snapshots=" + meta(t3).snapshots().size()
            + " seq=" + seq(t3) + " state=" + t3.properties().get(STATE)
            + " total-records=" + t3.currentSnapshot().summary().get("total-records")
            + " operation=" + t3.currentSnapshot().operation());

    // Phase E: load times of the label.
    List<Double> loadsMs = new ArrayList<>();
    for (int i = 0; i < 200; i++) {
      long t0 = System.nanoTime();
      Table x = c.loadTable(id);
      x.properties().get(STATE);
      loadsMs.add((System.nanoTime() - t0) / 1e6);
    }
    System.out.println("PHASE E label read (loadTable) p50/p95 ms=" + pct(loadsMs, 0.5) + "/" + pct(loadsMs, 0.95));
    System.out.println("LOCATION " + t3.location());
    System.out.println("properties now: " + Arrays.toString(t3.properties().entrySet().stream().filter(e -> e.getKey().startsWith("texera")).toArray()));
  }
}
