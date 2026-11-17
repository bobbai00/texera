/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package org.apache.texera.amber.core.storage

import io.zonky.test.db.postgres.embedded.EmbeddedPostgres
import org.apache.iceberg.catalog.{Catalog, Namespace, TableIdentifier}
import org.apache.iceberg.exceptions.ServiceUnavailableException
import org.apache.iceberg.inmemory.InMemoryFileIO
import org.apache.iceberg.jdbc.JdbcCatalog
import org.apache.iceberg.{CatalogProperties, Table}
import org.scalatest.{BeforeAndAfterAll, Suite}

import scala.jdk.CollectionConverters._

/**
  * Runs a suite on Iceberg's JDBC catalog, the catalog Texera uses when it does not run
  * Lakekeeper, over an embedded Postgres of the suite's own: it needs no database server and
  * leaves nothing behind. Data and metadata files are kept in memory, since what the stores
  * under test rely on (a commit that lands whole or not at all, and that refuses a second ref
  * of one name) is the catalog's doing, not the file system's.
  *
  * A suite that mixes this in is tagged `@NonParallelTest`, so that
  * `common/workflow-core/build.sbt` gives it its own forked JVM. That is load-bearing:
  * `beforeAll` installs this catalog into the JVM-wide `IcebergCatalogInstance`, where the
  * module's other suites install a local Hadoop catalog.
  */
trait EmbeddedJdbcCatalog extends BeforeAndAfterAll { this: Suite =>

  /** The warehouse the suite's warehouse-scoped URIs name. */
  protected val warehouse = "user-1-7"

  private var postgres: EmbeddedPostgres = _
  private var catalog: JdbcCatalog = _

  override def beforeAll(): Unit = {
    super.beforeAll()
    // Loaded explicitly, as IcebergUtil.createPostgresCatalog does, for the same flaky lookup.
    Class.forName("org.postgresql.Driver")
    postgres = EmbeddedPostgres.builder().start()
    catalog = new JdbcCatalog()
    catalog.initialize(
      getClass.getSimpleName,
      Map(
        CatalogProperties.WAREHOUSE_LOCATION -> s"memory://${getClass.getSimpleName}",
        CatalogProperties.FILE_IO_IMPL -> classOf[InMemoryFileIO].getName,
        CatalogProperties.URI -> postgres.getJdbcUrl("postgres", "postgres"),
        JdbcCatalog.PROPERTY_PREFIX + "user" -> "postgres",
        JdbcCatalog.PROPERTY_PREFIX + "password" -> ""
      ).asJava
    )
    // The default warehouse and the one the warehouse-scoped URIs name: two cache entries under
    // the REST catalog type, the one shared entry under the others.
    IcebergCatalogInstance.replaceInstance(catalog)
    IcebergCatalogInstance.replaceInstance(catalog, Some(warehouse))
  }

  override def afterAll(): Unit =
    try {
      Option(catalog).foreach(_.close())
      Option(postgres).foreach(_.close())
    } finally super.afterAll()

  /** A catalog that fails every call, the way a REST catalog that cannot answer does. */
  private object UnavailableCatalog extends Catalog {
    private def unavailable(): Nothing =
      throw new ServiceUnavailableException("the catalog is unavailable")
    override def listTables(namespace: Namespace): java.util.List[TableIdentifier] = unavailable()
    override def dropTable(identifier: TableIdentifier, purge: Boolean): Boolean = unavailable()
    override def renameTable(from: TableIdentifier, to: TableIdentifier): Unit = unavailable()
    override def loadTable(identifier: TableIdentifier): Table = unavailable()
  }

  /** Runs `body` with [[UnavailableCatalog]] in place of the suite's catalog, then restores it. */
  protected def whileCatalogUnavailable(body: => Unit): Unit = {
    val warehouses = Seq(None, Some(warehouse))
    warehouses.foreach(IcebergCatalogInstance.replaceInstance(UnavailableCatalog, _))
    try body
    finally warehouses.foreach(IcebergCatalogInstance.replaceInstance(catalog, _))
  }
}
