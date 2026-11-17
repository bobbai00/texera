import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.apache.iceberg.CatalogProperties;
import org.apache.iceberg.DataFile;
import org.apache.iceberg.PartitionSpec;
import org.apache.iceberg.Schema;
import org.apache.iceberg.Table;
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
 * What a few hundred open executions cost Lakekeeper: every run's tick is one appended file
 * (statistics) plus one properties-only commit (the beat); the Dashboard's tick is one loadTable
 * per open execution, 8 at a time.
 */
public class ManyRunsProbe {
  static final Schema SCHEMA =
      new Schema(
          Types.NestedField.optional(1, "seq", Types.LongType.get()),
          Types.NestedField.optional(2, "timeMs", Types.LongType.get()),
          Types.NestedField.optional(3, "kind", Types.StringType.get()));

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
      r.setField("kind", "x");
      w.write(r);
    } finally {
      w.close();
    }
    return w.toDataFile();
  }

  static String pct(List<Double> xs, double p) {
    List<Double> a = new ArrayList<>(xs);
    Collections.sort(a);
    return a.isEmpty() ? "-" : String.format("%.0f", a.get((int) Math.min(a.size() - 1, Math.floor(p * a.size()))));
  }

  public static void main(String[] args) throws Exception {
    String uri = args[0];
    String wh = args[1];
    int tables = Integer.parseInt(args[2]);
    int rounds = Integer.parseInt(args[3]);
    RESTCatalog c = catalog(uri, wh);
    Namespace ns = Namespace.of("step3-many");
    try {
      c.createNamespace(ns);
    } catch (Exception e) {
      // exists
    }
    long stamp = System.currentTimeMillis();
    List<TableIdentifier> ids = new ArrayList<>();
    for (int i = 0; i < tables; i++) ids.add(TableIdentifier.of(ns, "t_" + stamp + "_" + i));
    ExecutorService setup = Executors.newFixedThreadPool(16);
    List<Future<Table>> made = new ArrayList<>();
    for (TableIdentifier id : ids) made.add(setup.submit(() -> c.createTable(id, SCHEMA, PartitionSpec.unpartitioned())));
    List<Table> held = new ArrayList<>();
    for (Future<Table> f : made) held.add(f.get());
    setup.shutdown();
    System.out.println("created " + tables + " tables");

    for (int threads : new int[] {8, 32, 64}) {
      ExecutorService pool = Executors.newFixedThreadPool(threads);
      List<Double> tickMs = Collections.synchronizedList(new ArrayList<>());
      List<Double> beatMs = Collections.synchronizedList(new ArrayList<>());
      long t0 = System.nanoTime();
      List<Future<Object>> fs = new ArrayList<>();
      for (int r = 0; r < rounds; r++) {
        final int round = r;
        for (int i = 0; i < tables; i++) {
          final Table t = held.get(i);
          final int ti = i;
          Callable<Object> job =
              () -> {
                long a = System.nanoTime();
                DataFile df = writeRow(t, "s_" + threads + "_" + round + "_" + ti, round);
                t.newFastAppend().appendFile(df).commit();
                long b = System.nanoTime();
                t.updateProperties().set("texera.execution.beat-ms", Long.toString(System.currentTimeMillis())).commit();
                long d = System.nanoTime();
                tickMs.add((d - a) / 1e6);
                beatMs.add((d - b) / 1e6);
                return null;
              };
          fs.add(pool.submit(job));
        }
      }
      for (Future<Object> f : fs) f.get();
      double secs = (System.nanoTime() - t0) / 1e9;
      pool.shutdown();
      int commits = 2 * tables * rounds;
      System.out.println(
          String.format(
              "concurrency %d: %d ticks (append + beat = %d commits) in %.1f s = %.0f commits/s; tick p50/p95 ms=%s/%s; beat p50/p95 ms=%s/%s",
              threads, tables * rounds, commits, secs, commits / secs, pct(tickMs, 0.5), pct(tickMs, 0.95), pct(beatMs, 0.5), pct(beatMs, 0.95)));
    }

    // The Dashboard's tick: one loadTable per open execution, 8 at a time, fresh catalog client.
    RESTCatalog dash = catalog(uri, wh);
    for (int pass = 0; pass < 3; pass++) {
      ExecutorService pool = Executors.newFixedThreadPool(8);
      long t0 = System.nanoTime();
      List<Future<String>> fs = new ArrayList<>();
      for (TableIdentifier id : ids) fs.add(pool.submit(() -> dash.loadTable(id).properties().get("texera.execution.beat-ms")));
      for (Future<String> f : fs) f.get();
      System.out.println(String.format("dashboard sweep %d: %d labels, 8 at a time, %.0f ms", pass, tables, (System.nanoTime() - t0) / 1e6));
      pool.shutdown();
    }
  }
}
