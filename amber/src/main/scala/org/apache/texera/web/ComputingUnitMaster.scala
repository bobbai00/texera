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

package org.apache.texera.web

import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.Configuration
import io.dropwizard.configuration.{EnvironmentVariableSubstitutor, SubstitutingSourceProvider}
import io.dropwizard.setup.{Bootstrap, Environment}
import io.dropwizard.websockets.WebsocketBundle
import org.apache.commons.jcs3.access.exception.InvalidArgumentException
import org.apache.texera.amber.core.workflow.{PhysicalPlan, WorkflowContext}
import org.apache.texera.amber.engine.architecture.coordinator.CoordinatorConfig
import org.apache.texera.amber.engine.common.AmberRuntime.scheduleRecurringCallThroughActorSystem
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.common.{AmberRuntime, Utils}
import org.apache.texera.amber.util.{JSONUtils, ObjectMapperUtils}
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.web.auth.{UnitJwtAuth, UnitPrincipal}
import org.apache.texera.web.execution.{ExecutionRegistry, ExecutionStorage, UnitApiResource}
import org.apache.texera.web.resource.{
  SyncExecutionResource,
  WebsocketPayloadSizeTuner,
  WorkflowWebsocketResource
}
import org.eclipse.jetty.server.session.SessionHandler
import org.eclipse.jetty.servlet.FilterHolder
import org.eclipse.jetty.websocket.server.WebSocketUpgradeFilter

import java.time.Duration
import scala.annotation.tailrec
import scala.concurrent.duration.DurationInt

/**
  * The computing unit: a pure engine. It serves the unit API (api/engine.tsp) and the
  * WebSocket for live runs, verifies tokens against the identity provider, and reports to
  * the catalog. It opens no database.
  */
object ComputingUnitMaster {
  def createAmberRuntime(
      workflowContext: WorkflowContext,
      physicalPlan: PhysicalPlan,
      conf: CoordinatorConfig,
      errorHandler: Throwable => Unit
  ): AmberClient = {
    new AmberClient(AmberRuntime.actorSystem, workflowContext, physicalPlan, conf, errorHandler)
  }

  type OptionMap = Map[Symbol, Any]

  def parseArgs(args: Array[String]): OptionMap = {
    @tailrec
    def nextOption(map: OptionMap, list: List[String]): OptionMap = {
      list match {
        case Nil => map
        case "--cluster" :: value :: tail =>
          nextOption(map ++ Map(Symbol("cluster") -> value.toBoolean), tail)
        case _ :: _ =>
          throw new InvalidArgumentException("unknown command-line arg")
      }
    }
    nextOption(Map(), args.toList)
  }

  def main(args: Array[String]): Unit = {
    val argMap = parseArgs(args)
    val clusterMode = argMap.get(Symbol("cluster")).asInstanceOf[Option[Boolean]].getOrElse(false)
    AmberRuntime.startActorMaster(clusterMode)
    new ComputingUnitMaster().run(
      "server",
      Utils.amberHomePath
        .resolve("src")
        .resolve("main")
        .resolve("resources")
        .resolve("computing-unit-master-config.yml")
        .toString
    )
  }
}

class ComputingUnitMaster extends io.dropwizard.Application[Configuration] with LazyLogging {

  override def initialize(bootstrap: Bootstrap[Configuration]): Unit = {
    bootstrap.setConfigurationSourceProvider(
      new SubstitutingSourceProvider(
        bootstrap.getConfigurationSourceProvider,
        new EnvironmentVariableSubstitutor(false)
      )
    )
    bootstrap.addBundle(new WebsocketBundle(classOf[WorkflowWebsocketResource]))
    JSONUtils.registerWorkflowModules(bootstrap.getObjectMapper)
  }

  override def run(configuration: Configuration, environment: Environment): Unit = {
    org.apache.texera.observability.OtelInit.init("computing-unit-master")
    org.apache.texera.web.observability.WorkflowMetricsRecorder.init()
    ObjectMapperUtils.warmupObjectMapperForOperatorsSerde()

    environment.jersey.setUrlPattern("/api/*")
    val webSocketUpgradeFilter =
      WebSocketUpgradeFilter.configureContext(environment.getApplicationContext)
    webSocketUpgradeFilter.getFactory.getPolicy.setIdleTimeout(Duration.ofHours(1).toMillis)
    environment.getApplicationContext.setAttribute(
      classOf[WebSocketUpgradeFilter].getName,
      webSocketUpgradeFilter
    )
    environment.jersey.register(classOf[SessionHandler])
    environment.servlets.setSessionHandler(new SessionHandler)

    UnitJwtAuth.setup(environment)
    environment.jersey.register(
      new io.dropwizard.auth.AuthValueFactoryProvider.Binder[UnitPrincipal](classOf[UnitPrincipal])
    )
    environment.jersey.register(
      classOf[org.glassfish.jersey.server.filter.RolesAllowedDynamicFeature]
    )
    environment
      .servlets()
      .addServletListeners(
        new WebsocketPayloadSizeTuner(ApplicationConfig.maxWorkflowWebsocketRequestPayloadSizeKb)
      )

    val timeToLive: Int = ApplicationConfig.sinkStorageTTLInSecs
    scheduleRecurringCallThroughActorSystem(
      2.seconds,
      ApplicationConfig.sinkStorageCleanUpCheckIntervalInSecs.seconds
    ) {
      recurringCheckExpiredResults(timeToLive)
    }

    environment.jersey.register(classOf[UnitApiResource])
    environment.jersey.register(classOf[SyncExecutionResource])

    val requestLogger = org.slf4j.LoggerFactory.getLogger("org.eclipse.jetty.server.RequestLog")
    environment.getApplicationContext.addFilter(
      new FilterHolder(new javax.servlet.Filter {
        override def init(filterConfig: javax.servlet.FilterConfig): Unit = {}
        override def doFilter(
            request: javax.servlet.ServletRequest,
            response: javax.servlet.ServletResponse,
            chain: javax.servlet.FilterChain
        ): Unit = {
          chain.doFilter(request, response)
          if (requestLogger.isInfoEnabled) {
            val req = request.asInstanceOf[javax.servlet.http.HttpServletRequest]
            val resp = response.asInstanceOf[javax.servlet.http.HttpServletResponse]
            requestLogger.info(
              s"""${req.getRemoteAddr} - "${req.getMethod} ${req.getRequestURI} ${req.getProtocol}" ${resp.getStatus}"""
            )
          }
        }
        override def destroy(): Unit = {}
      }),
      "/*",
      java.util.EnumSet.allOf(classOf[javax.servlet.DispatcherType])
    )
    logger.info(s"computing unit ready; identity provider ${UnitJwtAuth.issuer}")
  }

  /** Drops the stored results of executions idle longer than the time to live. */
  private def recurringCheckExpiredResults(timeToLive: Int): Unit =
    ExecutionRegistry.getExpiredExecutionsWithResultOrLog(timeToLive).foreach { record =>
      ExecutionStorage.drop(record.eid)
      record.setLogLocation(null)
    }
}
