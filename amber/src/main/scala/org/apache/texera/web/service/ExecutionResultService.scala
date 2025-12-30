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

import org.apache.pekko.actor.Cancellable
import com.fasterxml.jackson.annotation.{JsonTypeInfo, JsonTypeName}
import com.fasterxml.jackson.databind.node.ObjectNode
import com.typesafe.scalalogging.LazyLogging
import org.apache.amber.config.{ApplicationConfig, StorageConfig}
import org.apache.amber.core.storage.DocumentFactory.ICEBERG
import org.apache.amber.core.storage.model.VirtualDocument
import org.apache.amber.core.storage.result._
import org.apache.amber.core.storage.{DocumentFactory, VFSURIFactory}
import org.apache.amber.core.tuple.{AttributeType, Tuple, TupleUtils}
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, OperatorIdentity, WorkflowIdentity}
import org.apache.amber.core.workflow.OutputPort.OutputMode
import org.apache.amber.core.workflow.{PhysicalOp, PhysicalPlan, PortIdentity}
import org.apache.amber.engine.architecture.controller.{ExecutionStateUpdate, FatalError}
import org.apache.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED,
  KILLED,
  RUNNING,
  TERMINATED
}
import org.apache.amber.engine.common.AmberRuntime
import org.apache.amber.engine.common.client.AmberClient
import org.apache.amber.engine.common.executionruntimestate.ExecutionMetadataStore
import org.apache.texera.web.SubscriptionManager
import org.apache.texera.web.model.websocket.event.{
  PaginatedResultEvent,
  TexeraWebSocketEvent,
  WebResultUpdateEvent
}
import org.apache.texera.web.model.websocket.request.ResultPaginationRequest
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.service.ExecutionResultService.convertTuplesToJson
import org.apache.texera.web.service.WorkflowExecutionService.getLatestExecutionId
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}

import java.io.ByteArrayOutputStream
import java.util.{Base64, UUID}
import scala.collection.mutable
import scala.concurrent.duration.DurationInt
import scala.util.Try

object ExecutionResultService {

  private val defaultPageSize: Int = 5

  /**
    * Pickle prefix used by Python Tuple.cast_to_schema().
    * Format: b"pickle    " (6 bytes "pickle" + 4 spaces)
    */
  private val PICKLE_PREFIX: Array[Byte] = "pickle    ".getBytes("UTF-8")

  /**
    * Check if a byte array contains pickled Python data.
    */
  private def isPickledData(byteArray: Array[Byte]): Boolean = {
    byteArray.length > PICKLE_PREFIX.length &&
    byteArray.take(PICKLE_PREFIX.length).sameElements(PICKLE_PREFIX)
  }

  /**
    * Batch unpickle multiple Python objects in a single subprocess call.
    * This is much more efficient than spawning a process for each object.
    *
    * @param pickledDataList List of (index, pickled byte array) pairs
    * @return Map from index to deserialized string representation
    */
  private def batchUnpickle(pickledDataList: List[(Int, Array[Byte])]): Map[Int, String] = {
    if (pickledDataList.isEmpty) {
      return Map.empty
    }

    Try {
      import com.fasterxml.jackson.databind.ObjectMapper
      val mapper = new ObjectMapper()

      // Prepare input: list of base64-encoded pickle data
      val base64List = pickledDataList.map {
        case (idx, byteArray) =>
          val pickledData = byteArray.drop(PICKLE_PREFIX.length)
          Base64.getEncoder.encodeToString(pickledData)
      }
      val inputJson = mapper.writeValueAsString(base64List.toArray)

      // Python script that processes all pickled data in one call
      val pythonCode =
        """import pickle, base64, json, sys
          |
          |# Read input from stdin
          |input_data = sys.stdin.read()
          |base64_list = json.loads(input_data)
          |
          |results = []
          |for b64_data in base64_list:
          |    try:
          |        data = base64.b64decode(b64_data)
          |        obj = pickle.loads(data)
          |        results.append(repr(obj))
          |    except Exception as e:
          |        results.append(f'[unpickle error: {e}]')
          |
          |print(json.dumps(results))
          |""".stripMargin

      val processBuilder = new ProcessBuilder("python3", "-c", pythonCode)
      processBuilder.redirectErrorStream(true)
      val process = processBuilder.start()

      // Write input to stdin
      val outputStream = process.getOutputStream
      outputStream.write(inputJson.getBytes("UTF-8"))
      outputStream.close()

      // Read output
      val output = new ByteArrayOutputStream()
      val inputStream = process.getInputStream
      val buffer = new Array[Byte](8192)
      var bytesRead = inputStream.read(buffer)
      while (bytesRead != -1) {
        output.write(buffer, 0, bytesRead)
        bytesRead = inputStream.read(buffer)
      }

      val exitCode = process.waitFor()
      val resultStr = output.toString("UTF-8")

      if (exitCode == 0 && resultStr.nonEmpty) {
        val resultsArray = mapper.readValue(resultStr, classOf[Array[String]])
        pickledDataList.map(_._1).zip(resultsArray).toMap
      } else {
        // Fallback: return error message for all
        pickledDataList.map {
          case (idx, byteArray) =>
            idx -> s"[Python object (${byteArray.length - PICKLE_PREFIX.length} bytes)]"
        }.toMap
      }
    }.getOrElse {
      // If Python call fails, return placeholders
      pickledDataList.map {
        case (idx, byteArray) =>
          idx -> s"[Python object (${byteArray.length - PICKLE_PREFIX.length} bytes)]"
      }.toMap
    }
  }

  /**
    * Converts a collection of Tuples to a list of JSON ObjectNodes.
    *
    * This function takes a collection of Tuples and converts each tuple into a JSON ObjectNode.
    * For binary data containing pickled Python objects, it deserializes them in batch for efficiency.
    * For raw binary data, it formats the bytes into a readable hex string representation.
    * NULL values are converted to the string "NULL".
    *
    * @param tuples The collection of Tuples to convert
    * @param isVisualization Whether this is for visualization rendering (affects string truncation)
    * @return A List of ObjectNodes containing the JSON representation of the tuples
    */
  def convertTuplesToJson(
      tuples: Iterable[Tuple],
      isVisualization: Boolean = false
  ): List[ObjectNode] = {
    val maxStringLength = 100000
    val tuplesList = tuples.toList

    // First pass: collect all pickled data with their global indices
    // Index format: tupleIdx * 1000000 + fieldIdx (supports up to 1M fields per tuple)
    val pickledDataList = mutable.ListBuffer[(Int, Array[Byte])]()

    tuplesList.zipWithIndex.foreach {
      case (tuple, tupleIdx) =>
        tuple.schema.getAttributes.zipWithIndex.foreach {
          case (attr, fieldIdx) =>
            if (attr.getType == AttributeType.BINARY) {
              val fieldValue = tuple.getField[AnyRef](fieldIdx)
              fieldValue match {
                case byteArray: Array[Byte] if isPickledData(byteArray) =>
                  val globalIdx = tupleIdx * 1000000 + fieldIdx
                  pickledDataList += ((globalIdx, byteArray))
                case _ => // Not pickled data, skip
              }
            }
        }
    }

    // Batch deserialize all pickled data in a single Python call
    val unpickledMap = batchUnpickle(pickledDataList.toList)

    // Second pass: build JSON with deserialized values
    tuplesList.zipWithIndex.map {
      case (tuple, tupleIdx) =>
        val processedFields = tuple.schema.getAttributes.zipWithIndex
          .map {
            case (attr, fieldIdx) =>
              val fieldValue = tuple.getField[AnyRef](fieldIdx)

              Option(fieldValue) match {
                case None => "NULL"
                case Some(value) =>
                  attr.getType match {
                    case AttributeType.BINARY =>
                      value match {
                        case byteArray: Array[Byte] =>
                          val globalIdx = tupleIdx * 1000000 + fieldIdx
                          unpickledMap.get(globalIdx) match {
                            case Some(unpickled) => unpickled
                            case None            =>
                              // Raw binary data - show hex representation
                              val totalSize = byteArray.length
                              val hexString = byteArrayToHexString(byteArray)
                              if (hexString.length < 39) {
                                s"bytes'$hexString' (length: $totalSize)"
                              } else {
                                val leadingBytes = hexString.take(30)
                                val trailingBytes = hexString.takeRight(9)
                                s"bytes'$leadingBytes...$trailingBytes' (length: $totalSize)"
                              }
                          }
                        case _ =>
                          throw new RuntimeException(
                            s"Expected byte array for binary type field, but got: ${value.getClass.getName}"
                          )
                      }
                    case AttributeType.STRING =>
                      val stringValue = value.asInstanceOf[String]
                      if (stringValue.length > maxStringLength && !isVisualization)
                        stringValue.take(maxStringLength) + "..."
                      else
                        stringValue
                    case _ => value
                  }
              }
          }
          .toArray[Any]

        TupleUtils.tuple2json(tuple.schema, processedFields)
    }
  }

  /**
    * Converts a byte array to a hex string representation.
    *
    * This helper function takes a byte array and converts its contents to a space-separated
    * string of hexadecimal values. Each byte is formatted as a two-digit uppercase hex number.
    *
    * @param byteArray The byte array to convert
    * @return A string containing the hex representation of the byte array's contents
    */
  private def byteArrayToHexString(byteArray: Array[Byte]): String = {
    byteArray.map(b => String.format("%02X", Byte.box(b))).mkString(" ")
  }

  /**
    * convert Tuple from engine's format to JSON format
    */
  private def tuplesToWebData(
      mode: WebOutputMode,
      table: List[Tuple]
  ): WebDataUpdate = {
    val tableInJson = convertTuplesToJson(table, mode == SetSnapshotMode())
    WebDataUpdate(mode, tableInJson)
  }

  /**
    * For SET_SNAPSHOT output mode: result is the latest snapshot
    * FOR SET_DELTA output mode:
    *   - for insert-only delta: effectively the same as latest snapshot
    *   - for insert-retract delta: the union of all delta outputs, not compacted to a snapshot
    *
    * Produces the WebResultUpdate to send to frontend from a result update from the engine.
    */
  private def convertWebResultUpdate(
      workflowIdentity: WorkflowIdentity,
      executionId: ExecutionIdentity,
      physicalOps: List[PhysicalOp],
      oldTupleCount: Int,
      newTupleCount: Int
  ): WebResultUpdate = {
    // Handle empty physicalOps early to avoid head-of-empty-list errors
    if (physicalOps.isEmpty) {
      return WebPaginationUpdate(PaginationMode(), 0, List.empty)
    }

    val outputMode = physicalOps
      .flatMap(op => op.outputPorts)
      .filter({
        case (portId, (port, links, schema)) => !portId.internal
      })
      .map({
        case (portId, (port, links, schema)) => port.mode
      })
      .head

    val webOutputMode: WebOutputMode = {
      outputMode match {
        // currently, only table outputs are using these modes
        case OutputMode.SET_DELTA    => SetDeltaMode()
        case OutputMode.SET_SNAPSHOT => PaginationMode()

        // currently, only visualizations are using single snapshot mode
        case OutputMode.SINGLE_SNAPSHOT => SetSnapshotMode()
        case OutputMode.Unrecognized(_) =>
          throw new RuntimeException(
            s"Unrecognized output mode: $outputMode for workflow ${workflowIdentity.id}"
          )
      }
    }

    // Cannot assume the storage is available at this point. The storage object is only available
    // after a region is scheduled to execute.
    val storageUriOption = WorkflowExecutionsResource.getResultUriByLogicalPortId(
      executionId,
      physicalOps.head.id.logicalOpId,
      PortIdentity()
    )
    storageUriOption match {
      case Some(storageUri) =>
        val storage: VirtualDocument[Tuple] =
          DocumentFactory.openDocument(storageUri)._1.asInstanceOf[VirtualDocument[Tuple]]
        val webUpdate = webOutputMode match {
          case PaginationMode() =>
            val numTuples = storage.getCount
            val maxPageIndex =
              Math.ceil(numTuples / defaultPageSize.toDouble).toInt
            // This can be extremly expensive when we have a lot of pages.
            // It causes delays in some obseved cases.
            // TODO: try to optimize this.
            WebPaginationUpdate(
              PaginationMode(),
              newTupleCount,
              (1 to maxPageIndex).toList
            )
          case SetSnapshotMode() =>
            tuplesToWebData(webOutputMode, storage.get().toList)
          case SetDeltaMode() =>
            val deltaList = storage.getAfter(oldTupleCount).toList
            tuplesToWebData(webOutputMode, deltaList)

          case _ =>
            throw new RuntimeException(
              "update mode combination not supported: " + (webOutputMode, outputMode)
            )
        }
        webUpdate
      case None =>
        WebPaginationUpdate(
          PaginationMode(),
          0,
          List.empty
        )
    }
  }

  /**
    * Behavior for different web output modes:
    *  - PaginationMode   (used by view result operator)
    *     - send new number of tuples and dirty page index
    *  - SetSnapshotMode  (used by visualization in snapshot mode)
    *     - send entire snapshot result to frontend
    *  - SetDeltaMode     (used by visualization in delta mode)
    *     - send incremental delta result to frontend
    */
  @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
  sealed abstract class WebOutputMode extends Product with Serializable

  /**
    * The result update of one operator that will be sent to the frontend.
    * Can be either WebPaginationUpdate (for PaginationMode)
    * or WebDataUpdate (for SetSnapshotMode or SetDeltaMode)
    */
  sealed abstract class WebResultUpdate extends Product with Serializable

  @JsonTypeName("PaginationMode")
  final case class PaginationMode() extends WebOutputMode

  @JsonTypeName("SetSnapshotMode")
  final case class SetSnapshotMode() extends WebOutputMode

  @JsonTypeName("SetDeltaMode")
  final case class SetDeltaMode() extends WebOutputMode

  case class WebPaginationUpdate(
      mode: PaginationMode,
      totalNumTuples: Long,
      dirtyPageIndices: List[Int]
  ) extends WebResultUpdate

  case class WebDataUpdate(mode: WebOutputMode, table: List[ObjectNode]) extends WebResultUpdate

}

/**
  * ExecutionResultService manages all operator output ports that have storage in one workflow execution.
  *
  * On each result update from the engine, WorkflowResultService
  *  - update the result data for each operator,
  *  - send result update event to the frontend
  */
class ExecutionResultService(
    workflowIdentity: WorkflowIdentity,
    computingUnitId: Int,
    val workflowStateStore: WorkflowStateStore
) extends SubscriptionManager
    with LazyLogging {
  private val resultPullingFrequency = ApplicationConfig.executionResultPollingInSecs
  private var resultUpdateCancellable: Cancellable = _

  def attachToExecution(
      executionId: ExecutionIdentity,
      stateStore: ExecutionStateStore,
      physicalPlan: PhysicalPlan,
      client: AmberClient
  ): Unit = {
    if (resultUpdateCancellable != null && !resultUpdateCancellable.isCancelled) {
      resultUpdateCancellable.cancel()
    }

    unsubscribeAll()

    addSubscription(stateStore.metadataStore.getStateObservable.subscribe {
      newState: ExecutionMetadataStore =>
        {
          if (newState.state == RUNNING) {
            if (resultUpdateCancellable == null || resultUpdateCancellable.isCancelled) {
              resultUpdateCancellable = AmberRuntime
                .scheduleRecurringCallThroughActorSystem(
                  2.seconds,
                  resultPullingFrequency.seconds
                ) {
                  onResultUpdate(executionId, physicalPlan)
                }
            }
          } else {
            if (resultUpdateCancellable != null) resultUpdateCancellable.cancel()
          }
        }
    })

    addSubscription(
      client
        .registerCallback[ExecutionStateUpdate](evt => {
          if (
            evt.state == COMPLETED || evt.state == FAILED || evt.state == KILLED || evt.state == TERMINATED
          ) {
            logger.info("Workflow execution terminated. Stop update results.")
            if (resultUpdateCancellable.cancel() || resultUpdateCancellable.isCancelled) {
              // immediately perform final update
              onResultUpdate(executionId, physicalPlan)
            }
          }
        })
    )

    addSubscription(
      client.registerCallback[FatalError](_ =>
        if (resultUpdateCancellable != null) {
          resultUpdateCancellable.cancel()
        }
      )
    )

    addSubscription(
      workflowStateStore.resultStore.registerDiffHandler((oldState, newState) => {
        val buf = mutable.HashMap[String, ExecutionResultService.WebResultUpdate]()
        val allTableStats = mutable.Map[String, Map[String, Map[String, Any]]]()
        newState.resultInfo
          .filter(info => {
            // only update those operators with changing tuple count.
            !oldState.resultInfo
              .contains(info._1) || oldState.resultInfo(info._1).tupleCount != info._2.tupleCount
          })
          .foreach {
            case (opId, info) =>
              val oldInfo = oldState.resultInfo.getOrElse(opId, OperatorResultMetadata())
              buf(opId.id) = ExecutionResultService.convertWebResultUpdate(
                workflowIdentity,
                executionId,
                physicalPlan.getPhysicalOpsOfLogicalOp(opId),
                oldInfo.tupleCount,
                info.tupleCount
              )
              // using the first port for now. TODO: support multiple ports
              val outputPortsMap = physicalPlan
                .getPhysicalOpsOfLogicalOp(opId)
                .headOption
                .map(_.outputPorts)
                .getOrElse(Map.empty)
              val hasSingleSnapshot = outputPortsMap.values.exists {
                case (outputPort, _, _) =>
                  // SINGLE_SNAPSHOT is used for HTML content
                  outputPort.mode == OutputMode.SINGLE_SNAPSHOT
              }

              if (StorageConfig.resultStorageMode == ICEBERG && !hasSingleSnapshot) {
                val storageUri = WorkflowExecutionsResource
                  .getResultUriByLogicalPortId(
                    executionId,
                    opId,
                    PortIdentity()
                  )

                if (storageUri.nonEmpty) {
                  val (_, _, globalPortIdOption, _) = VFSURIFactory.decodeURI(storageUri.get)
                  val opStorage = DocumentFactory.openDocument(storageUri.get)._1

                  allTableStats(opId.id) = opStorage.getTableStatistics
                  WorkflowExecutionsResource.updateResultSize(
                    executionId,
                    globalPortIdOption.get,
                    opStorage.getTotalFileSize
                  )
                  WorkflowExecutionsResource.updateRuntimeStatsSize(executionId)
                  WorkflowExecutionsResource.updateConsoleMessageSize(executionId, opId)
                }
              }
          }
        Iterable(
          WebResultUpdateEvent(
            buf.toMap,
            allTableStats.toMap,
            StorageConfig.resultStorageMode.toLowerCase
          )
        )
      })
    )

    // clear all the result metadata
    workflowStateStore.resultStore.updateState { _ =>
      WorkflowResultStore() // empty result store
    }

  }

  def handleResultPagination(request: ResultPaginationRequest): TexeraWebSocketEvent = {
    // calculate from index (pageIndex starts from 1 instead of 0)
    val from = request.pageSize * (request.pageIndex - 1)
    val latestExecutionId = getLatestExecutionId(workflowIdentity, computingUnitId).getOrElse(
      throw new IllegalStateException("No execution is recorded")
    )

    val storageUriOption = WorkflowExecutionsResource.getResultUriByLogicalPortId(
      latestExecutionId,
      OperatorIdentity(request.operatorID),
      PortIdentity()
    )

    storageUriOption match {
      case Some(storageUri) =>
        val paginationIterable = {
          DocumentFactory
            .openDocument(storageUri)
            ._1
            .asInstanceOf[VirtualDocument[Tuple]]
            .getRange(from, from + request.pageSize)
            .to(Iterable)
        }
        // Use noTruncation flag to prevent string truncation when requested
        val isVisualization = request.noTruncation.getOrElse(false)
        val mappedResults = convertTuplesToJson(paginationIterable, isVisualization)
        val attributes = paginationIterable.headOption
          .map(_.getSchema.getAttributes)
          .getOrElse(List.empty)
        PaginatedResultEvent.apply(request, mappedResults, attributes)

      case None =>
        // Handle the case when storageUri is empty
        PaginatedResultEvent.apply(request, List.empty, List.empty)
    }
  }

  private def onResultUpdate(executionId: ExecutionIdentity, physicalPlan: PhysicalPlan): Unit = {
    workflowStateStore.resultStore.updateState { _ =>
      val newInfo: Map[OperatorIdentity, OperatorResultMetadata] = {
        WorkflowExecutionsResource
          .getResultUrisByExecutionId(executionId)
          .map(uri => {
            val count = DocumentFactory.openDocument(uri)._1.getCount.toInt

            val (_, _, globalPortIdOption, _) = VFSURIFactory.decodeURI(uri)

            // Retrieve the mode of the specified output port
            val mode = physicalPlan
              .getPhysicalOpsOfLogicalOp(globalPortIdOption.get.opId.logicalOpId)
              .flatMap(_.outputPorts.get(globalPortIdOption.get.portId))
              .map(_._1.mode)
              .head

            val changeDetector =
              if (mode == OutputMode.SET_SNAPSHOT) {
                UUID.randomUUID.toString
              } else ""
            (globalPortIdOption.get.opId.logicalOpId, OperatorResultMetadata(count, changeDetector))
          })
          .toMap
      }
      WorkflowResultStore(newInfo)
    }
  }

}
