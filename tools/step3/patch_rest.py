"""Temporary, never committed: points the storage specs at the catalog the environment
configures (a REST catalog), instead of the local Hadoop catalog and the embedded JDBC one."""
import sys
root = sys.argv[1]
t = root + '/common/workflow-core/src/test/scala/org/apache/texera/amber/core/storage/'

p = t + 'result/iceberg/RecordTables.scala'
s = open(p).read()
a = '''    catalog = IcebergUtil.createHadoopCatalog("record-tables-spec", warehouseDir)
'''
assert s.count(a) == 1
s = s.replace(a, '''    catalog = org.apache.texera.amber.core.storage.IcebergCatalogInstance.getInstance()
''')
# The catalog is the JVM's shared one here: the suites that run after this one still need it.
a = '''      catalog match {
        case closeable: AutoCloseable => closeable.close()
        case _                        =>
      }
'''
assert s.count(a) == 1
s = s.replace(a, '')
open(p, 'w').write(s)

p = t + 'EmbeddedJdbcCatalog.scala'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
rep('''  protected val warehouse = "user-1-7"''', '''  protected val warehouse = "texera"''')
rep('''  private var catalog: JdbcCatalog = _''', '''  private var catalog: Catalog = _''')
i = s.index('''    // Loaded explicitly, as IcebergUtil.createPostgresCatalog does''')
j = s.index('''    // The default warehouse and the one the warehouse-scoped URIs name''')
s = s[:i] + '''    catalog = IcebergCatalogInstance.getInstance()
''' + s[j:]
rep('''      Option(catalog).foreach(_.close())
      Option(postgres).foreach(_.close())
''', '''      Option(postgres).foreach(_.close())
''')
open(p, 'w').write(s)

p = t + 'result/iceberg/IcebergAppenderSpec.scala'
s = open(p).read()
i = s.rstrip().rfind('}')
s = s[:i] + '''
  "BENCH" should "time the commits on this catalog" in {
    val table = newTable()
    def timed(n: Int)(body: Int => Unit): Seq[Double] =
      (1 to n).map { i =>
        val start = System.nanoTime()
        body(i)
        (System.nanoTime() - start) / 1e6
      }
    def p(xs: Seq[Double], q: Double): String = f"${xs.sorted.apply(((xs.size - 1) * q).toInt)}%.1f"
    def report(name: String, xs: Seq[Double]): Unit =
      info(s"BENCH $name: p50 ${p(xs, 0.5)} ms, p95 ${p(xs, 0.95)} ms (n=${xs.size})")
    timed(10)(i => append(table, Seq(i.toLong)))
    report("append, plain fast append", timed(40)(i => append(table, Seq(100L + i))))
    report(
      "append with properties, one transaction",
      timed(40)(i => append(table, Seq(200L + i), Map("spec.seq" -> i.toString)))
    )
    report(
      "append in a transaction without properties",
      timed(40) { i =>
        val file = IcebergAppender.writeDataFile(table, Seq(record(table, 300L + i, "x")), "rows")
        val transaction = table.newTransaction()
        transaction.newFastAppend().appendFile(file).commit()
        transaction.commitTransaction()
      }
    )
    report(
      "write a data file only",
      timed(40)(i => IcebergAppender.writeDataFile(table, Seq(record(table, 400L + i, "x")), "probe"))
    )
    report(
      "properties only (a beat)",
      timed(40)(i => IcebergAppender.setProperties(table, Map("spec.beat" -> i.toString)))
    )
    report("load the table (a label read)", timed(100)(_ => loaded(table).properties().get("spec.beat")))
    val fresh = newTable()
    (1 to 50).foreach(i => append(fresh, Seq(i.toLong, i + 1000L, i + 2000L)))
    report("read 50 files of 3 rows", timed(5)(_ => readSeqs(fresh)))
    report("tidy after 50 appends, mid-run", timed(1)(_ => IcebergTidy.tidy(loaded(fresh), atEnd = false)))
    report("read after the tidy", timed(5)(_ => readSeqs(fresh)))
    (1 to 50).foreach(i => append(fresh, Seq(3000L + i)))
    report("tidy after 50 more appends, at the end", timed(1)(_ => IcebergTidy.tidy(loaded(fresh), atEnd = true)))
  }
}
'''
open(p, 'w').write(s)
print("patched")
