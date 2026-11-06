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

import org.apache.iceberg.catalog.Catalog
import org.apache.texera.amber.util.IcebergUtil
import org.apache.texera.common.config.StorageConfig

import java.nio.file.{Files, Path}
import java.util.Comparator

/**
  * Test-only helper that installs a local Hadoop-backed Iceberg catalog into the
  * shared `IcebergCatalogInstance` singleton exactly once per JVM.
  *
  * The default configured catalog type is `rest`, which needs a live REST server;
  * unit tests instead exercise Iceberg against a temp-directory `file:/` warehouse
  * (via the merged winutils-free local filesystem on Windows).
  *
  * `IcebergCatalogInstance` is a JVM-wide mutable singleton and ScalaTest runs
  * suites in the module in parallel within the same JVM, so every suite that needs
  * an Iceberg backend calls [[ensure]]. Initialization is idempotent and guarded by
  * a single flag on this shared object, so the very first caller wins and all
  * suites end up sharing the same catalog + warehouse instead of racing on
  * `replaceInstance`. Suites keep their tables disjoint via distinct namespaces and
  * unique (UUID) table names.
  */
object LocalHadoopIcebergCatalog {

  private var catalog: Option[Catalog] = None

  /**
    * Installs the shared local catalog, additionally registering it under each of
    * `warehouses`.
    *
    * A suite that exercises a warehouse-scoped URI must name that warehouse here:
    * under the configured `rest` catalog type the cache is keyed by warehouse name,
    * so an unregistered name would miss and try to build a *live* REST catalog,
    * making the suite pass or fail according to the machine's catalog config rather
    * than the code under test.
    */
  def ensure(warehouses: String*): Unit =
    synchronized {
      val installed = catalog.getOrElse {
        val created = localCatalog("wfcore-test", "wfcore-iceberg-shared")
        catalog = Some(created)
        IcebergCatalogInstance.replaceInstance(created)
        created
      }
      warehouses.foreach(name => IcebergCatalogInstance.replaceInstance(installed, Some(name)))
    }

  /**
    * Whether a named warehouse is a catalog of its own. Only the `rest` catalog type
    * is scoped to a warehouse; the others share one catalog whatever the name.
    */
  def warehousesAreSeparate: Boolean = StorageConfig.icebergCatalogType == "rest"

  /**
    * Registers a catalog of its own under `warehouse`, so a suite can tell a table in
    * a named warehouse from one in the default warehouse. Only for a suite that has
    * checked [[warehousesAreSeparate]]: under the other catalog types every name
    * shares one entry, and this would replace the catalog all suites share.
    */
  def installSeparate(warehouse: String): Unit = {
    require(warehousesAreSeparate, "every warehouse shares one catalog under this catalog type")
    IcebergCatalogInstance.replaceInstance(
      localCatalog(s"wfcore-test-$warehouse", s"wfcore-iceberg-$warehouse"),
      Some(warehouse)
    )
  }

  private def localCatalog(name: String, directoryPrefix: String): Catalog = {
    val warehouse = Files.createTempDirectory(directoryPrefix)
    // Best-effort recursive cleanup of the temp warehouse on JVM exit so test runs
    // don't leave wfcore-iceberg-* directories behind on dev machines / CI.
    sys.addShutdownHook {
      try Files
        .walk(warehouse)
        .sorted(Comparator.reverseOrder[Path]())
        .forEach((p: Path) => Files.deleteIfExists(p))
      catch { case _: Throwable => () }
    }
    IcebergUtil.createHadoopCatalog(name, warehouse)
  }
}
