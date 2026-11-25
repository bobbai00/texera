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

package org.apache.texera.web.resource.dashboard.user.quota

import org.apache.iceberg.catalog.{Namespace, SupportsNamespaces}
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionLogStore,
  ExecutionNamespace,
  ExecutionTables,
  IcebergCatalogInstance,
  VFSURIFactory
}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables._
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.daos.{
  DatasetDao,
  UserDao,
  WorkflowDao,
  WorkflowExecutionsDao,
  WorkflowOfUserDao,
  WorkflowUserAccessDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  Dataset,
  User,
  Workflow,
  WorkflowExecutions,
  WorkflowOfUser,
  WorkflowUserAccess,
  WorkflowVersion
}
import org.apache.texera.web.service.execution.{
  ExecutionCatalogAccess,
  ExecutionExpiry,
  RecordingCatalogAccess
}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec

import java.net.URI
import java.sql.Timestamp
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import scala.jdk.CollectionConverters._
import javax.ws.rs.WebApplicationException

class UserQuotaResourceSpec extends AnyFlatSpec with BeforeAndAfterAll with MockTexeraDB {

  private val testUid = 4000 + scala.util.Random.nextInt(1000)
  private val testWid = 5000 + scala.util.Random.nextInt(1000)

  private var userDao: UserDao = _
  private var workflowDao: WorkflowDao = _
  private var workflowVersionDao: WorkflowVersionDao = _
  private var workflowOfUserDao: WorkflowOfUserDao = _
  private var workflowUserAccessDao: WorkflowUserAccessDao = _
  private var workflowExecutionsDao: WorkflowExecutionsDao = _
  private var datasetDao: DatasetDao = _

  private var testUser: User = _
  private var testWorkflow: Workflow = _
  private var testVersion: WorkflowVersion = _

  /** The executions whose large binaries a delete would have deleted: none is, in this suite. */
  private val binariesDeletedFor = new ConcurrentLinkedQueue[Long]()

  /**
    * What a delete drops of the executions' namespaces, in the catalog the build's tests use,
    * with what it ends of their tokens kept, as on a REST catalog.
    */
  private val catalogAccess = new RecordingCatalogAccess()

  /** An expiry whose lake calls are the stores', and which deletes no large binary. */
  private val expiry = new ExecutionExpiry(
    warehousesEnabled = false,
    deleteBinaries = eid => binariesDeletedFor.add(eid),
    access = catalogAccess
  )
  private val resource = new UserQuotaResource(expiry)

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()

    userDao = new UserDao(getDSLContext.configuration())
    workflowDao = new WorkflowDao(getDSLContext.configuration())
    workflowVersionDao = new WorkflowVersionDao(getDSLContext.configuration())
    workflowOfUserDao = new WorkflowOfUserDao(getDSLContext.configuration())
    workflowUserAccessDao = new WorkflowUserAccessDao(getDSLContext.configuration())
    workflowExecutionsDao = new WorkflowExecutionsDao(getDSLContext.configuration())
    datasetDao = new DatasetDao(getDSLContext.configuration())
  }

  override protected def afterAll(): Unit = shutdownDB()

  // Each test starts from a clean slate for the ids under test, then seeds
  // only what it needs, so tests are order-independent.
  private def resetFixtures(): Unit = {
    cleanupTestData()

    testUser = new User
    testUser.setUid(testUid)
    testUser.setName("quota_user")
    testUser.setEmail("quota@example.com")
    userDao.insert(testUser)

    testWorkflow = new Workflow
    testWorkflow.setWid(testWid)
    testWorkflow.setName("quota_workflow_" + UUID.randomUUID().toString.substring(0, 8))
    testWorkflow.setContent("{}")
    testWorkflow.setDescription("desc")
    testWorkflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
    testWorkflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))
    workflowDao.insert(testWorkflow)

    testVersion = new WorkflowVersion
    testVersion.setWid(testWid)
    testVersion.setContent("{}")
    testVersion.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflowVersionDao.insert(testVersion)
  }

  private def cleanupTestData(): Unit = {
    val vidSubquery = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(testWid))

    getDSLContext
      .deleteFrom(WORKFLOW_EXECUTIONS)
      .where(WORKFLOW_EXECUTIONS.VID.in(vidSubquery))
      .execute()
    getDSLContext.deleteFrom(WORKFLOW_VERSION).where(WORKFLOW_VERSION.WID.eq(testWid)).execute()
    getDSLContext
      .deleteFrom(WORKFLOW_USER_ACCESS)
      .where(WORKFLOW_USER_ACCESS.UID.eq(testUid))
      .execute()
    getDSLContext.deleteFrom(WORKFLOW_OF_USER).where(WORKFLOW_OF_USER.UID.eq(testUid)).execute()
    getDSLContext.deleteFrom(WORKFLOW).where(WORKFLOW.WID.eq(testWid)).execute()
    getDSLContext.deleteFrom(DATASET).where(DATASET.OWNER_UID.eq(testUid)).execute()
    getDSLContext.deleteFrom(USER).where(USER.UID.eq(testUid)).execute()
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private def insertOwnership(): Unit = {
    val ownership = new WorkflowOfUser
    ownership.setUid(testUid)
    ownership.setWid(testWid)
    workflowOfUserDao.insert(ownership)
  }

  private def insertAccess(): Unit = {
    val access = new WorkflowUserAccess
    access.setUid(testUid)
    access.setWid(testWid)
    access.setPrivilege(PrivilegeEnum.READ)
    workflowUserAccessDao.insert(access)
  }

  private def insertWriteAccess(): Unit = {
    val access = new WorkflowUserAccess
    access.setUid(testUid)
    access.setWid(testWid)
    access.setPrivilege(PrivilegeEnum.WRITE)
    workflowUserAccessDao.insert(access)
  }

  private def insertExecution(): WorkflowExecutions = {
    val execution = new WorkflowExecutions
    execution.setVid(testVersion.getVid)
    execution.setUid(testUid)
    execution.setLogLocation("")
    execution.setStartingTime(new Timestamp(System.currentTimeMillis()))
    execution.setBookmarked(false)
    execution.setName("exec-" + UUID.randomUUID().toString.substring(0, 8))
    execution.setEnvironmentVersion("test-env-1.0")
    workflowExecutionsDao.insert(execution)
    execution
  }

  private def insertDataset(): Dataset = {
    val dataset = new Dataset
    dataset.setOwnerUid(testUid)
    dataset.setName("quota_ds_" + UUID.randomUUID().toString.substring(0, 8))
    dataset.setRepositoryName("repo-" + UUID.randomUUID().toString.substring(0, 8))
    dataset.setIsPublic(false)
    dataset.setIsDownloadable(true)
    dataset.setDescription("")
    dataset.setCreationTime(new Timestamp(System.currentTimeMillis()))
    datasetDao.insert(dataset)
    dataset
  }

  // ─── getUserCreatedWorkflow ────────────────────────────────────────────────

  "getUserCreatedWorkflow" should "return an empty list when the user owns no workflows" in {
    resetFixtures()
    assert(UserQuotaResource.getUserCreatedWorkflow(testUid).isEmpty)
  }

  it should "return the workflows owned by the user with their names and timestamps" in {
    resetFixtures()
    insertOwnership()

    val workflows = UserQuotaResource.getUserCreatedWorkflow(testUid)

    assert(workflows.size == 1)
    val w = workflows.head
    assert(w.userId == testUid)
    assert(w.workflowId == testWid)
    assert(w.workflowName == testWorkflow.getName)
    // Compare against the DB round-tripped value: Postgres rounds the stored
    // timestamp, so the in-memory pojo's millis would not match exactly.
    assert(w.creationTime == workflowDao.fetchOneByWid(testWid).getCreationTime.getTime)
  }

  // ─── getUserAccessedWorkflow ───────────────────────────────────────────────

  "getUserAccessedWorkflow" should "return an empty list when the user has no access grants" in {
    resetFixtures()
    assert(UserQuotaResource.getUserAccessedWorkflow(testUid).isEmpty)
  }

  it should "return the workflow ids the user can access" in {
    resetFixtures()
    insertAccess()

    val accessed = UserQuotaResource.getUserAccessedWorkflow(testUid)

    assert(accessed.size == 1)
    assert(accessed.get(0) == testWid)
  }

  it should "include a workflow the user owns without an access row" in {
    resetFixtures()
    insertOwnership()

    assert(UserQuotaResource.getUserAccessedWorkflow(testUid).asScala.toList == List(testWid))
  }

  // ─── getUserQuotaSize ──────────────────────────────────────────────────────

  "getUserQuotaSize" should "return an empty array when the user has no executions" in {
    resetFixtures()
    assert(UserQuotaResource.getUserQuotaSize(testUid).isEmpty)
  }

  it should "answer what each execution held when it was closed, newest first" in {
    resetFixtures()
    val older = insertExecution()
    val newer = insertExecution()
    // Larger than an Int holds.
    val stored = 3L * Int.MaxValue
    getDSLContext
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.STORED_BYTES, java.lang.Long.valueOf(stored))
      .where(WORKFLOW_EXECUTIONS.EID.eq(older.getEid))
      .execute()
    getDSLContext
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.STORED_BYTES, java.lang.Long.valueOf(10485760L))
      .where(WORKFLOW_EXECUTIONS.EID.eq(newer.getEid))
      .execute()

    val quota = UserQuotaResource.getUserQuotaSize(testUid)

    assert(quota.map(_.eid).toList == List(newer.getEid, older.getEid))
    assert(quota.forall(_.workflowId == testWid))
    assert(quota.forall(_.workflowName == testWorkflow.getName))
    assert(quota.map(_.storedBytes).toList == List(10485760L, stored))
  }

  it should "answer 0 bytes for an execution that is open, or whose tables were never measured" in {
    resetFixtures()
    insertExecution()

    assert(UserQuotaResource.getUserQuotaSize(testUid).map(_.storedBytes).toList == List(0L))
  }

  // ─── class endpoints (delegate to the object using the SessionUser's uid) ──

  "getCreatedWorkflow (endpoint)" should "return the current user's created workflows" in {
    resetFixtures()
    insertOwnership()

    val workflows = resource.getCreatedWorkflow(new SessionUser(testUser))

    assert(workflows.size == 1)
    assert(workflows.head.workflowId == testWid)
  }

  "getAccessedWorkflow (endpoint)" should "return the current user's accessible workflow ids" in {
    resetFixtures()
    insertAccess()

    val accessed = resource.getAccessedWorkflow(new SessionUser(testUser))

    assert(accessed.size == 1)
    assert(accessed.get(0) == testWid)
  }

  "getUserQuota (endpoint)" should "return the current user's quota storage array" in {
    resetFixtures()
    insertExecution()

    val quota = resource.getUserQuota(new SessionUser(testUser))

    assert(quota.length == 1)
    assert(quota.head.workflowId == testWid)
  }

  "getCreatedDatasets (endpoint)" should "return an empty list when the user owns no datasets" in {
    resetFixtures()
    assert(resource.getCreatedDatasets(new SessionUser(testUser)).isEmpty)
  }

  it should "return the datasets the user created (with size disabled to 0)" in {
    resetFixtures()
    val dataset = insertDataset()

    val datasets = resource.getCreatedDatasets(new SessionUser(testUser))

    assert(datasets.size == 1)
    assert(datasets.head.name == dataset.getName)
    assert(datasets.head.size == 0L)
  }

  // ─── deleteExecutionCollection / deleteCollection ──────────────────────────

  /** An execution that is closed, as one that a delete takes is. */
  private def insertClosedExecution(): WorkflowExecutions = {
    val execution = insertExecution()
    getDSLContext
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.OUTCOME, Short.box(3.toShort))
      .set(WORKFLOW_EXECUTIONS.ENDED_AT, new Timestamp(System.currentTimeMillis()))
      .where(WORKFLOW_EXECUTIONS.EID.eq(execution.getEid))
      .execute()
    execution
  }

  /**
    * Gives `execution` a log table and the result table of a port, in its namespace, as the
    * Dashboard service makes it, and returns them.
    */
  private def storeTablesOf(execution: WorkflowExecutions): Seq[URI] = {
    val (wid, eid) =
      (WorkflowIdentity(testWid.toLong), ExecutionIdentity(execution.getEid.longValue()))
    TestUtils.makeExecutionNamespace(eid.id)
    val logUri = ExecutionLogStore.logUri(wid, eid, None)
    ExecutionLogStore.create(logUri, System.currentTimeMillis(), 30000L)
    val result = VFSURIFactory.resultURI(
      VFSURIFactory.createPortBaseURI(
        wid,
        eid,
        GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity("scan"), "main"), PortIdentity())
      )
    )
    DocumentFactory.createDocument(result, Schema().add("line", AttributeType.STRING))
    Seq(logUri, result)
  }

  "deleteExecutionCollection" should "delete the execution row from WORKFLOW_EXECUTIONS" in {
    resetFixtures()
    val execution = insertClosedExecution()

    UserQuotaResource.deleteExecutionCollection(execution.getEid, expiry)

    assert(workflowExecutionsDao.fetchOneByEid(execution.getEid) == null)
  }

  it should "drop every table of the execution, with its namespace, its token's rights and its large binaries" in {
    resetFixtures()
    val execution = insertClosedExecution()
    val tables = storeTablesOf(execution)
    binariesDeletedFor.clear()

    UserQuotaResource.deleteExecutionCollection(execution.getEid, expiry)

    tables.foreach(uri => assert(!ExecutionTables.exists(uri), uri))
    assert(
      !IcebergCatalogInstance
        .getInstance()
        .asInstanceOf[SupportsNamespaces]
        .namespaceExists(Namespace.of(ExecutionNamespace.of(execution.getEid.longValue())))
    )
    assert(
      catalogAccess.management.deleted
        .contains(ExecutionCatalogAccess.userOf(execution.getEid.longValue()))
    )
    assert(binariesDeletedFor.asScala.toSeq == Seq(execution.getEid.longValue()))
  }

  it should "refuse an execution that is still open with 409, and drop nothing" in {
    resetFixtures()
    val execution = insertExecution()
    val tables = storeTablesOf(execution)
    binariesDeletedFor.clear()
    try {
      val refused = intercept[WebApplicationException] {
        UserQuotaResource.deleteExecutionCollection(execution.getEid, expiry)
      }

      assert(refused.getResponse.getStatus == 409)
      assert(refused.getMessage == s"execution ${execution.getEid} is still open; kill it first")
      assert(workflowExecutionsDao.fetchOneByEid(execution.getEid) != null)
      tables.foreach(uri => assert(ExecutionTables.exists(uri), uri))
      assert(binariesDeletedFor.isEmpty)
    } finally expiry.dropAll(execution.getEid.longValue())
  }

  "deleteCollection (endpoint)" should "delete the execution row for a caller with access" in {
    resetFixtures()
    insertWriteAccess()
    val execution = insertClosedExecution()

    resource.deleteCollection(execution.getEid, new SessionUser(testUser))

    assert(workflowExecutionsDao.fetchOneByEid(execution.getEid) == null)
  }

  it should "refuse an execution that is still open with 409" in {
    resetFixtures()
    insertWriteAccess()
    val execution = insertExecution()

    val refused = intercept[WebApplicationException] {
      resource.deleteCollection(execution.getEid, new SessionUser(testUser))
    }

    assert(refused.getResponse.getStatus == 409)
    assert(workflowExecutionsDao.fetchOneByEid(execution.getEid) != null)
  }

  it should "reject a caller who has mistaken the eid" in {
    resetFixtures()
    insertWriteAccess()
    val execution = insertExecution()

    val otherUser = new User
    otherUser.setUid(testUid + 100000)
    otherUser.setName("otherUser")
    otherUser.setEmail("otherUser-" + UUID.randomUUID().toString.substring(0, 8) + "@example.com")

    val refused = intercept[WebApplicationException] {
      resource.deleteCollection(execution.getEid, new SessionUser(otherUser))
    }
    assert(refused.getResponse.getStatus == 403)

    assert(workflowExecutionsDao.fetchOneByEid(execution.getEid) != null)
  }
}
