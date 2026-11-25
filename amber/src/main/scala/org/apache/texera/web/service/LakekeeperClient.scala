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

package org.apache.texera.web.service

import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import com.typesafe.scalalogging.LazyLogging
import kong.unirest.{GetRequest, HttpRequestWithBody, HttpResponse, Unirest}
import org.apache.texera.auth.CatalogTokens
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.common.util.RetryUtil
import org.apache.texera.web.service.LakekeeperClient.{
  AnswerTimeoutMs,
  ConnectTimeoutMs,
  PurgeWaitPolicy,
  ServerInfo
}

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID
import scala.collection.concurrent.TrieMap
import scala.collection.mutable.ListBuffer
import scala.jdk.CollectionConverters.IteratorHasAsScala

object LakekeeperClient {

  /**
    * How long the final warehouse delete waits out Lakekeeper's asynchronous purge of the
    * dropped tables' data files, which it reports as 409 WarehouseHasUnfinishedTasks while
    * still draining (#7742). The pause starts at `initialDelayMillis` and doubles up to
    * `maxDelayMillis`: starting small keeps a fast purge (the common case) from costing the
    * caller a full fixed interval, while the growth keeps a slow one from hammering
    * Lakekeeper. With the defaults the waits between the `maxAttempts` attempts sum to
    * 0.2+0.4+0.8+1.6+3.2+5+5s ≈ 16s. Overridable for tests (a 0 initial delay keeps the
    * spec free of real sleeps — doubling 0 stays 0).
    */
  final case class PurgeWaitPolicy(
      maxAttempts: Int = 8,
      initialDelayMillis: Long = 200,
      maxDelayMillis: Long = 5000
  )

  /** What Lakekeeper tells of itself: whether a first caller has bootstrapped it. */
  final case class ServerInfo(bootstrapped: Boolean)

  /**
    * How long a call may take to connect and to answer. A create of an execution makes four of
    * them inside a request the gateway gives 120 s, which compiling and handing the plan over
    * nearly fill, so a catalog that does not answer fails the create rather than outlast it.
    */
  val ConnectTimeoutMs = 5000
  val AnswerTimeoutMs = 10000

  /** The Dashboard service's own, shared by its routes and its jobs. */
  lazy val forDeployment: LakekeeperClient = new LakekeeperClient()
}

/**
  * Client for the Lakekeeper APIs the Dashboard service uses: to set the catalog up
  * ([[CatalogSetup]]), to manage per-user warehouses (#6870), and to let each execution use its
  * own namespace and nothing else (`ExecutionCatalogAccess`).
  *
  * Two API families are involved: the **management** API (`/management/v1/...`) bootstraps the
  * server and manages projects, warehouses, users and their grants, and the **catalog** API
  * (`/catalog/v1/{prefix}/...`) lists, finds and drops the namespaces and tables inside one
  * warehouse, whose prefix is its id. Every call carries the platform's token
  * ([[CatalogTokens.platform]]), which names the catalog's operator.
  *
  * A path segment this client sends is percent-encoded but for the characters RFC 3986 leaves
  * unreserved, so a catalog user's id such as `oidc~texera-execution-42` goes as it is.
  *
  * @param catalogUri the Iceberg REST catalog uri (ends with `/catalog`), from which the
  *                   management base is derived. Overridable for tests.
  * @param purgeWait how long the final warehouse delete waits out Lakekeeper's asynchronous
  *                  purge of the dropped tables' data files (#7742).
  */
class LakekeeperClient(
    catalogUri: String = StorageConfig.icebergRESTCatalogUri,
    purgeWait: PurgeWaitPolicy = PurgeWaitPolicy()
) extends LazyLogging {

  // Lakekeeper's default project; single-project deployments (ours) use the nil UUID.
  private val DefaultProjectId = "00000000-0000-0000-0000-000000000000"

  private val managementBase: String = catalogUri.stripSuffix("/catalog") + "/management/v1"
  private val catalogBase: String = catalogUri + "/v1"

  private val mapper = new ObjectMapper()

  // The catalog prefix of each warehouse looked up so far, by its name: the warehouse's id,
  // which no warehouse of a name ever changes.
  private val prefixes = TrieMap.empty[String, String]

  private def segment(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20").replace("%7E", "~")

  private def authorization: String = s"Bearer ${CatalogTokens.platform()}"

  private def get(url: String): GetRequest =
    Unirest
      .get(url)
      .header("Authorization", authorization)
      .connectTimeout(ConnectTimeoutMs)
      .socketTimeout(AnswerTimeoutMs)

  private def delete(url: String): HttpRequestWithBody =
    Unirest
      .delete(url)
      .header("Authorization", authorization)
      .connectTimeout(ConnectTimeoutMs)
      .socketTimeout(AnswerTimeoutMs)

  private def post(url: String, payload: JsonNode): HttpResponse[String] =
    Unirest
      .post(url)
      .header("Authorization", authorization)
      .header("Content-Type", "application/json")
      .connectTimeout(ConnectTimeoutMs)
      .socketTimeout(AnswerTimeoutMs)
      .body(payload.toString)
      .asString()

  private def failOn(status: Int, body: String, action: String): Unit =
    if (status < 200 || status >= 300) {
      throw new RuntimeException(s"Lakekeeper $action failed (HTTP $status): $body")
    }

  /** The `error.type` of an error Lakekeeper answered; None for a body that is no such error. */
  private def errorTypeOf(body: String): Option[String] =
    try {
      Option(mapper.readTree(body))
        .map(_.path("error").path("type"))
        .filter(_.isTextual)
        .map(_.asText())
    } catch {
      case _: Exception => None
    }

  /** Whether the server has been bootstrapped: `GET /management/v1/info`. */
  def info(): ServerInfo = {
    val response = get(s"$managementBase/info").asString()
    failOn(response.getStatus, response.getBody, "read the server's info")
    val bootstrapped = mapper.readTree(response.getBody).path("bootstrapped")
    if (!bootstrapped.isBoolean) {
      throw new RuntimeException(s"Lakekeeper's info tells no bootstrap: ${response.getBody}")
    }
    ServerInfo(bootstrapped.asBoolean())
  }

  /**
    * Bootstraps the server, which makes the caller, the platform, its operator: an application
    * named Texera. A server another caller bootstrapped meanwhile is bootstrapped too.
    */
  def bootstrap(): Unit = {
    val payload = mapper
      .createObjectNode()
      .put("accept-terms-of-use", true)
      .put("is-operator", true)
      .put("user-type", "application")
      .put("user-name", "Texera")
    val response = post(s"$managementBase/bootstrap", payload)
    val bootstrappedBefore = response.getStatus == 400 &&
      errorTypeOf(response.getBody).contains("CatalogAlreadyBootstrapped")
    if (!bootstrappedBefore) failOn(response.getStatus, response.getBody, "bootstrap")
  }

  /**
    * Makes Lakekeeper's default project, the one every warehouse is in, unless it is there: a
    * project of its id that is there already (409) is the one.
    */
  def ensureDefaultProject(): Unit = {
    val payload = mapper
      .createObjectNode()
      .put("project-id", DefaultProjectId)
      .put("project-name", "default")
    val response = post(s"$managementBase/project", payload)
    if (response.getStatus != 409) {
      failOn(response.getStatus, response.getBody, "create the default project")
    }
  }

  /**
    * Makes the warehouse named `name` that executions write into when they name none, with the
    * key prefix `keyPrefix` in this deployment's bucket. One that is there keeps its profile but
    * for its endpoint, which is set to this deployment's again (#6195): a local deployment
    * reaches its object store at the host's address, which changes with the network.
    */
  def ensureSharedWarehouse(name: String, keyPrefix: String): Unit =
    warehouseNamed(name) match {
      case Some(stored) => refreshEndpoint(stored)
      case None =>
        val response = post(s"$managementBase/warehouse", warehousePayload(name, keyPrefix))
        if (response.getStatus == 409) {
          // Another replica made it meanwhile.
          refreshEndpoint(warehouseNamed(name).getOrElse {
            throw new RuntimeException(
              s"Lakekeeper refused to create warehouse '$name' (HTTP 409), and has none of " +
                s"that name: ${response.getBody}"
            )
          })
        } else failOn(response.getStatus, response.getBody, s"create warehouse '$name'")
    }

  /**
    * Creates a warehouse backed by this deployment's own object store (the Local flavor):
    * the storage profile points at the configured S3 endpoint and bucket, with the
    * platform's static credentials and STS off.
    *
    * @return the Lakekeeper-assigned warehouse id.
    */
  def createWarehouse(warehouseName: String): UUID = {
    // The warehouse name doubles as the key prefix, so each warehouse owns a distinct
    // subtree of the shared bucket.
    val response =
      post(s"$managementBase/warehouse", warehousePayload(warehouseName, warehouseName))
    failOn(response.getStatus, response.getBody, s"create warehouse '$warehouseName'")
    UUID.fromString(mapper.readTree(response.getBody).get("warehouse-id").asText())
  }

  /**
    * The id Lakekeeper gave namespace `namespace` of the warehouse named `warehouseName`, which
    * grants name it by; None when there is no such namespace.
    */
  def namespaceIdOf(warehouseName: String, namespace: String): Option[String] = {
    val response =
      get(s"$catalogBase/${prefixOf(warehouseName)}/namespaces/${segment(namespace)}").asString()
    if (response.getStatus == 404) None
    else {
      failOn(response.getStatus, response.getBody, s"look up namespace '$namespace'")
      val id = mapper.readTree(response.getBody).path("properties").path("namespace_id")
      if (!id.isTextual) {
        throw new RuntimeException(
          s"Lakekeeper answered namespace '$namespace' with no id: ${response.getBody}"
        )
      }
      Some(id.asText())
    }
  }

  /** Makes the catalog user `id`, an application named `name`, unless it is there. */
  def createUser(id: String, name: String): Unit = {
    val payload = mapper
      .createObjectNode()
      .put("id", id)
      .put("name", name)
      .put("user-type", "application")
      .put("update-if-exists", true)
    val response = post(s"$managementBase/user", payload)
    failOn(response.getStatus, response.getBody, s"create user '$id'")
  }

  /**
    * Grants catalog user `user` each of `kinds` (such as `select`) on the namespace whose id is
    * `namespaceId`. A grant the user holds already is granted.
    */
  def grantNamespace(namespaceId: String, user: String, kinds: Seq[String]): Unit = {
    val url = s"$managementBase/permissions/namespace/${segment(namespaceId)}/assignments"
    val payload = mapper.createObjectNode()
    val writes = payload.putArray("writes")
    kinds.foreach(kind => writes.addObject().put("type", kind).put("user", user))
    val response = post(url, payload)
    if (!isSuccess(response.getStatus) && !holds(url, user, kinds)) {
      failOn(response.getStatus, response.getBody, s"grant $user on namespace $namespaceId")
    }
  }

  /** Whether the assignments at `url` give catalog user `user` every one of `kinds`. */
  private def holds(url: String, user: String, kinds: Seq[String]): Boolean = {
    val response = get(url).asString()
    isSuccess(response.getStatus) && {
      val held = mapper
        .readTree(response.getBody)
        .path("assignments")
        .iterator()
        .asScala
        .filter(_.path("user").asText() == user)
        .map(_.path("type").asText())
        .toSet
      kinds.forall(held.contains)
    }
  }

  /**
    * Deletes catalog user `id`, and with it every grant and ownership it holds: a token that
    * names it can do nothing any more. A user that is not there is deleted.
    */
  def deleteUser(id: String): Unit = {
    val response = delete(s"$managementBase/user/${segment(id)}").asString()
    if (response.getStatus != 404) {
      failOn(response.getStatus, response.getBody, s"delete user '$id'")
    }
  }

  /**
    * Drops namespace `namespace` of warehouse `warehouseName` with everything in it: its tables,
    * each with its files, its views and the namespaces in it, protected or not. So nothing an
    * execution's token may make in its namespace keeps the namespace from going. A namespace
    * that is not there is dropped.
    */
  def dropNamespace(warehouseName: String, namespace: String): Unit = {
    val response =
      delete(s"$catalogBase/${prefixOf(warehouseName)}/namespaces/${segment(namespace)}")
        .queryString("recursive", "true")
        .queryString("purge", "true")
        .queryString("force", "true")
        .asString()
    if (response.getStatus != 404) {
      failOn(response.getStatus, response.getBody, s"drop namespace '$namespace'")
    }
  }

  /**
    * Deletes a warehouse **empty-first** (Lakekeeper refuses to drop a non-empty one):
    * every table is dropped with `purgeRequested=true` — so the underlying data files are
    * purged along with it, matching how execution results are deleted today — then the
    * namespaces, then the warehouse entity itself.
    */
  def deleteWarehouseEmptyFirst(lakekeeperWarehouseId: UUID): Unit = {
    // 404 anywhere below means the entity is already gone — the goal state. Tolerating
    // it makes this method idempotent, so a retry after a partial failure (e.g. the DB
    // delete failing after the Lakekeeper delete succeeded) heals instead of wedging.
    listNamespaces(lakekeeperWarehouseId).foreach { namespace =>
      listTables(lakekeeperWarehouseId, namespace).foreach { table =>
        val response = delete(
          s"$catalogBase/$lakekeeperWarehouseId/namespaces/${segment(namespace)}/tables/${segment(table)}"
        ).queryString("purgeRequested", "true")
          .asString()
        if (response.getStatus != 404) {
          failOn(response.getStatus, response.getBody, s"drop table '$namespace.$table'")
        }
      }
      val response =
        delete(s"$catalogBase/$lakekeeperWarehouseId/namespaces/${segment(namespace)}").asString()
      if (response.getStatus != 404) {
        failOn(response.getStatus, response.getBody, s"drop namespace '$namespace'")
      }
    }
    // The drops above purge each table's data files asynchronously (Lakekeeper task
    // queue `tabular_purge`), and Lakekeeper refuses to delete the warehouse while
    // any purge is pending — the tasks need the warehouse's storage profile to reach
    // S3, so deleting it first would orphan them and leak the files. It answers 409
    // WarehouseHasUnfinishedTasks until the queue drains (normally within seconds),
    // so ride that out with a bounded retry; every other error, including any other
    // 409, still fails immediately. (#7742)
    RetryUtil.withBackoff(
      description = DeleteWarehouseAction,
      maxAttempts = purgeWait.maxAttempts,
      initialDelayMillis = purgeWait.initialDelayMillis,
      onRetry = attempt => logger.warn(attempt.message),
      maxDelayMillis = purgeWait.maxDelayMillis,
      shouldRetry = _.isInstanceOf[UnfinishedTasksConflictException]
    ) {
      val response = delete(s"$managementBase/warehouse/$lakekeeperWarehouseId").asString()
      response.getStatus match {
        case 404 => // already gone — the idempotent goal state
        case 409 if errorTypeOf(response.getBody).contains("WarehouseHasUnfinishedTasks") =>
          throw new UnfinishedTasksConflictException(response.getBody)
        case status => failOn(status, response.getBody, DeleteWarehouseAction)
      }
    }
  }

  private val DeleteWarehouseAction = "delete warehouse"

  /** Tags the one retryable delete failure so the backoff predicate can single it out. */
  private class UnfinishedTasksConflictException(body: String)
      extends RuntimeException(s"Lakekeeper $DeleteWarehouseAction failed (HTTP 409): $body")

  private def isSuccess(status: Int): Boolean = status >= 200 && status < 300

  /**
    * What a warehouse named `name` is made with: this deployment's bucket, under `keyPrefix`,
    * at its object store's endpoint and region, reached by path, with the platform's static
    * credentials and STS off.
    */
  private def warehousePayload(name: String, keyPrefix: String): ObjectNode = {
    val payload = mapper.createObjectNode()
    payload.put("warehouse-name", name)
    payload.put("project-id", DefaultProjectId)
    val profile = payload.putObject("storage-profile")
    profile.put("type", "s3")
    profile.put("bucket", StorageConfig.icebergRESTCatalogS3Bucket)
    profile.put("key-prefix", keyPrefix)
    profile.put("region", StorageConfig.s3Region)
    profile.put("endpoint", StorageConfig.s3Endpoint)
    profile.put("flavor", "s3-compat")
    profile.put("path-style-access", true)
    profile.put("sts-enabled", false)
    payload.set[JsonNode]("storage-credential", storageCredential())
    payload
  }

  private def storageCredential(): ObjectNode =
    mapper
      .createObjectNode()
      .put("type", "s3")
      .put("credential-type", "access-key")
      .put("aws-access-key-id", StorageConfig.s3Username)
      .put("aws-secret-access-key", StorageConfig.s3Password)

  /**
    * Sets the endpoint of `stored`, a warehouse as Lakekeeper lists it, to this deployment's,
    * with the platform's credentials. The rest of its profile stays as stored: Lakekeeper refuses
    * a profile whose key prefix or region would change.
    */
  private def refreshEndpoint(stored: JsonNode): Unit = {
    val id = stored.path("warehouse-id").asText()
    val profile = stored.path("storage-profile")
    if (!profile.isObject) {
      throw new RuntimeException(s"Lakekeeper lists warehouse $id with no storage profile.")
    }
    val payload = mapper.createObjectNode()
    payload.set[JsonNode](
      "storage-profile",
      profile.deepCopy[ObjectNode]().put("endpoint", StorageConfig.s3Endpoint)
    )
    payload.set[JsonNode]("storage-credential", storageCredential())
    val response = post(s"$managementBase/warehouse/${segment(id)}/storage", payload)
    failOn(response.getStatus, response.getBody, s"refresh the storage of warehouse $id")
  }

  /** The warehouse named `name`, as Lakekeeper lists it; None when there is none. */
  private def warehouseNamed(name: String): Option[JsonNode] = {
    val response = get(s"$managementBase/warehouse").asString()
    failOn(response.getStatus, response.getBody, "list warehouses")
    mapper
      .readTree(response.getBody)
      .path("warehouses")
      .iterator()
      .asScala
      .find(_.path("name").asText() == name)
  }

  /** The catalog prefix of the warehouse named `warehouseName`, looked up once. */
  private def prefixOf(warehouseName: String): String =
    prefixes.getOrElse(
      warehouseName, {
        val response =
          get(s"$catalogBase/config").queryString("warehouse", warehouseName).asString()
        failOn(response.getStatus, response.getBody, s"read the config of '$warehouseName'")
        val config = mapper.readTree(response.getBody)
        val prefix = Seq("overrides", "defaults")
          .map(config.path(_).path("prefix"))
          .find(_.isTextual)
          .map(_.asText())
          .getOrElse {
            throw new RuntimeException(
              s"Lakekeeper's config of '$warehouseName' names no prefix: ${response.getBody}"
            )
          }
        prefixes.putIfAbsent(warehouseName, prefix).getOrElse(prefix)
      }
    )

  /** Top-level namespaces in the warehouse. Texera's execution namespaces are single-level. */
  private def listNamespaces(lakekeeperWarehouseId: UUID): List[String] =
    fetchAllPages(
      s"$catalogBase/$lakekeeperWarehouseId/namespaces",
      "namespaces",
      "list namespaces"
    )(parts => parts.get(0).asText())

  private def listTables(lakekeeperWarehouseId: UUID, namespace: String): List[String] =
    fetchAllPages(
      s"$catalogBase/$lakekeeperWarehouseId/namespaces/${segment(namespace)}/tables",
      "identifiers",
      s"list tables of '$namespace'"
    )(identifier => identifier.get("name").asText())

  /**
    * Follows `next-page-token` until exhausted: the Iceberg REST list endpoints may
    * return partial pages, and the empty-first delete depends on seeing everything.
    * A 404 ends the listing with what was gathered — the entity is already gone,
    * which the idempotent delete treats as its goal state.
    */
  private def fetchAllPages(url: String, field: String, action: String)(
      extract: JsonNode => String
  ): List[String] = {
    val results = ListBuffer[String]()
    var pageToken: Option[String] = None
    do {
      val request = get(url)
      pageToken.foreach(request.queryString("pageToken", _))
      val response = request.asString()
      if (response.getStatus == 404) {
        return results.toList
      }
      failOn(response.getStatus, response.getBody, action)
      val tree = mapper.readTree(response.getBody)
      tree.get(field).iterator().asScala.foreach(node => results += extract(node))
      pageToken = Option(tree.get("next-page-token"))
        .filterNot(_.isNull)
        .map(_.asText())
        .filter(_.nonEmpty)
    } while (pageToken.isDefined)
    results.toList
  }
}
