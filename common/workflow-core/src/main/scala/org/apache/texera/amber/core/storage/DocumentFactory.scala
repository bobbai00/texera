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

import org.apache.texera.amber.core.storage.FileResolver.{
  DATASET_FILE_URI_SCHEME,
  MODEL_FILE_URI_SCHEME
}
import org.apache.texera.amber.core.storage.VFSURIFactory.{VFS_FILE_URI_SCHEME, decodeURI}
import org.apache.texera.amber.core.storage.model._
import org.apache.texera.amber.core.storage.result.iceberg.IcebergDocument
import org.apache.texera.amber.core.tuple.{Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.util.IcebergUtil
import org.apache.iceberg.catalog.{Catalog, Namespace, TableIdentifier}
import org.apache.iceberg.data.Record
import org.apache.iceberg.exceptions.NoSuchNamespaceException
import org.apache.iceberg.{Table, Schema => IcebergSchema}

import java.net.URI
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Signals that a URI addresses a document with no storage behind it, as one whose table was
  * deleted. A distinct type so callers can tell it from a document that could not be opened. It
  * is an `IllegalArgumentException` because `openDocument` has always thrown one here.
  */
class DocumentNotFoundException(message: String) extends IllegalArgumentException(message)

object DocumentFactory {

  val ICEBERG = "iceberg"

  private def sanitizeURIPath(uri: URI): String =
    uri.getPath.stripPrefix("/").replaceFirst("^wh/[^/]+/", "").replace("/", "_")

  /**
    * Open a document specified by the uri for read purposes only.
    * @param fileUri the uri of the document
    * @return ReadonlyVirtualDocument
    */
  def openReadonlyDocument(fileUri: URI): ReadonlyVirtualDocument[_] = {
    fileUri.getScheme match {
      case DATASET_FILE_URI_SCHEME | MODEL_FILE_URI_SCHEME => new LakeFSFileDocument(fileUri)
      case "file"                                          => new ReadonlyLocalFileDocument(fileUri)
      case unsupportedScheme =>
        throw new UnsupportedOperationException(
          s"Unsupported URI scheme: $unsupportedScheme for creating the ReadonlyDocument"
        )
    }
  }

  /**
    * The iceberg coordinates a VFS URI resolves to: which warehouse's catalog, which execution
    * the table is of, which namespace (the execution's, [[ExecutionNamespace]]), and which table
    * (storage key). One resolver shared by every VFS entry point below, so the decode steps
    * cannot drift apart (promised in #6944 review).
    */
  private case class IcebergLocation(
      warehouse: Option[String],
      execution: Long,
      namespace: String,
      storageKey: String
  ) {

    /** The catalog of the warehouse, for requests about the execution. */
    def catalog: Catalog = IcebergCatalogInstance.getInstance(warehouse, Some(execution))
  }

  private def resolveIcebergLocation(uri: URI): IcebergLocation = {
    val components = decodeURI(uri)
    val execution = components.executionId.id
    IcebergLocation(
      components.warehouse,
      execution,
      ExecutionNamespace.of(execution),
      sanitizeURIPath(uri)
    )
  }

  private val tupleSerde: (IcebergSchema, Tuple) => Record = IcebergUtil.toGenericRecord
  private val tupleDeserde: (IcebergSchema, Record) => Tuple = (schema, record) =>
    IcebergUtil.fromRecord(record, IcebergUtil.fromIcebergSchema(schema))

  /**
    * Create a document for storage specified by the uri.
    * This document is suitable for storing structural data, i.e. the schema is required to create such document.
    * A vfs document's table is made in the namespace of the URI's execution, which must be
    * there: no namespace is made here.
    * @param uri the location of the document
    * @param schema the schema of the data stored in the document
    * @param properties table properties the document is made with
    * @return the created document
    */
  def createDocument(
      uri: URI,
      schema: Schema,
      properties: Map[String, String] = Map.empty
  ): VirtualDocument[_] = {
    uri.getScheme match {
      case VFS_FILE_URI_SCHEME =>
        val location = resolveIcebergLocation(uri)

        val icebergSchema = IcebergUtil.toIcebergSchema(schema)
        IcebergUtil.createTable(
          location.catalog,
          location.namespace,
          location.storageKey,
          icebergSchema,
          overrideIfExists = true,
          properties
        )
        new IcebergDocument[Tuple](
          location.namespace,
          location.storageKey,
          icebergSchema,
          tupleSerde,
          tupleDeserde,
          location.warehouse,
          Some(location.execution)
        )
      case unsupportedScheme =>
        throw new UnsupportedOperationException(
          s"Unsupported URI scheme: $unsupportedScheme for creating the document"
        )
    }
  }

  /**
    * Check whether a document exists at the given URI without opening it.
    *
    * Returns true iff the underlying storage already has an entry for this
    * URI (e.g., an iceberg table at the resolved namespace + storage key).
    *
    * @throws UnsupportedOperationException if the URI scheme is not `vfs`.
    * @throws IllegalArgumentException if the URI does not decode.
    */
  def documentExists(uri: URI): Boolean = {
    uri.getScheme match {
      case VFS_FILE_URI_SCHEME =>
        val location = resolveIcebergLocation(uri)
        location.catalog.tableExists(TableIdentifier.of(location.namespace, location.storageKey))

      case unsupportedScheme =>
        throw new UnsupportedOperationException(
          s"Unsupported URI scheme: $unsupportedScheme for checking document existence"
        )
    }
  }

  /**
    * The Iceberg table a VFS URI resolves to; None when its catalog has no such table or
    * namespace, and any other failure to load it is thrown (`IcebergUtil.loadTableMetadata`).
    * For the storage layer's use of Iceberg features that a document does not expose, such as
    * the size of a table's data.
    */
  private[storage] def icebergTableOf(uri: URI): Option[Table] =
    uri.getScheme match {
      case VFS_FILE_URI_SCHEME =>
        val location = resolveIcebergLocation(uri)
        IcebergUtil.loadTableMetadata(location.catalog, location.namespace, location.storageKey)
      case unsupportedScheme =>
        throw new UnsupportedOperationException(
          s"Unsupported URI scheme: $unsupportedScheme for loading the table"
        )
    }

  /**
    * Drops the Iceberg table a VFS URI resolves to, with its rows and its tags, and purges its
    * data files. Failures are told apart as in [[icebergTableOf]].
    *
    * @return false when there was no such table or namespace
    */
  private[storage] def dropTable(uri: URI): Boolean =
    uri.getScheme match {
      case VFS_FILE_URI_SCHEME =>
        val location = resolveIcebergLocation(uri)
        try {
          location.catalog
            .dropTable(TableIdentifier.of(location.namespace, location.storageKey), true)
        } catch {
          case _: NoSuchNamespaceException => false
        }
      case unsupportedScheme =>
        throw new UnsupportedOperationException(
          s"Unsupported URI scheme: $unsupportedScheme for dropping the table"
        )
    }

  /**
    * The URIs of the tables of `resourceType` that execution `eid` of workflow `wid` has, found
    * by their names in the execution's namespace (see [[ExecutionTables.portTables]]).
    *
    * @return none when there is no such namespace
    */
  private[storage] def tablesOf(
      wid: WorkflowIdentity,
      eid: ExecutionIdentity,
      warehouse: Option[String],
      resourceType: VFSResourceType.Value
  ): Seq[URI] = namedTables(wid, eid, warehouse, resourceType).map(_._2)

  /**
    * Drops every table of `resourceType` the execution has, going by the tables' names (see
    * [[ExecutionTables.dropNamed]]), and purges their data files.
    *
    * @return the names of the tables dropped; none when there is no such namespace
    */
  private[storage] def dropTablesOf(
      wid: WorkflowIdentity,
      eid: ExecutionIdentity,
      warehouse: Option[String],
      resourceType: VFSResourceType.Value
  ): Seq[String] = {
    val catalog = IcebergCatalogInstance.getInstance(warehouse, Some(eid.id))
    val namespace = Namespace.of(ExecutionNamespace.of(eid.id))
    namedTables(wid, eid, warehouse, resourceType)
      .map(_._1)
      .filter(name => catalog.dropTable(TableIdentifier.of(namespace, name), true))
  }

  /**
    * The tables of `resourceType` in the namespace of execution `eid`, by name, each with the URI
    * it was made for. A table is named after the path of its URI, so the name gives the URI back.
    * The namespace holds the execution's tables alone; of them, these are the ones of workflow
    * `wid` whose name gives a URI of the kind back. Any other table there is no table of that
    * kind this layer made, and is left out.
    *
    * @return none when there is no such namespace
    */
  private def namedTables(
      wid: WorkflowIdentity,
      eid: ExecutionIdentity,
      warehouse: Option[String],
      resourceType: VFSResourceType.Value
  ): Seq[(String, URI)] = {
    val prefix = s"wid_${wid.id}_eid_${eid.id}_"
    val listed =
      try {
        IcebergCatalogInstance
          .getInstance(warehouse, Some(eid.id))
          .listTables(Namespace.of(ExecutionNamespace.of(eid.id)))
          .asScala
          .toSeq
      } catch { case _: NoSuchNamespaceException => Seq.empty }
    listed.map(_.name()).filter(_.startsWith(prefix)).flatMap { name =>
      Try(VFSURIFactory.uriOfPath(name.replace('_', '/'), warehouse)).toOption
        .filter { uri =>
          sanitizeURIPath(uri) == name &&
          Try(decodeURI(uri).resourceType).toOption.contains(resourceType)
        }
        .map(name -> _)
    }
  }

  /**
    * Drops the namespace of execution `eid` in `warehouse` with every table in it, each table
    * purged, its data files and all (see [[ExecutionTables.dropNamespace]]).
    *
    * @return the names of the tables dropped; none when there is no such namespace
    */
  private[storage] def dropNamespace(eid: Long, warehouse: Option[String]): Seq[String] = {
    val catalog = IcebergCatalogInstance.getInstance(warehouse, Some(eid))
    val namespace = ExecutionNamespace.of(eid)
    val listed =
      try Some(catalog.listTables(Namespace.of(namespace)).asScala.toSeq)
      catch { case _: NoSuchNamespaceException => None }
    listed.fold(Seq.empty[String]) { tables =>
      val dropped = tables.filter(table => catalog.dropTable(table, true)).map(_.name())
      IcebergUtil.dropNamespace(catalog, namespace)
      dropped
    }
  }

  /**
    * Return the document at `uri`: when `reuseExisting` is set and a document
    * already exists there, open and return the existing one -- so a caller whose
    * output accumulates across re-runs (e.g. a LoopEnd port whose region
    * re-executes once per loop iteration) keeps the already-populated document
    * instead of clobbering it, since `createDocument` overrides any existing
    * document. Otherwise create it.
    *
    * `exists` / `open` / `create` default to this object's own `documentExists`
    * / `openDocument` / `createDocument`; they are parameterized only so the
    * create-or-reuse decision can be unit-tested without an iceberg backend.
    */
  def createOrReuseDocument(
      uri: URI,
      schema: Schema,
      reuseExisting: Boolean,
      exists: URI => Boolean = documentExists,
      open: URI => VirtualDocument[_] = (u: URI) => openDocument(u)._1,
      create: (URI, Schema) => VirtualDocument[_] = createDocument(_, _)
  ): VirtualDocument[_] =
    if (reuseExisting && exists(uri)) open(uri) else create(uri, schema)

  /**
    * Open a document specified by the uri.
    * If the document is storing structural data, the schema will also be returned
    * @param uri the uri of the document
    * @return the VirtualDocument, which is the handler of the data; the Schema, which is the schema of the data stored in the document
    */
  def openDocument(uri: URI): (VirtualDocument[_], Option[Schema]) = {
    uri.getScheme match {
      case DATASET_FILE_URI_SCHEME | MODEL_FILE_URI_SCHEME =>
        (new LakeFSFileDocument(uri), None)
      case VFS_FILE_URI_SCHEME =>
        val location = resolveIcebergLocation(uri)

        val table = IcebergUtil
          .loadTableMetadata(location.catalog, location.namespace, location.storageKey)
          .getOrElse(
            throw new DocumentNotFoundException("No storage is found for the given URI")
          )

        val amberSchema = IcebergUtil.fromIcebergSchema(table.schema())
        (
          new IcebergDocument[Tuple](
            location.namespace,
            location.storageKey,
            table.schema(),
            tupleSerde,
            tupleDeserde,
            location.warehouse,
            Some(location.execution)
          ),
          Some(amberSchema)
        )
      case unsupportedScheme =>
        throw new UnsupportedOperationException(
          s"Unsupported URI scheme: $unsupportedScheme for opening the document"
        )
    }
  }
}
