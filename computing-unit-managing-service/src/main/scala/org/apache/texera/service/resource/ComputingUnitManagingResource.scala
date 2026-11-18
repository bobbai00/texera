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

package org.apache.texera.service.resource

import io.dropwizard.auth.Auth
import io.fabric8.kubernetes.api.model.Quantity
import io.fabric8.kubernetes.client.KubernetesClientException
import jakarta.annotation.security.RolesAllowed
import jakarta.ws.rs._
import jakarta.ws.rs.core.{MediaType, Response}
import org.apache.commons.lang3.StringUtils
import org.apache.texera.auth.JwtAuth.jwtClaims
import org.apache.texera.auth.{JwtAuth, SessionUser}
import org.apache.texera.auth.util.ComputingUnitAccess
import org.apache.texera.common.config.KubernetesConfig.{
  cpuLimitOptions,
  gpuLimitOptions,
  maxNumOfRunningComputingUnitsPerUser,
  memoryLimitOptions
}
import org.apache.texera.common.config.{
  ComputingUnitConfig,
  EnvironmentalVariable,
  KubernetesConfig,
  StorageConfig
}
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.SqlServer.withTransaction
import org.apache.texera.dao.jooq.generated.Tables.{
  USER,
  WORKFLOW_COMPUTING_UNIT,
  WORKFLOW_EXECUTIONS
}
import org.apache.texera.dao.jooq.generated.enums.{
  PrivilegeEnum,
  UserRoleEnum,
  WorkflowComputingUnitTerminationReasonEnum,
  WorkflowComputingUnitTypeEnum
}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  ComputingUnitUserAccessDao,
  UserDao,
  WorkflowComputingUnitDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{User, WorkflowComputingUnit}
import org.apache.texera.service.resource.ComputingUnitManagingResource._
import org.apache.texera.service.util.{
  ComputingUnitEmailNotifier,
  ComputingUnitHelpers,
  ComputingUnitManagingServiceException,
  InsufficientComputingUnitQuota,
  KubernetesClient
}
import org.jooq.{Condition, DSLContext, EnumType}
import org.jooq.impl.DSL.{boolOr, exists, max, selectOne}
import org.slf4j.LoggerFactory
import play.api.libs.json._

import java.sql.Timestamp
import scala.annotation.unused
import scala.jdk.CollectionConverters.CollectionHasAsScala
import scala.util.control.NonFatal

object ComputingUnitManagingResource {
  private[resource] val logger = LoggerFactory.getLogger(classOf[ComputingUnitManagingResource])

  private def context: DSLContext =
    SqlServer
      .getInstance()
      .createDSLContext()

  private[resource] case class IdleComputingUnitCandidate(
      unit: WorkflowComputingUnit,
      username: Option[String]
  )

  /**
    * What the idle sweep reads of a unit's executions: their closing records, which the
    * Dashboard service writes. An execution with none is open, and keeps its unit off the
    * sweep: its run may be in flight, whatever state it is in. A closed execution counts as
    * activity when it was created and when it ended, so a unit is not terminated right after
    * a run.
    *
    * Every execution is closed in the end, so none keeps a unit for ever: the Dashboard service
    * closes a run whose unit shows no sign of life as lost, and an execution that no unit
    * started in time as never started (apache/texera#8618). Until it does, such an execution
    * is open here too: this service reads no lake, so it cannot tell an execution that waits
    * for its start from one that runs.
    */
  private[resource] def lastComputingUnitActivityTime(
      unit: WorkflowComputingUnit,
      latestEndTime: Option[Timestamp],
      latestStartTime: Option[Timestamp]
  ): Timestamp =
    Seq(
      latestEndTime,
      latestStartTime,
      Option(unit.getCreationTime)
    ).flatten.maxBy(_.getTime)

  private[resource] def shouldTerminateIdleComputingUnit(
      hasActiveExecution: Boolean,
      lastExecutionTime: Timestamp,
      cutoff: Timestamp
  ): Boolean =
    !hasActiveExecution && lastExecutionTime.before(cutoff)

  /**
    * Terminates every Kubernetes computing unit whose last execution activity is older than
    * `idleTimeoutMinutes`, returning the units terminated so the caller can log their owners.
    */
  def terminateIdleKubernetesComputingUnits(
      idleTimeoutMinutes: Long
  ): List[TerminatedComputingUnitInfo] =
    terminateIdleKubernetesComputingUnits(
      idleTimeoutMinutes,
      new Timestamp(System.currentTimeMillis()),
      KubernetesClient
    )

  /**
    * The client is a by-name parameter -- not the global singleton -- so the sweep is unit-testable
    * with a stub and a sweep that terminates nothing never forces the singleton; the public
    * overload binds the production [[KubernetesClient]]. Same seam as
    * [[org.apache.texera.service.util.ComputingUnitHelpers.singleUnitStatus]].
    */
  private[resource] def terminateIdleKubernetesComputingUnits(
      idleTimeoutMinutes: Long,
      now: Timestamp,
      k8s: => KubernetesClient
  ): List[TerminatedComputingUnitInfo] = {
    val cutoff = new Timestamp(now.getTime - idleTimeoutMinutes * 60 * 1000)
    idleKubernetesComputingUnitCandidates(cutoff).flatMap(candidate =>
      terminateIdleKubernetesComputingUnitCandidate(candidate, cutoff, now, k8s)
    )
  }

  private[resource] def idleKubernetesComputingUnitCandidates(
      cutoff: Timestamp
  ): List[IdleComputingUnitCandidate] = {
    // All three questions asked per computing unit -- is any execution still open, when did an
    // execution last end, when did one last start -- are aggregates over the same rows grouped
    // by the same key, so one grouped query answers them for every unit at once. The left joins
    // keep units that have no executions (both max() are NULL) and units whose owner row is
    // gone (name is NULL), matching what a per-unit scan would produce.
    val latestEndTime = max(WORKFLOW_EXECUTIONS.ENDED_AT)
    val latestStartTime = max(WORKFLOW_EXECUTIONS.STARTING_TIME)
    // A unit with no execution is joined to a row of nulls, which is no open execution.
    val hasActiveExecution =
      boolOr(WORKFLOW_EXECUTIONS.EID.isNotNull.and(WORKFLOW_EXECUTIONS.ENDED_AT.isNull))

    withTransaction(context) { ctx =>
      ctx
        .select(
          WORKFLOW_COMPUTING_UNIT.asterisk(),
          USER.NAME,
          latestEndTime,
          latestStartTime,
          hasActiveExecution
        )
        .from(WORKFLOW_COMPUTING_UNIT)
        .leftJoin(WORKFLOW_EXECUTIONS)
        .on(WORKFLOW_EXECUTIONS.CUID.eq(WORKFLOW_COMPUTING_UNIT.CUID))
        .leftJoin(USER)
        .on(USER.UID.eq(WORKFLOW_COMPUTING_UNIT.UID))
        .where(
          WORKFLOW_COMPUTING_UNIT.TYPE
            .eq(WorkflowComputingUnitTypeEnum.kubernetes)
            .and(WORKFLOW_COMPUTING_UNIT.TERMINATE_TIME.isNull)
        )
        .groupBy(WORKFLOW_COMPUTING_UNIT.CUID, USER.NAME)
        .fetch()
        .asScala
        .flatMap { record =>
          val unit = record.into(WORKFLOW_COMPUTING_UNIT).into(classOf[WorkflowComputingUnit])
          val lastExecutionTime = lastComputingUnitActivityTime(
            unit,
            Option(record.get(latestEndTime)),
            Option(record.get(latestStartTime))
          )

          val active = Option(record.get(hasActiveExecution)).exists(_.booleanValue())
          if (shouldTerminateIdleComputingUnit(active, lastExecutionTime, cutoff)) {
            Some(
              IdleComputingUnitCandidate(
                unit,
                Option(record.get(USER.NAME)).filter(_.nonEmpty)
              )
            )
          } else {
            None
          }
        }
        .toList
    }
  }

  /**
    * Every execution row that would have kept `cuid` out of the scan's result: one that is
    * open, or one that was created or ended at or after `cutoff`. Re-asserted inside the
    * terminating UPDATE so a run started between the scan and the update takes the unit off the
    * table -- the scan reads every candidate before terminating any of them, so that window is as
    * wide as the whole sweep, not an instant.
    */
  private[resource] def liveExecutionExists(cuid: Integer, cutoff: Timestamp): Condition =
    exists(
      selectOne()
        .from(WORKFLOW_EXECUTIONS)
        .where(
          WORKFLOW_EXECUTIONS.CUID
            .eq(cuid)
            .and(
              WORKFLOW_EXECUTIONS.ENDED_AT.isNull
                .or(WORKFLOW_EXECUTIONS.STARTING_TIME.ge(cutoff))
                .or(WORKFLOW_EXECUTIONS.ENDED_AT.ge(cutoff))
            )
        )
    )

  private[resource] def terminateIdleKubernetesComputingUnitCandidate(
      candidate: IdleComputingUnitCandidate,
      cutoff: Timestamp,
      terminationTime: Timestamp,
      k8s: => KubernetesClient
  ): Option[TerminatedComputingUnitInfo] = {
    val unit = candidate.unit
    val cuid = unit.getCuid
    val reason = WorkflowComputingUnitTerminationReasonEnum.GARBAGE_COLLECTED
    try {
      withTransaction(context) { ctx =>
        // Stamp the row first and delete the pod second, within one transaction per unit. The
        // guards the scan applied are repeated in the WHERE clause, so a unit a user terminated
        // or started a run on in the meantime updates zero rows and is left alone. Deleting an
        // absent pod is a no-op and deleting a live one is idempotent, so letting a delete
        // failure roll the stamp back only costs a retry next round -- whereas stamping after a
        // failed delete would leave a live pod behind a row that says terminated.
        val marked = ctx
          .update(WORKFLOW_COMPUTING_UNIT)
          .set(WORKFLOW_COMPUTING_UNIT.TERMINATE_TIME, terminationTime)
          .set(WORKFLOW_COMPUTING_UNIT.TERMINATION_REASON, reason)
          .where(
            WORKFLOW_COMPUTING_UNIT.CUID
              .eq(cuid)
              .and(WORKFLOW_COMPUTING_UNIT.TERMINATE_TIME.isNull)
              .and(WORKFLOW_COMPUTING_UNIT.TYPE.eq(WorkflowComputingUnitTypeEnum.kubernetes))
              .andNot(liveExecutionExists(cuid, cutoff))
          )
          .execute() == 1

        if (!marked) {
          None
        } else {
          k8s.deletePod(cuid)
          Some(
            TerminatedComputingUnitInfo(
              cuid = cuid,
              name = unit.getName,
              uid = unit.getUid,
              username = candidate.username,
              reason = reason
            )
          )
        }
      }
    } catch {
      case NonFatal(t) =>
        logger.warn(s"Failed to terminate idle Kubernetes computing unit cuid=$cuid", t)
        None
    }
  }

  private def icebergEnvironmentVariables: Map[String, Any] = {
    val base = Map[String, Any](
      EnvironmentalVariable.ENV_ICEBERG_CATALOG_TYPE -> StorageConfig.icebergCatalogType
    )
    StorageConfig.icebergCatalogType match {
      case "rest" =>
        base ++ Map(
          EnvironmentalVariable.ENV_ICEBERG_CATALOG_REST_URI -> StorageConfig.icebergRESTCatalogUri,
          EnvironmentalVariable.ENV_ICEBERG_CATALOG_REST_WAREHOUSE_NAME -> StorageConfig.icebergRESTCatalogWarehouseName
        )
      case "postgres" =>
        base ++ Map(
          EnvironmentalVariable.ENV_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME -> StorageConfig.icebergPostgresCatalogUriWithoutScheme,
          EnvironmentalVariable.ENV_ICEBERG_CATALOG_POSTGRES_USERNAME -> StorageConfig.icebergPostgresCatalogUsername,
          EnvironmentalVariable.ENV_ICEBERG_CATALOG_POSTGRES_PASSWORD -> StorageConfig.icebergPostgresCatalogPassword
        )
      case _ => base
    }
  }

  // Required: the endpoint defaults to localhost:9092 (pytexera's DatasetFileDocument) and the
  // secret to a published literal (auth.conf), neither of which suits a real deployment.
  // Forwarded raw -- the endpoint is trimmed by its own reader, and trimming the secret would
  // leave the unit and this service verifying the token against different keys, since
  // AuthConfig does not trim. The file service's upload endpoint is not among them: results
  // are exported by the Dashboard service, and nothing on a unit reads it.
  private val requiredComputingUnitEnvNames: Seq[String] = Seq(
    EnvironmentalVariable.ENV_FILE_SERVICE_GET_DATASET_PRESIGNED_URL_ENDPOINT,
    EnvironmentalVariable.ENV_AUTH_JWT_SECRET
  )

  // Overrides, forwarded only when set: each has a default in the unit's own configuration
  // (application.conf, storage.conf, udf.conf), so its absence is not an error. The four after
  // the payload size are settings a unit reads to run a stored plan: the object-store endpoints
  // it reads input links from, which must include the one the Dashboard signs them for; the
  // namespace of the plan tables, which must be the Dashboard's; and where and how long it
  // installs Python environments. The last three are how long a unit's calls to the Iceberg
  // REST catalog wait, and how often it commits the record of an execution it runs.
  // USER_SYS_ENABLED and SCHEDULE_GENERATOR_ENABLE_COST_BASED_SCHEDULE_GENERATOR are absent
  // from both lists -- their conf keys went away with #3831 and #3542, so nothing reads them.
  // TODO: use AmberConfig here; it is only accessible in workflow-executing-service
  private val optionalComputingUnitEnvNames: Seq[String] = Seq(
    EnvironmentalVariable.ENV_MAX_WORKFLOW_WEBSOCKET_REQUEST_PAYLOAD_SIZE_KB,
    EnvironmentalVariable.ENV_INPUT_LINKS_ALLOWED_ENDPOINTS,
    EnvironmentalVariable.ENV_ICEBERG_TABLE_PLAN_NAMESPACE,
    EnvironmentalVariable.ENV_PYTHON_ENVIRONMENTS_ROOT,
    EnvironmentalVariable.ENV_PYTHON_ENVIRONMENTS_INSTALL_TIMEOUT_MINUTES,
    EnvironmentalVariable.ENV_ICEBERG_CATALOG_REST_CONNECTION_TIMEOUT_MS,
    EnvironmentalVariable.ENV_ICEBERG_CATALOG_REST_SOCKET_TIMEOUT_MS,
    EnvironmentalVariable.ENV_ICEBERG_TABLE_COMMIT_INTERVAL_MS
  )

  /**
    * Returns the variables, or fails with a 503 listing every one that is unset or blank.
    *
    * A WebApplicationException so the message survives: dropwizard replaces a plain 500's
    * with generic text. 503 because the deployment is not ready, not the request wrong.
    */
  private[resource] def requiredComputingUnitEnv(
      lookup: String => Option[String]
  ): Map[String, String] = {
    // Blank counts as missing: the chart renders every value as "{{ .value }}", so an unset
    // one arrives as "" rather than absent.
    val looked =
      requiredComputingUnitEnvNames.map(name => name -> lookup(name).filter(_.trim.nonEmpty))
    val missing = looked.collect { case (name, None) => name }
    if (missing.nonEmpty) {
      throw new ServiceUnavailableException(
        "This deployment cannot create a computing unit. Unset or blank environment " +
          s"variable(s): ${missing.mkString(", ")}."
      )
    }
    looked.collect { case (name, Some(value)) => name -> value }.toMap
  }

  /**
    * The overrides that are set, trimmed. A blank one is dropped rather than forwarded, and
    * a padded one is trimmed, because HOCON reads " 1024" as a string and refuses it as an
    * int -- the unit then dies at startup naming nothing.
    */
  private[resource] def optionalComputingUnitEnv(
      lookup: String => Option[String]
  ): Map[String, String] =
    optionalComputingUnitEnvNames.flatMap { name =>
      lookup(name).map(_.trim).filter(_.nonEmpty).map(name -> _)
    }.toMap

  // Forwarded to a created unit so it emits to the same collector as the rest of
  // the deployment. service.instance.id is NOT here: it is built per unit below.
  private val observabilityComputingUnitEnvNames: Seq[String] = Seq(
    EnvironmentalVariable.ENV_OTEL_SDK_DISABLED,
    EnvironmentalVariable.ENV_OTEL_EXPORTER_OTLP_ENDPOINT,
    EnvironmentalVariable.ENV_TEXERA_OTEL_ALLOWED_HOSTS,
    EnvironmentalVariable.ENV_OTEL_METRIC_EXPORT_INTERVAL
  )

  /**
    * Observability environment for a created unit. Without this a unit runs with
    * the SDK-disabled default even when the manager has telemetry enabled, so a
    * worker failure leaves no unit logs, metrics, or traces to investigate. The
    * unit inherits the manager's collector endpoint and related settings, but is
    * given its own service.instance.id (service.name stays shared) so units with
    * the same name do not collapse into one metric series; an instance id the
    * manager itself carries is dropped rather than copied. Returns nothing when no
    * collector endpoint is configured, leaving the unit at its default-off state.
    */
  private[resource] def observabilityComputingUnitEnv(
      cuid: Int,
      lookup: String => Option[String]
  ): Map[String, String] = {
    val get = (name: String) => lookup(name).map(_.trim).filter(_.nonEmpty)
    if (get(EnvironmentalVariable.ENV_OTEL_EXPORTER_OTLP_ENDPOINT).isEmpty) {
      Map.empty
    } else {
      val forwarded =
        observabilityComputingUnitEnvNames.flatMap(name => get(name).map(name -> _)).toMap
      val kept = get(EnvironmentalVariable.ENV_OTEL_RESOURCE_ATTRIBUTES)
        .getOrElse("")
        .split(",")
        .map(_.trim)
        .filter(_.nonEmpty)
        .filterNot(_.toLowerCase.startsWith("service.instance.id="))
      val resourceAttrs = (kept :+ s"service.instance.id=computing-unit-$cuid").mkString(",")
      forwarded + (EnvironmentalVariable.ENV_OTEL_RESOURCE_ATTRIBUTES -> resourceAttrs)
    }
  }

  /**
    * The environment a created computing unit (pod) is given, of this service's own, which
    * `lookup` reads: the lake's catalog and the object store, where a unit keeps everything a
    * run produces and records, and what [[requiredComputingUnitEnv]] and
    * [[optionalComputingUnitEnv]] forward.
    *
    * No login to the Texera database is among them, nor its address: a unit keeps nothing in
    * Postgres, and opens no connection to it. Nor is LakeFS: a run reads its files through
    * the links its plan holds.
    */
  private[resource] def computingUnitEnvironment(
      lookup: String => Option[String]
  ): Map[String, Any] =
    icebergEnvironmentVariables ++ Map(
      // S3 variables are passed to CU for R UDF large binary support
      EnvironmentalVariable.ENV_S3_ENDPOINT -> StorageConfig.s3Endpoint,
      EnvironmentalVariable.ENV_S3_REGION -> StorageConfig.s3Region,
      EnvironmentalVariable.ENV_S3_AUTH_USERNAME -> StorageConfig.s3Username,
      EnvironmentalVariable.ENV_S3_AUTH_PASSWORD -> StorageConfig.s3Password
    ) ++ requiredComputingUnitEnv(lookup) ++ optionalComputingUnitEnv(lookup)

  private lazy val computingUnitEnvironmentVariables: Map[String, Any] =
    computingUnitEnvironment(EnvironmentalVariable.get)

  case class TerminatedComputingUnitInfo(
      cuid: Integer,
      name: String,
      uid: Integer,
      username: Option[String],
      reason: WorkflowComputingUnitTerminationReasonEnum
  )

  case class WorkflowComputingUnitCreationParams(
      name: String,
      unitType: String,
      cpuLimit: String,
      memoryLimit: String,
      gpuLimit: String,
      jvmMemorySize: String,
      shmSize: String,
      uri: Option[String] = None,
      /** A curated image to start this unit from, instead of the deployment's own. */
      iid: Option[Int] = None
  )

  case class WorkflowComputingUnitResourceLimit(
      cpuLimit: String,
      memoryLimit: String,
      gpuLimit: String
  )

  case class WorkflowComputingUnitMetrics(
      cpuUsage: String,
      memoryUsage: String
  )

  case class DashboardWorkflowComputingUnit(
      computingUnit: WorkflowComputingUnit,
      status: String,
      // User-friendly explanation of a failing/degraded status; serialized as null when there is
      // nothing to explain or the endpoint does not authorize the caller to view it.
      statusReason: Option[String],
      metrics: WorkflowComputingUnitMetrics,
      isOwner: Boolean,
      accessPrivilege: EnumType,
      ownerAvatar: String,
      ownerName: String
  )

  case class ComputingUnitLimitOptionsResponse(
      cpuLimitOptions: List[String],
      memoryLimitOptions: List[String],
      gpuLimitOptions: List[String]
  )

  case class ComputingUnitTypesResponse(
      typeOptions: List[String]
  )
}

@Produces(Array(MediaType.APPLICATION_JSON))
@Path("/computing-unit")
class ComputingUnitManagingResource(
    notifyOwnerOfAdminTermination: (WorkflowComputingUnit, User) => Unit =
      ComputingUnitEmailNotifier.notifyOwnerOfAdminTermination
) {
  private def getComputingUnitByCuid(ctx: DSLContext, cuid: Int): WorkflowComputingUnit = {
    val wcDao = new WorkflowComputingUnitDao(ctx.configuration())
    val unit = wcDao.fetchOneByCuid(cuid)

    if (unit == null) {
      throw new NotFoundException(s"Computing unit with cuid=$cuid does not exist.")
    }
    unit
  }

  private def userOwnComputingUnit(ctx: DSLContext, cuid: Integer, uid: Integer): Boolean = {
    getComputingUnitByCuid(ctx, cuid).getUid == uid
  }

  private def getSupportedComputingUnitTypes: List[String] = {
    val allTypes = WorkflowComputingUnitTypeEnum.values().map(_.getLiteral).toList
    allTypes.filter {
      case "local"      => ComputingUnitConfig.localComputingUnitEnabled
      case "kubernetes" => KubernetesConfig.kubernetesComputingUnitEnabled
      case _            => false // Any unknown types are disabled by default
    }
  }

  private def getComputingUnitResourceLimit(
      unit: WorkflowComputingUnit
  ): WorkflowComputingUnitResourceLimit = {
    unit.getType match {
      case WorkflowComputingUnitTypeEnum.local =>
        WorkflowComputingUnitResourceLimit("NaN", "NaN", "NaN")
      case WorkflowComputingUnitTypeEnum.kubernetes =>
        val podLimits: Map[String, String] = KubernetesClient.getPodLimits(unit.getCuid)

        // Get GPU value by finding the exact configured resource key
        val gpuValue = podLimits.getOrElse(KubernetesConfig.gpuResourceKey, "0")

        WorkflowComputingUnitResourceLimit(
          podLimits("cpu"),
          podLimits("memory"),
          gpuValue
        )
    }
  }

  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/limits")
  def getComputingUnitLimitOptions(
      @Auth @unused user: SessionUser
  ): ComputingUnitLimitOptionsResponse = {
    ComputingUnitLimitOptionsResponse(cpuLimitOptions, memoryLimitOptions, gpuLimitOptions)
  }

  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/types")
  def getComputingUnitTypes(
      @Auth @unused user: SessionUser
  ): ComputingUnitTypesResponse = ComputingUnitTypesResponse(getSupportedComputingUnitTypes)

  /**
    * Create a new pod for the given user ID.
    *
    * @param param The parameters containing the user ID.
    * @return The created pod or an error response.
    */
  @POST
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/create")
  def createWorkflowComputingUnit(
      param: WorkflowComputingUnitCreationParams,
      @Auth user: SessionUser
  ): DashboardWorkflowComputingUnit = {
    if (param.name.trim.isEmpty) {
      throw new ForbiddenException("Computing unit name cannot be empty.")
    }

    // Validate the unit type
    val cuType: WorkflowComputingUnitTypeEnum =
      WorkflowComputingUnitTypeEnum.lookupLiteral(param.unitType)

    // Validate that the type itself is supported
    if (!getSupportedComputingUnitTypes.contains(param.unitType))
      throw new ForbiddenException(
        s"Unit type '${param.unitType}' is not allowed. Valid options: " +
          getSupportedComputingUnitTypes.mkString(", ")
      )

    // For Kubernetes computing units, validate resource limits
    cuType match {

      // Kubernetes-specific checks
      case WorkflowComputingUnitTypeEnum.kubernetes =>
        if (!cpuLimitOptions.contains(param.cpuLimit))
          throw new ForbiddenException(
            s"CPU quantity '${param.cpuLimit}' is not allowed. " +
              s"Valid options: ${cpuLimitOptions.mkString(", ")}"
          )
        if (!memoryLimitOptions.contains(param.memoryLimit))
          throw new ForbiddenException(
            s"Memory quantity '${param.memoryLimit}' is not allowed. " +
              s"Valid options: ${memoryLimitOptions.mkString(", ")}"
          )
        if (!gpuLimitOptions.contains(param.gpuLimit))
          throw new ForbiddenException(
            s"GPU quantity '${param.gpuLimit}' is not allowed. " +
              s"Valid options: ${gpuLimitOptions.mkString(", ")}"
          )

        // Check if the shared-memory size is the valid size representation
        val shmQuantity =
          try {
            Quantity.parse(param.shmSize)
          } catch {
            case _: IllegalArgumentException =>
              throw new ForbiddenException(
                s"Shared-memory size '${param.shmSize}' is not a valid Kubernetes quantity " +
                  s"(examples: 64Mi, 2Gi)."
              )
          }

        val memQuantity = Quantity.parse(param.memoryLimit)

        // ensure /dev/shm upper bound ≤ container memory limit
        if (shmQuantity.compareTo(memQuantity) > 0)
          throw new ForbiddenException(
            s"Shared-memory size (${param.shmSize}) cannot exceed the total memory limit " +
              s"(${param.memoryLimit})."
          )

        // JVM heap ≤ total memory
        val jvmGB = param.jvmMemorySize.replaceAll("[^0-9]", "").toInt
        val memGB =
          if (param.memoryLimit.endsWith("Gi")) param.memoryLimit.replaceAll("[^0-9]", "").toInt
          else if (param.memoryLimit.endsWith("Mi"))
            param.memoryLimit.replaceAll("[^0-9]", "").toInt / 1024
          else param.memoryLimit.replaceAll("[^0-9]", "").toInt

        if (jvmGB > memGB)
          throw new ForbiddenException(
            s"JVM memory size (${param.jvmMemorySize}) cannot exceed the " +
              s"total memory limit (${param.memoryLimit})."
          )

      // Local-specific checks
      case WorkflowComputingUnitTypeEnum.local =>
        if (param.uri.forall(_.trim.isEmpty))
          throw new ForbiddenException("URI is required for local computing units")

      // Anything else (shouldn't happen if you keep supported types in sync)
      case _ =>
        throw new ForbiddenException(s"Unsupported computing-unit type: ${param.unitType}")
    }

    // Resolved before anything is written. Starting from an image that is not ready would
    // leave a computing-unit row behind that can never run.
    val curatedImage: Option[String] = param.iid.map { iid =>
      CuratedImageResource
        .readyImageFor(iid)
        .getOrElse(
          throw new ForbiddenException(
            s"Image $iid is not available. It must exist and have passed its check."
          )
        )
    }

    withTransaction(context) { ctx =>
      val wcDao = new WorkflowComputingUnitDao(ctx.configuration())

      // Only Kubernetes units are quota-limited; skip the per-user lookup for local units.
      if (cuType == WorkflowComputingUnitTypeEnum.kubernetes) {
        val runningUnits = wcDao
          .fetchByUid(user.getUid)
          .asScala
          .count(_.getTerminateTime == null)
        if (runningUnits >= maxNumOfRunningComputingUnitsPerUser) {
          throw InsufficientComputingUnitQuota(maxNumOfRunningComputingUnitsPerUser)
        }
      }

      val resourceJson: String = cuType match {
        // ── Kubernetes CU ───────────────────────────────────────
        case WorkflowComputingUnitTypeEnum.kubernetes =>
          Json.stringify(
            Json.obj(
              "cpuLimit" -> param.cpuLimit,
              "memoryLimit" -> param.memoryLimit,
              "gpuLimit" -> param.gpuLimit,
              "jvmMemorySize" -> param.jvmMemorySize,
              "shmSize" -> param.shmSize,
              // The name is stored with the id because a curated image can be removed
              // while a unit started from it is still up, and "what is this running?"
              // should still have an answer then.
              "iid" -> param.iid,
              "imageName" -> param.iid.flatMap(CuratedImageResource.nameOf),
              "curatedImage" -> curatedImage,
              "nodeAddresses" -> Json.arr() // filled in later
            )
          )

        // ── Local CU ─────────────────────────────────────────────
        case WorkflowComputingUnitTypeEnum.local =>
          Json.stringify(
            Json.obj(
              "cpuLimit" -> "NaN",
              "memoryLimit" -> "NaN",
              "gpuLimit" -> "NaN",
              "jvmMemorySize" -> "NaN",
              "shmSize" -> "NaN",
              // user-supplied URI goes straight in
              "nodeAddresses" -> Json.arr(param.uri.get)
            )
          )
        case _ => "{}"
      }

      val computingUnit = new WorkflowComputingUnit()
      val userToken = JwtAuth.jwtToken(jwtClaims(user.user))
      computingUnit.setUid(user.getUid)
      computingUnit.setName(param.name)
      computingUnit.setCreationTime(new Timestamp(System.currentTimeMillis()))
      computingUnit.setType(WorkflowComputingUnitTypeEnum.lookupLiteral(param.unitType))
      computingUnit.setResource(resourceJson)

      // Set URI during initial insert for local only
      if (cuType == WorkflowComputingUnitTypeEnum.local) {
        computingUnit.setUri(param.uri.get)
      } else {
        computingUnit.setUri("") // placeholder for kubernetes
      }

      wcDao.insert(computingUnit)

      val userDao = new UserDao(ctx.configuration())
      val ownerUser = Option(userDao.fetchOneByUid(user.getUid))
      val ownerAvatar: String =
        ownerUser.flatMap(u => Option(u.getAvatar).filter(_.nonEmpty)).orNull
      val ownerUsername: String =
        ownerUser.flatMap(u => Option(u.getName).filter(_.nonEmpty)).orNull

      // Retrieve generated cuid
      val cuid = ctx.lastID().intValue()
      val insertedUnit = wcDao.fetchOneByCuid(cuid)

      if (cuType == WorkflowComputingUnitTypeEnum.kubernetes && insertedUnit != null) {
        // 1. Update the DB with the URI
        insertedUnit.setUri(KubernetesClient.generatePodURI(cuid))

        val updatedResource: JsObject =
          Json
            .parse(insertedUnit.getResource)
            .as[JsObject] ++
            Json.obj("nodeAddresses" -> Json.arr(insertedUnit.getUri))

        insertedUnit.setResource(Json.stringify(updatedResource))
        wcDao.update(insertedUnit)

        // 2. Launch the pod as CU
        try {
          KubernetesClient.createPod(
            cuid,
            param.cpuLimit,
            param.memoryLimit,
            param.gpuLimit,
            computingUnitEnvironmentVariables ++ Map(
              EnvironmentalVariable.ENV_USER_JWT_TOKEN -> userToken,
              EnvironmentalVariable.ENV_JAVA_OPTS -> s"-Xmx${param.jvmMemorySize}"
            ) ++ observabilityComputingUnitEnv(cuid, EnvironmentalVariable.get),
            Some(param.shmSize),
            curatedImage
          )

        } catch {
          case e: KubernetesClientException =>
            throw ComputingUnitManagingServiceException.fromKubernetes(e)

          case t: Throwable =>
            throw t
        }
      }

      // The creator is always the owner, so the status reason is never withheld here.
      val (status, statusReason) =
        ComputingUnitHelpers.getComputingUnitStatusWithReason(insertedUnit)
      DashboardWorkflowComputingUnit(
        insertedUnit,
        status.toString,
        statusReason,
        ComputingUnitHelpers.getComputingUnitMetrics(insertedUnit),
        isOwner = true,
        accessPrivilege = PrivilegeEnum.WRITE,
        ownerAvatar,
        ownerUsername
      )
    }
  }

  /**
    * List all computing units created by the current user.
    *
    * @return A list of computing units that are not terminated.
    */
  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("")
  def listComputingUnits(
      @Auth user: SessionUser
  ): List[DashboardWorkflowComputingUnit] = {
    withTransaction(context) { ctx =>
      val computingUnitDao = new WorkflowComputingUnitDao(ctx.configuration())
      val uid = user.getUid

      // Always fetch units owned by the user
      val ownedUnits = computingUnitDao.fetchByUid(uid).asScala.toList

      // Conditionally fetch shared units based on the config flag
      val (sharedUnits, sharedUnitInfo) =
        if (ComputingUnitConfig.sharingComputingUnitEnabled) {
          val computingUnitUserAccessDao = new ComputingUnitUserAccessDao(ctx.configuration())
          val info = computingUnitUserAccessDao
            .fetchByUid(uid)
            .asScala
            .map(access => access.getCuid -> access.getPrivilege)
            .toMap
          val sharedCuids = info.keys.toList.map(Integer.valueOf(_))

          val units = if (sharedCuids.isEmpty) {
            List()
          } else {
            computingUnitDao.fetchByCuid(sharedCuids: _*).asScala.toList
          }
          (units, info)
        } else {
          // If sharing is disabled, return empty collections
          (List.empty[WorkflowComputingUnit], Map.empty[Integer, PrivilegeEnum])
        }

      val userDao = new UserDao(ctx.configuration())

      // Pair each unit with the caller's privilege (owned default to WRITE), one row per cuid, so
      // a unit that is both owned and shared is reconciled/rendered exactly once.
      val unitsWithPrivilege =
        (ownedUnits.map(u => (u, PrivilegeEnum.WRITE)) ++
          sharedUnits.map(u => (u, sharedUnitInfo(u.getCuid))))
          .distinctBy { case (unit, _) => unit.getCuid }
          .filter { case (unit, _) => unit.getTerminateTime == null }
      val privilegeByCuid = unitsWithPrivilege.map {
        case (unit, privilege) => unit.getCuid -> privilege
      }.toMap
      val candidateUnits = unitsWithPrivilege.map { case (unit, _) => unit }

      // Pod snapshots decide which Kubernetes units are still alive (by pod-name presence).
      val podSnapshots = ComputingUnitHelpers.podSnapshotsFor(candidateUnits)

      val liveUnits =
        ComputingUnitHelpers.reconcileVanishedKubernetesUnits(
          computingUnitDao,
          candidateUnits,
          podSnapshots
        )

      // Metrics only for survivors, so fetch after reconciliation.
      val podMetrics = ComputingUnitHelpers.podMetricsFor(liveUnits)

      val ownerInfoMap =
        ComputingUnitHelpers.resolveOwnerInfo(userDao, liveUnits.map(_.getUid).distinct)

      liveUnits.map { unit =>
        val isOwner = unit.getUid.equals(uid)
        ComputingUnitHelpers.buildDashboardUnit(
          unit,
          isOwner = isOwner,
          canViewStatusReason = isOwner,
          accessPrivilege = privilegeByCuid(unit.getCuid),
          ownerInfo = ownerInfoMap,
          podSnapshots = podSnapshots,
          podMetrics = podMetrics
        )
      }
    }
  }

  /**
    * Return a fully populated [[org.apache.texera.service.resource.ComputingUnitManagingResource.DashboardWorkflowComputingUnit]] for the
    * specified `cuid`, identical to one row produced by /list.
    *
    * @param cuid the ID of the computing-unit to fetch
    */
  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}")
  def getComputingUnitInfo(
      @PathParam("cuid") cuid: Integer,
      @Auth user: SessionUser
  ): DashboardWorkflowComputingUnit = {

    val unit = getComputingUnitByCuid(context, cuid)
    val userDao = new UserDao(context.configuration())
    val ownerUser = Option(userDao.fetchOneByUid(unit.getUid))
    val ownerAvatar: String =
      ownerUser.flatMap(u => Option(u.getAvatar).filter(_.nonEmpty)).orNull
    val ownerUsername: String =
      ownerUser.flatMap(u => Option(u.getName).filter(_.nonEmpty)).orNull

    val isOwner = unit.getUid.equals(user.getUid)
    val (status, statusReason) = ComputingUnitHelpers.getComputingUnitStatusWithReason(unit)

    DashboardWorkflowComputingUnit(
      computingUnit = unit,
      status = status.toString,
      // The direct and regular-user listing endpoints remain owner-gated; the separate admin
      // listing authorizes administrators to view reasons without marking them as owners.
      statusReason = if (isOwner) statusReason else None,
      metrics = ComputingUnitHelpers.getComputingUnitMetrics(unit),
      isOwner = isOwner,
      accessPrivilege = ComputingUnitAccess.getComputingUnitAccess(cuid, user.getUid),
      ownerAvatar,
      ownerUsername
    )
  }

  /**
    * Terminate the computing unit's pod based on the pod URI.
    *
    * @return A response indicating success or failure.
    */
  @DELETE
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/terminate")
  def terminateComputingUnit(
      @PathParam("cuid") cuid: Integer,
      @Auth user: SessionUser
  ): Response = {
    // ADMINs may terminate any unit; everyone else must own it.
    if (!user.isRoleOf(UserRoleEnum.ADMIN) && !userOwnComputingUnit(context, cuid, user.getUid)) {
      return Response
        .status(Response.Status.BAD_REQUEST)
        .entity(s"User has no access to the computing unit")
        .build()
    }

    // If successful, update the database
    val unitToNotifyOwnerOf = withTransaction(context) { ctx =>
      val cuDao = new WorkflowComputingUnitDao(ctx.configuration())
      val unit = getComputingUnitByCuid(ctx, cuid)
      // Only an ADMIN gets here as a non-owner. Read before the stamp, so a repeat tells no one.
      val notifyOwner = unit.getTerminateTime == null && unit.getUid != user.getUid

      // if the computing unit is kubernetes pod, then kill the pod
      if (unit.getType == WorkflowComputingUnitTypeEnum.kubernetes) {
        KubernetesClient.deletePod(cuid)
      }

      val terminationReason = WorkflowComputingUnitTerminationReasonEnum.USER_REQUESTED
      unit.setTerminateTime(new Timestamp(System.currentTimeMillis()))
      unit.setTerminationReason(terminationReason)
      cuDao.update(unit)
      // owner_* describes the unit, terminated_by_* the caller: an ADMIN may terminate a unit
      // they do not own, so a single `uid`/`username` pair would mix the two identities.
      logger.info(
        s"Terminated computing unit: cuid=${unit.getCuid}, name=${unit.getName}, " +
          s"owner_uid=${unit.getUid}, terminated_by_uid=${user.getUid}, " +
          s"terminated_by=${user.getName}, reason=${terminationReason.getLiteral}"
      )
      Option.when(notifyOwner)(unit)
    }
    // After the commit, so an owner never hears of a termination that rolled back.
    unitToNotifyOwnerOf.foreach { unit =>
      try {
        Option(new UserDao(context.configuration()).fetchOneByUid(unit.getUid))
          .foreach(notifyOwnerOfAdminTermination(unit, _))
      } catch {
        case NonFatal(e) =>
          logger.warn(s"Failed to notify the owner of terminated computing unit cuid=$cuid", e)
      }
    }
    Response.ok().build()
  }

  /**
    * Rename a computing unit.
    *
    * @param cuid The computing unit ID.
    * @param name The new name for the computing unit.
    * @param user The authenticated user.
    * @return A response indicating success or failure.
    */
  @PUT
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/rename/{name}")
  def renameComputingUnit(
      @PathParam("cuid") cuid: Integer,
      @PathParam("name") name: String,
      @Auth user: SessionUser
  ): Response = {
    // Verify ownership or write access
    if (
      !userOwnComputingUnit(context, cuid, user.getUid) &&
      !ComputingUnitAccessResource.hasWriteAccess(cuid, user.getUid)
    ) {
      return Response
        .status(Response.Status.FORBIDDEN)
        .entity("User does not have permission to rename this computing unit")
        .build()
    }

    // Validate name
    if (StringUtils.isBlank(name)) {
      return Response
        .status(Response.Status.BAD_REQUEST)
        .entity("Computing unit name cannot be empty or blank")
        .build()
    }

    withTransaction(context) { ctx =>
      val cuDao = new WorkflowComputingUnitDao(ctx.configuration())
      val unit = getComputingUnitByCuid(ctx, cuid)

      try {
        unit.setName(name)
        cuDao.update(unit)
      } catch {
        case e: Exception =>
          return Response
            .status(Response.Status.INTERNAL_SERVER_ERROR)
            .entity(e.getMessage)
            .build()
      }
    }

    Response.ok().build()
  }

  /**
    * Retrieves the CPU and memory metrics for a computing unit identified by its `cuid`.
    *
    * @param cuid The computing unit ID.
    * @return A `WorkflowComputingUnitMetrics` object with CPU and memory usage data.
    */
  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/metrics")
  def getComputingUnitMetricsEndpoint(
      @PathParam("cuid") cuid: String,
      @Auth user: SessionUser
  ): WorkflowComputingUnitMetrics = {
    if (!userOwnComputingUnit(context, cuid.toInt, user.getUid)) {
      throw new BadRequestException("User has no access to the computing unit")
    }
    val computingUnit = getComputingUnitByCuid(context, cuid.toInt)
    ComputingUnitHelpers.getComputingUnitMetrics(computingUnit)
  }

  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/limits")
  def getComputingUnitResourceLimit(
      @PathParam("cuid") cuid: String,
      @Auth user: SessionUser
  ): WorkflowComputingUnitResourceLimit = {
    if (!userOwnComputingUnit(context, cuid.toInt, user.getUid)) {
      throw new BadRequestException("User has no access to the computing unit")
    }
    val computingUnit = getComputingUnitByCuid(context, cuid.toInt)
    getComputingUnitResourceLimit(computingUnit)
  }
}
