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

import com.fasterxml.jackson.module.scala.DefaultScalaModule
import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.Configuration
import io.dropwizard.configuration.{EnvironmentVariableSubstitutor, SubstitutingSourceProvider}
import io.dropwizard.lifecycle.Managed
import io.dropwizard.setup.{Bootstrap, Environment}
import io.dropwizard.websockets.WebsocketBundle
import org.apache.texera.common.config.{ApplicationConfig, StorageConfig}
import org.apache.texera.amber.core.workflow.{PhysicalPlan, WorkflowContext}
import org.apache.texera.amber.engine.architecture.coordinator.CoordinatorConfig
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.FAILED
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.common.{AmberRuntime, Utils}
import org.apache.texera.amber.util.ObjectMapperUtils
import org.apache.commons.jcs3.access.exception.InvalidArgumentException
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.SqlServer
import org.apache.texera.web.auth.JwtAuth.setupJwtAuth
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.resource.{
  SyncExecutionResource,
  WebsocketPayloadSizeTuner,
  WorkflowWebsocketResource
}
import org.apache.texera.web.service.WorkflowService
import org.eclipse.jetty.server.session.SessionHandler
import org.eclipse.jetty.servlet.FilterHolder
import org.eclipse.jetty.websocket.server.WebSocketUpgradeFilter

import java.time.Duration
import scala.annotation.tailrec
import scala.concurrent.duration.DurationInt

object ComputingUnitMaster {

  def createAmberRuntime(
      workflowContext: WorkflowContext,
      physicalPlan: PhysicalPlan,
      conf: CoordinatorConfig,
      errorHandler: Throwable => Unit
  ): AmberClient = {
    new AmberClient(
      AmberRuntime.actorSystem,
      workflowContext,
      physicalPlan,
      conf,
      errorHandler
    )
  }

  /** How long a unit that is stopped waits for the ends of its runs to be recorded. */
  private val StopPatience = 5.seconds

  /**
    * Ends the runs this unit holds when the unit is stopped: each that has not ended ends FAILED,
    * saying that its unit was stopped, and the unit waits a moment for the ends of its runs to
    * be recorded. So only a unit that died leaves a run with no ending.
    */
  private[web] object EndRunsOnStop extends Managed {
    override def start(): Unit = ()

    override def stop(): Unit = {
      val runs = WorkflowService.getAllWorkflowServices
        .flatMap(service => Option(service.executionService.getValue))
        .toSeq
      val deadline = StopPatience.fromNow
      runs.foreach(_.end(FAILED, reason = Some("the computing unit was stopped")))
      runs.foreach(_.executionStateStore.recorder.awaitIdle(deadline.timeLeft))
    }
  }

  type OptionMap = Map[Symbol, Any]

  def parseArgs(args: Array[String]): OptionMap = {
    @tailrec
    def nextOption(map: OptionMap, list: List[String]): OptionMap = {
      list match {
        case Nil => map
        case "--cluster" :: value :: tail =>
          nextOption(map ++ Map(Symbol("cluster") -> value.toBoolean), tail)
        case option :: tail =>
          throw new InvalidArgumentException("unknown command-line arg")
      }
    }

    nextOption(Map(), args.toList)
  }

  def main(args: Array[String]): Unit = {
    val argMap = parseArgs(args)

    val clusterMode = argMap.get(Symbol("cluster")).asInstanceOf[Option[Boolean]].getOrElse(false)
    // start actor system master node
    AmberRuntime.startActorMaster(clusterMode)
    // start web server
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
    // enable environment variable substitution in YAML config
    bootstrap.setConfigurationSourceProvider(
      new SubstitutingSourceProvider(
        bootstrap.getConfigurationSourceProvider,
        new EnvironmentVariableSubstitutor(false)
      )
    )
    // add websocket bundle
    bootstrap.addBundle(new WebsocketBundle(classOf[WorkflowWebsocketResource]))
    // register the Scala module on Dropwizard's mapper: Jersey reads the unit's request bodies
    // and writes its answers (SyncExecutionResource) with it
    bootstrap.getObjectMapper.registerModule(DefaultScalaModule)
  }

  override def run(configuration: Configuration, environment: Environment): Unit = {
    org.apache.texera.observability.OtelInit.init("computing-unit-master")
    org.apache.texera.web.observability.WorkflowMetricsRecorder.init()
    ObjectMapperUtils.warmupObjectMapperForOperatorsSerde()

    SqlServer.initConnection(
      StorageConfig.jdbcUrl,
      StorageConfig.jdbcUsername,
      StorageConfig.jdbcPassword,
      applicationName = "texera-computing-unit"
    )

    environment.jersey.setUrlPattern("/api/*")

    val webSocketUpgradeFilter =
      WebSocketUpgradeFilter.configureContext(environment.getApplicationContext)
    webSocketUpgradeFilter.getFactory.getPolicy.setIdleTimeout(Duration.ofHours(1).toMillis)
    environment.getApplicationContext.setAttribute(
      classOf[WebSocketUpgradeFilter].getName,
      webSocketUpgradeFilter
    )

    // register SessionHandler
    environment.jersey.register(classOf[SessionHandler])
    environment.servlets.setSessionHandler(new SessionHandler)

    setupJwtAuth(environment)

    environment.jersey.register(
      new io.dropwizard.auth.AuthValueFactoryProvider.Binder[SessionUser](classOf[SessionUser])
    )
    environment.jersey.register(
      classOf[org.glassfish.jersey.server.filter.RolesAllowedDynamicFeature]
    )
    environment
      .servlets()
      .addServletListeners(
        new WebsocketPayloadSizeTuner(ApplicationConfig.maxWorkflowWebsocketRequestPayloadSizeKb)
      )

    // No clean-up is scheduled: a unit drops nothing, and the Dashboard service expires results.

    environment.jersey.register(classOf[WorkflowExecutionsResource])
    environment.jersey.register(classOf[SyncExecutionResource])

    environment.lifecycle().manage(ComputingUnitMaster.EndRunsOnStop)

    // Route request logs through SLF4J, controlled by TEXERA_SERVICE_LOG_LEVEL.
    // TODO: replace with RequestLoggingFilter.register() from common/auth once Dropwizard is upgraded to 4.x
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
  }
}
