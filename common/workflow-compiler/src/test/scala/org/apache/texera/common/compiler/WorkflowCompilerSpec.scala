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

package org.apache.texera.common.compiler

import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.amber.core.executor.{ExecFactory, OpExecWithClassName, OpExecWithCode}
import org.apache.texera.amber.core.state.State
import org.apache.texera.amber.core.storage.{RepositoryVersionResolver, ScanFileResolver}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.WorkflowIdentity
import org.apache.texera.amber.core.workflow.{
  OutputPort,
  PhysicalOp,
  PhysicalPlanRoundTrip,
  PortIdentity,
  RepositoryMounts,
  SchemaNotAvailableException,
  WorkflowContext
}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.COMPILATION_ERROR
import org.apache.texera.amber.operator.aggregate.AggregationFunction
import org.apache.texera.amber.operator.filter.{
  ComparisonType,
  FilterPredicate,
  SpecializedFilterOpDesc
}
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.loop.{LoopEndOpDesc, LoopStartOpDesc}
import org.apache.texera.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}
import org.apache.texera.amber.operator.projection.{AttributeUnit, ProjectionOpDesc}
import org.apache.texera.amber.operator.sort.{SortCriteriaUnit, SortOpDesc, SortPreference}
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.UiUDFParameter
import org.apache.texera.amber.operator.udf.python.{PythonUDFOpDescV2, PythonUdfUiParameterInjector}
import org.apache.texera.amber.operator.udf.python.source.PythonUDFSourceOpDescV2
import org.apache.texera.amber.operator.{
  LogicalOp,
  PortDescription,
  PythonOperatorDescriptor,
  TestOperators
}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.config.EnvironmentalVariable
import org.scalatest.flatspec.AnyFlatSpec

import java.nio.file.{Path, Paths}
import scala.collection.mutable

/**
  * Direct unit coverage for the unified [[WorkflowCompiler]].
  *
  * Owns *compiler-behavior* tests across both paths: lenient (editing-time —
  * accumulate per-operator errors, schema propagation) and strict
  * (pre-execution — the same errors, thrown together), plus physical-plan
  * shape and the set of output ports needing storage. `WorkflowCompilationResourceSpec` owns
  * *resource-layer* tests — HTTP status, response type discriminator, JSON
  * envelope. Drawing the line here keeps each spec focused.
  *
  * Bypassing the resource layer also sidesteps a separate NPE in response
  * serialization (apache/texera#5021); these compiler-level tests stay
  * green once that bug is fixed.
  */
class WorkflowCompilerSpec extends AnyFlatSpec {

  private def newContext(): WorkflowContext =
    new WorkflowContext(workflowId = WorkflowIdentity(0))

  // The scan sources here read fixture files on the local disk.
  private def newCompiler(
      fileResolver: ScanFileResolver = TestOperators.fixtureFileResolver
  ): WorkflowCompiler =
    new WorkflowCompiler(
      newContext(),
      fileResolver,
      TestOperators.fixtureRepositoryResolver,
      Some(TestOperators.fixtureMountRoot)
    )

  /**
    * Saves the plan a Strict compile made to run, with the context it runs under (the context the
    * compile was given, storing the results the compile asks to store), and fails unless it reads
    * back as the same plan. Every plan this spec makes to run goes through it.
    *
    * @return the plan's saved JSON text
    */
  private def assertSavable(result: WorkflowCompilationResult): String = {
    val context = newContext()
    context.workflowSettings = context.workflowSettings.copy(
      outputPortsNeedingStorage = result.outputPortsNeedingStorage
    )
    PhysicalPlanRoundTrip.assertRoundTrips(context, result.physicalPlan.get)
  }

  /** What a Strict compile of `workflow` fails with; the test fails if it compiles. */
  private def strictFailure(
      workflow: LogicalPlanPojo,
      compiler: WorkflowCompiler = newCompiler()
  ): WorkflowCompilationFailed =
    intercept[WorkflowCompilationFailed](
      compiler.compile(workflow, CompilationErrorHandling.Strict)
    )

  /** The message of the only error `failure` holds, which must be `op`'s. */
  private def onlyErrorOf(failure: WorkflowCompilationFailed, op: LogicalOp): String = {
    assert(failure.operatorErrors.keySet == Set(op.operatorIdentifier))
    failure.operatorErrors(op.operatorIdentifier).message
  }

  /**
    * The message a failure with the errors of `listed`, in that order, has: what the failure holds
    * for each, after a line that counts `count` operators with errors.
    */
  private def messageListing(
      failure: WorkflowCompilationFailed,
      count: Int,
      listed: Seq[LogicalOp]
  ): String = {
    val lines = listed.map { op =>
      s"${op.operatorIdentifier.id}: ${failure.operatorErrors(op.operatorIdentifier).message}"
    }
    val header = "The workflow does not compile: " +
      (if (count == 1) "1 operator has an error." else s"$count operators have errors.")
    val more = count - listed.size
    val rest = if (more == 0) Nil else List(s"and $more more operator${if (more == 1) "" else "s"}")
    ((header +: lines) ++ rest).mkString("\n")
  }

  private def csvOp(fileName: String): CSVScanSourceOpDesc = {
    val op = new CSVScanSourceOpDesc()
    op.fileName = Some(fileName)
    op.customDelimiter = Some(",")
    op.hasHeader = true
    op
  }

  private def csvOpNoFile(): CSVScanSourceOpDesc = {
    val op = new CSVScanSourceOpDesc()
    op.customDelimiter = Some(",")
    op.hasHeader = true
    op
  }

  private def projectOp(columns: List[String]): ProjectionOpDesc = {
    val op = new ProjectionOpDesc()
    op.attributes = columns.map(name => new AttributeUnit(name, ""))
    op.isDrop = false
    op
  }

  private def filterOp(predicates: FilterPredicate*): SpecializedFilterOpDesc = {
    val op = new SpecializedFilterOpDesc
    op.predicates = predicates.toList
    op
  }

  private def limitOp(limit: Int): LimitOpDesc = {
    val op = new LimitOpDesc
    op.limit = limit
    op
  }

  // Sort is a real, shipped `PythonOperatorDescriptor` whose `generatePythonCode`
  // rejects an unconfigured operator, so `sortOp()` (no sort keys) and
  // `sortOp("" -> ASC)` (a key with no attribute) are genuine ways for a user to
  // land in the `#EXCEPTION DURING CODE GENERATION:` state.
  private def sortOp(criteria: (String, SortPreference)*): SortOpDesc = {
    val op = new SortOpDesc
    op.attributes = criteria.map {
      case (attributeName, preference) =>
        val unit = new SortCriteriaUnit
        unit.attributeName = attributeName
        unit.sortPreference = preference
        unit
    }.toList
    op
  }

  /**
    * A test-only Python operator whose code generation fails with a
    * whitespace-padded message. No shipped operator raises a padded message, so
    * this is the only way to pin the compiler's regex-group + `trim` extraction
    * of the marker's payload.
    */
  private class PaddedFailurePyOp extends PythonOperatorDescriptor {
    override def asSource(): Boolean = true
    override def generatePythonCode(): String =
      throw new RuntimeException("   padded codegen failure   ")
    override def getOutputSchemas(
        inputSchemas: Map[PortIdentity, Schema]
    ): Map[PortIdentity, Schema] = Map(PortIdentity() -> Schema())
    override def operatorInfo: OperatorInfo =
      OperatorInfo(
        "padded",
        "raises a padded message during code generation",
        OperatorGroupConstants.PYTHON_GROUP,
        List.empty,
        List(OutputPort())
      )
  }

  // -------------------- happy path --------------------

  "WorkflowCompiler" should "produce a populated physicalPlan and no errors for a well-formed plan" in {
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val proj = projectOp(List("Region", "Total Profit"))
    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(csv, proj),
        links = List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            proj.operatorIdentifier,
            PortIdentity(0)
          )
        ),
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(result.physicalPlan.isDefined, "happy path should yield a physical plan")
    assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
    // Schema for both operators' output ports should be populated and non-null —
    // this is the property whose violation triggers the resource-level NPE.
    val projSchemas = result.operatorIdToOutputSchemas(proj.operatorIdentifier)
    assert(projSchemas.values.forall(s => s.isDefined && s.get != null))
  }

  it should "propagate schemas through a csv -> projection -> limit -> filter -> filter -> limit chain" in {
    // Real-world editing-shape: source then filter/limit/project ops. Asserts
    // the compiler threads schema through every link so the frontend sees the
    // projected columns at every downstream port. Previously this lived in
    // WorkflowCompilationResourceSpec as an HTTP test, but the property being
    // pinned is compiler-level (schema propagation) — the REST envelope adds
    // no signal.
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val proj = projectOp(List("Region", "Total Profit"))
    val limit1 = limitOp(10)
    val filter1 =
      filterOp(new FilterPredicate("Total Profit", ComparisonType.GREATER_THAN, "10000"))
    val filter2 = filterOp(new FilterPredicate("Region", ComparisonType.NOT_EQUAL_TO, "JPN"))
    val limit2 = limitOp(5)

    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(csv, proj, limit1, filter1, filter2, limit2),
        links = List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            proj.operatorIdentifier,
            PortIdentity(0)
          ),
          LogicalLink(
            proj.operatorIdentifier,
            PortIdentity(0),
            limit1.operatorIdentifier,
            PortIdentity(0)
          ),
          LogicalLink(
            limit1.operatorIdentifier,
            PortIdentity(0),
            filter1.operatorIdentifier,
            PortIdentity(0)
          ),
          LogicalLink(
            filter1.operatorIdentifier,
            PortIdentity(0),
            filter2.operatorIdentifier,
            PortIdentity(0)
          ),
          LogicalLink(
            filter2.operatorIdentifier,
            PortIdentity(0),
            limit2.operatorIdentifier,
            PortIdentity(0)
          )
        ),
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(result.physicalPlan.isDefined)
    assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
    // Projection narrowed [Region, Country, ..., Total Profit] down to two
    // columns; every downstream op should see exactly those two attributes.
    val filter2Schemas = result.operatorIdToOutputSchemas(filter2.operatorIdentifier)
    val outputAttrs = filter2Schemas(PortIdentity(0)).get.attributes
    assert(
      outputAttrs == List(
        new Attribute("Region", AttributeType.STRING),
        new Attribute("Total Profit", AttributeType.DOUBLE)
      ),
      s"projected schema should reach filter2 unchanged, got $outputAttrs"
    )
  }

  // -------------------- lenient-mode error accumulation --------------------

  // The frontend relies on `compile` *never throwing*: a user mid-edit
  // routinely produces an inconsistent plan and the editing UI must render
  // structured per-operator errors. These tests pin the contract.

  "WorkflowCompiler" should "accumulate, not throw, when a scan source has no fileName" in {
    val orphan = csvOpNoFile()

    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(orphan),
        links = List.empty,
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(result.physicalPlan.isEmpty, "any error must clear the physical plan")
    val err = result.operatorIdToError(orphan.operatorIdentifier)
    assert(err.`type` == COMPILATION_ERROR)
    assert(err.operatorId == orphan.operatorIdentifier.id)
    assert(err.message.contains("No file selected"), s"unexpected message: ${err.message}")
    assert(err.details.nonEmpty, "stack-trace details should be populated for UI display")
  }

  it should "accumulate when a scan source's fileName points to a non-existent path" in {
    val broken = csvOp("/does/not/exist/missing.csv")

    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(broken),
        links = List.empty,
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(result.physicalPlan.isEmpty)
    assert(result.operatorIdToError.contains(broken.operatorIdentifier))
    // The resolver raises org.apache.commons.vfs2.FileNotFoundException; its message
    // bundle wraps whatever text it is given, so the only stable substring across that
    // wording and any java.io.FileNotFoundException fallback is the bad path itself.
    assert(
      result.operatorIdToError(broken.operatorIdentifier).message.contains("missing.csv"),
      s"unexpected message: ${result.operatorIdToError(broken.operatorIdentifier).message}"
    )
  }

  it should "read a scan source from the file its resolver names, not from the name as typed" in {
    // The name is not a path to anything; only the resolver knows which file it stands for.
    val asked = scala.collection.mutable.ArrayBuffer.empty[String]
    val resolver: ScanFileResolver = fileName => {
      asked += fileName
      TestOperators.localFileUri(TestOperators.CountrySalesSmallCsvPath)
    }
    val scan = csvOp("a-name-only-the-resolver-understands")
    scan.hasHeader = true

    val result = newCompiler(resolver).compile(
      LogicalPlanPojo(
        operators = List(scan),
        links = List.empty,
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(asked.toList == List("a-name-only-the-resolver-understands"))
    assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
    assert(
      scan.fileName.contains(
        TestOperators.localFileUri(TestOperators.CountrySalesSmallCsvPath).toASCIIString
      )
    )
    val schema = result.operatorIdToOutputSchemas(scan.operatorIdentifier).values.head
    assert(schema.exists(_.getAttributeNames.nonEmpty), "the schema comes from the resolved file")
  }

  it should "report a name its resolver refuses as that operator's error, with no schema" in {
    // The file exists on disk; it is the resolver's answer that counts.
    val refuseAll: ScanFileResolver =
      fileName => throw new org.apache.commons.vfs2.FileNotFoundException(fileName)
    val scan = csvOp(TestOperators.CountrySalesSmallCsvPath)

    val result = newCompiler(refuseAll).compile(
      LogicalPlanPojo(
        operators = List(scan),
        links = List.empty,
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(result.physicalPlan.isEmpty)
    assert(result.operatorIdToError.contains(scan.operatorIdentifier))
    assert(scan.fileName.contains(TestOperators.CountrySalesSmallCsvPath), "the name is untouched")
    assert(
      result.operatorIdToOutputSchemas
        .get(scan.operatorIdentifier)
        .forall(_.values.forall(_.forall(_ == null))),
      "nothing was read from the file, so there is no schema to return"
    )
  }

  it should "accumulate a per-operator error when projection references a non-existent attribute" in {
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val badProjection = projectOp(List("DoesNotExist"))

    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(csv, badProjection),
        links = List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            badProjection.operatorIdentifier,
            PortIdentity(0)
          )
        ),
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(result.physicalPlan.isEmpty)
    assert(
      result.operatorIdToError.contains(badProjection.operatorIdentifier),
      s"projection should be in errors, got ${result.operatorIdToError.keySet}"
    )
    // The upstream csv ran fine, so its output schema should still be present
    // — partial progress is the whole point of lenient mode.
    assert(
      result.operatorIdToOutputSchemas.contains(csv.operatorIdentifier),
      "upstream csv's schemas should be retained even when downstream fails"
    )
  }

  it should "not throw when given an empty plan" in {
    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List.empty,
        links = List.empty,
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )
    assert(result.operatorIdToError.isEmpty)
    assert(result.operatorIdToOutputSchemas.isEmpty)
    assert(result.physicalPlan.isDefined, "an empty plan compiles to an empty physical plan")
    assert(result.physicalPlan.get.operators.isEmpty)
    assert(result.physicalPlan.get.links.isEmpty)
  }

  // -------------------- multi-error accumulation --------------------

  // Re-anchor the subject after the sub-section.
  "WorkflowCompiler" should "accumulate errors for multiple unrelated failing ops in one compile" in {
    val orphan1 = csvOpNoFile()
    val orphan2 = csvOpNoFile()

    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(orphan1, orphan2),
        links = List.empty,
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(result.physicalPlan.isEmpty)
    // Both ops must appear in the error map — the frontend renders per-op
    // diagnostics in parallel, so swallowing all-but-one would silently break
    // multi-error workflows.
    assert(
      result.operatorIdToError.contains(orphan1.operatorIdentifier) &&
        result.operatorIdToError.contains(orphan2.operatorIdentifier),
      s"expected both csvs in errors, got ${result.operatorIdToError.keySet}"
    )
  }

  // -------------------- Python code-generation error path --------------------

  // A `PythonOperatorDescriptor` whose `generatePythonCode` throws does not
  // propagate the failure: it embeds `#EXCEPTION DURING CODE GENERATION: <msg>`
  // in the generated code so schema propagation can still run. The compiler is
  // the consumer that turns that marker back into a per-operator error, so these
  // tests pin the marker -> error translation from the compiler's side.

  // Re-anchor the subject after the sub-section.
  "WorkflowCompiler" should "accumulate a per-operator error when a Python operator's code generation fails" in {
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val unconfiguredSort = sortOp() // no sort keys -> generatePythonCode throws

    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(csv, unconfiguredSort),
        links = List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            unconfiguredSort.operatorIdentifier,
            PortIdentity(0)
          )
        ),
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(result.physicalPlan.isEmpty, "any error must clear the physical plan")
    val err = result.operatorIdToError(unconfiguredSort.operatorIdentifier)
    assert(err.`type` == COMPILATION_ERROR)
    assert(err.operatorId == unconfiguredSort.operatorIdentifier.id)
    assert(
      err.message.contains(
        "Operator is not configured properly: " +
          "requirement failed: Sort operator requires at least one sort key."
      ),
      s"unexpected message: ${err.message}"
    )
    // The failure belongs to the Python operator alone; the upstream csv compiled.
    assert(
      !result.operatorIdToError.contains(csv.operatorIdentifier),
      s"only the Python op should have errored, got ${result.operatorIdToError.keySet}"
    )
    // Lenient mode records the error and keeps going *within* the same operator:
    // the terminal sort's output port is still collected for storage, which only
    // happens if the marker check did not abort the operator's expansion.
    assert(
      result.outputPortsNeedingStorage.exists(
        _.opId.logicalOpId == unconfiguredSort.operatorIdentifier
      ),
      s"expected the sort's port to still be collected, got ${result.outputPortsNeedingStorage}"
    )
  }

  it should "attribute each Python code-generation failure to its own logical operator" in {
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val noKeys = sortOp()
    val blankKey = sortOp("" -> SortPreference.ASC)

    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(csv, noKeys, blankKey),
        links = List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            noKeys.operatorIdentifier,
            PortIdentity(0)
          ),
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            blankKey.operatorIdentifier,
            PortIdentity(0)
          )
        ),
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(
      result.operatorIdToError.keySet ==
        Set(noKeys.operatorIdentifier, blankKey.operatorIdentifier),
      s"expected exactly the two Python ops in errors, got ${result.operatorIdToError.keySet}"
    )
    // Each operator carries the message its *own* code generation raised — a
    // mixed-up mapping would put the wrong diagnostic on the wrong UI node.
    assert(
      result
        .operatorIdToError(noKeys.operatorIdentifier)
        .message
        .contains("Operator is not configured properly: requirement failed: Sort operator requires")
    )
    assert(
      result
        .operatorIdToError(blankKey.operatorIdentifier)
        .message
        .contains(
          "Operator is not configured properly: " +
            "requirement failed: Each sort key must have an attribute selected."
        )
    )
    // The rest of the plan still compiled: the csv's schemas survive.
    assert(
      result.operatorIdToOutputSchemas.contains(csv.operatorIdentifier),
      "upstream csv's schemas should be retained even when downstream Python ops fail"
    )
  }

  it should "trim the marker's message and report it as a plain RuntimeException" in {
    val padded = new PaddedFailurePyOp

    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(padded),
        links = List.empty,
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    // `message` is the RuntimeException's toString, so the extracted payload is
    // the tail of it: exactly the raised message with its padding removed, and
    // with the marker itself stripped off by the regex.
    val message = result.operatorIdToError(padded.operatorIdentifier).message
    assert(
      message.endsWith("Operator is not configured properly: padded codegen failure"),
      s"unexpected message: [$message]"
    )
    // The head of it is the exception's class name: the compiler wraps the
    // extracted payload in a plain `RuntimeException` and the error map stores
    // `err.toString`, so the type is part of what the UI renders. Pinning it
    // here keeps the wrapper type from silently drifting.
    assert(
      message.startsWith("java.lang.RuntimeException: "),
      s"expected a plain RuntimeException to be reported, got: [$message]"
    )
    assert(
      !message.contains("#EXCEPTION DURING CODE GENERATION"),
      s"the marker itself must not leak into the user-facing message: [$message]"
    )
  }

  it should "report no code-generation error for a well-formed Python operator" in {
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val configuredSort = sortOp("Region" -> SortPreference.ASC)

    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(csv, configuredSort),
        links = List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            configuredSort.operatorIdentifier,
            PortIdentity(0)
          )
        ),
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
    assert(result.physicalPlan.isDefined)
    // Same operator, same Python code path — the only difference is that code
    // generation succeeded, so no marker is present to be turned into an error.
    val sortPhysicalOps =
      result.physicalPlan.get.getPhysicalOpsOfLogicalOp(configuredSort.operatorIdentifier)
    assert(sortPhysicalOps.nonEmpty)
    assert(sortPhysicalOps.forall(_.isPythonBased), "Sort must still be a Python-based operator")
    assert(sortPhysicalOps.forall(!_.getCode.contains("#EXCEPTION DURING CODE GENERATION")))
  }

  it should "not subject non-Python operators to the code-generation check" in {
    // Non-Python operators carry no code at all — `getCode` throws
    // IllegalAccessError on them — so the check must stay behind the
    // `isPythonBased` guard or every Scala operator would fail to compile.
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val filter = filterOp(new FilterPredicate("Region", ComparisonType.EQUAL_TO, "Asia"))

    val result = newCompiler().compile(
      LogicalPlanPojo(
        operators = List(csv, filter),
        links = List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            filter.operatorIdentifier,
            PortIdentity(0)
          )
        ),
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
    val physicalOps = result.physicalPlan.get.operators
    assert(
      physicalOps.forall(!_.isPythonBased),
      "this plan must contain no Python-based op, otherwise the test proves nothing"
    )
  }

  // -------------------- physical-plan shape --------------------

  private def pojo(
      operators: List[org.apache.texera.amber.operator.LogicalOp],
      links: List[LogicalLink],
      opsToViewResult: List[String] = List.empty
  ): LogicalPlanPojo =
    LogicalPlanPojo(operators, links, opsToViewResult, List.empty)

  // Re-anchor the subject after the sub-section.
  "WorkflowCompiler" should "produce a physical plan that contains at least one physical op per logical op" in {
    val csv = TestOperators.smallCsvScanOpDesc()
    val keyword = TestOperators.keywordSearchOpDesc("Region", "Asia")

    val result = newCompiler().compile(
      pojo(
        List(csv, keyword),
        List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(),
            keyword.operatorIdentifier,
            PortIdentity()
          )
        )
      )
    )

    assert(result.logicalPlan.operators.size == 2)
    val physicalPlan = result.physicalPlan.get
    assert(physicalPlan.getPhysicalOpsOfLogicalOp(csv.operatorIdentifier).nonEmpty)
    assert(physicalPlan.getPhysicalOpsOfLogicalOp(keyword.operatorIdentifier).nonEmpty)
  }

  it should "translate a logical link into a physical link between the two logical ops' physical ops" in {
    val csv = TestOperators.smallCsvScanOpDesc()
    val keyword = TestOperators.keywordSearchOpDesc("Region", "Asia")

    val result = newCompiler().compile(
      pojo(
        List(csv, keyword),
        List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(),
            keyword.operatorIdentifier,
            PortIdentity()
          )
        )
      )
    )

    val physicalPlan = result.physicalPlan.get
    val csvPhysIds =
      physicalPlan.getPhysicalOpsOfLogicalOp(csv.operatorIdentifier).map(_.id).toSet
    val keywordPhysIds =
      physicalPlan.getPhysicalOpsOfLogicalOp(keyword.operatorIdentifier).map(_.id).toSet

    val bridging = physicalPlan.links.filter(l =>
      csvPhysIds.contains(l.fromOpId) && keywordPhysIds.contains(l.toOpId)
    )
    assert(bridging.nonEmpty, "expected at least one physical link from csv to keyword")
  }

  // -------------------- storage-port collection --------------------

  // The compiler walks `logicalPlan.getTerminalOperatorIds` (logical ops with
  // out-degree 0) plus `opsToViewResult`, and for every physical op of those
  // logical ops collects every non-internal output port into the result's
  // `outputPortsNeedingStorage`. These tests pin both the terminal-default and
  // the opsToViewResult-additive paths, and that internal ports are filtered.

  "WorkflowCompiler" should "mark the terminal op's output port as needing storage" in {
    val csv = TestOperators.smallCsvScanOpDesc()
    val keyword = TestOperators.keywordSearchOpDesc("Region", "Asia")

    val result = newCompiler().compile(
      pojo(
        List(csv, keyword),
        List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(),
            keyword.operatorIdentifier,
            PortIdentity()
          )
        )
      )
    )

    val storage = result.outputPortsNeedingStorage
    assert(
      storage.exists(_.opId.logicalOpId == keyword.operatorIdentifier),
      s"expected keyword to be marked for storage, got ${storage.map(_.opId.logicalOpId)}"
    )
    assert(
      !storage.exists(_.opId.logicalOpId == csv.operatorIdentifier),
      "csv is not terminal and was not requested via opsToViewResult; it should not be in storage"
    )
  }

  it should "also mark a non-terminal op for storage when it is named in opsToViewResult" in {
    val csv = TestOperators.smallCsvScanOpDesc()
    val keyword = TestOperators.keywordSearchOpDesc("Region", "Asia")

    val result = newCompiler().compile(
      pojo(
        List(csv, keyword),
        List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(),
            keyword.operatorIdentifier,
            PortIdentity()
          )
        ),
        opsToViewResult = List(csv.operatorIdentifier.id)
      )
    )

    val logicalOpsInStorage = result.outputPortsNeedingStorage.map(_.opId.logicalOpId)
    assert(
      logicalOpsInStorage.contains(csv.operatorIdentifier),
      s"opsToViewResult should add csv to storage, got $logicalOpsInStorage"
    )
    assert(
      logicalOpsInStorage.contains(keyword.operatorIdentifier),
      s"terminal keyword should remain in storage, got $logicalOpsInStorage"
    )
  }

  it should "treat a single source op as terminal and mark its output port for storage" in {
    val csv = TestOperators.smallCsvScanOpDesc()

    val result = newCompiler().compile(pojo(List(csv), List.empty))

    val storage = result.outputPortsNeedingStorage
    assert(
      storage.exists(_.opId.logicalOpId == csv.operatorIdentifier),
      "single op has out-degree 0, so its output port should land in storage"
    )
    assert(
      storage.forall(!_.portId.internal),
      "compiler must filter out internal ports; storage should expose only user-visible outputs"
    )
  }

  // -------------------- strict-mode error semantics --------------------

  // Re-anchor the subject after the sub-section.
  "WorkflowCompiler in strict mode" should
    "fail with the scan's error when a scan source has no fileName set" in {
    // As in the lenient counterpart above, `resolveScanSourceOpFileName` keeps the failure as the
    // operator's error and goes on; Strict then throws it, with any others, instead of returning
    // it (the execution path's contract: a plan made to run has no errors).
    val orphanCsv = new CSVScanSourceOpDesc()

    val failure = strictFailure(pojo(List(orphanCsv), List.empty))

    val error = failure.operatorErrors(orphanCsv.operatorIdentifier)
    assert(
      onlyErrorOf(failure, orphanCsv) == "java.lang.RuntimeException: No file selected. " +
        "Please select a file from the 'File' dropdown in the right panel."
    )
    // A WorkflowFatalError of the operator, as the editing compile reports it.
    assert(error.`type` == COMPILATION_ERROR)
    assert(error.operatorId == orphanCsv.operatorIdentifier.id)
    assert(error.details.nonEmpty, "stack-trace details should be populated for UI display")
    assert(
      failure.getMessage == "The workflow does not compile: 1 operator has an error.\n" +
        s"${orphanCsv.operatorIdentifier.id}: ${error.message}"
    )
    // Its cause is that error itself, thrown where file resolution found it, so a log of the
    // failure shows where it came from: not the schema error the scan also has, found later.
    val cause = failure.getCause
    assert(cause != null, "the failure should have the operator's error as its cause")
    assert(cause.toString == error.message)
    assert(
      cause.getStackTrace.exists(_.getMethodName.contains("resolveScanSourceOpFileName")),
      cause.getStackTrace.take(8).mkString("\n")
    )
  }

  it should "return a defined physicalPlan for a well-formed plan" in {
    // The execution path calls `physicalPlan.get` on the result, so a strict
    // success must always carry a plan.
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val proj = projectOp(List("Region", "Total Profit"))

    val result = newCompiler().compile(
      pojo(
        List(csv, proj),
        List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            proj.operatorIdentifier,
            PortIdentity(0)
          )
        )
      ),
      CompilationErrorHandling.Strict
    )

    assert(result.physicalPlan.isDefined, "strict success must yield a physical plan")
    assert(result.operatorIdToError.isEmpty)
    assert(result.outputPortsNeedingStorage.nonEmpty, "terminal ports still collected in strict")
    assertSavable(result)
  }

  it should "fail on schema-propagation errors, as the operator's error" in {
    // A projection on a missing column fails schema *propagation*, not plan
    // expansion: `propagateSchema` stores a Left on the output port instead of
    // throwing, so this error only becomes visible when output schemas are
    // collected. Strict must fail on it too — otherwise the plan would be
    // launched and only fail at runtime. The lenient counterpart above returns
    // the same per-operator error instead of throwing it.
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val badProjection = projectOp(List("DoesNotExist"))

    val failure = strictFailure(
      pojo(
        List(csv, badProjection),
        List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            badProjection.operatorIdentifier,
            PortIdentity(0)
          )
        )
      )
    )
    val message = onlyErrorOf(failure, badProjection)
    assert(
      message.contains("DoesNotExist"),
      s"the schema error should name the missing attribute, got: $message"
    )
  }

  it should "fail with the Python operator's error when its code generation failed" in {
    // The marker found in the generated code is the operator's error, as in the
    // lenient counterpart above, which Strict throws instead of returning.
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val unconfiguredSort = sortOp()

    val failure = strictFailure(
      pojo(
        List(csv, unconfiguredSort),
        List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            unconfiguredSort.operatorIdentifier,
            PortIdentity(0)
          )
        )
      )
    )
    assert(
      onlyErrorOf(failure, unconfiguredSort) ==
        "java.lang.RuntimeException: Operator is not configured properly: " +
          "requirement failed: Sort operator requires at least one sort key."
    )
  }

  it should "not throw for a well-formed Python operator" in {
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val configuredSort = sortOp("Region" -> SortPreference.DESC)

    val result = newCompiler().compile(
      pojo(
        List(csv, configuredSort),
        List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            configuredSort.operatorIdentifier,
            PortIdentity(0)
          )
        )
      ),
      CompilationErrorHandling.Strict
    )

    assert(result.physicalPlan.isDefined)
    assert(result.operatorIdToError.isEmpty)
    assertSavable(result)
  }

  it should "fail with every operator's error at once, as the editing compile reports them" in {
    // One error from each step that finds them: a scan with no file (file resolution), a Sort
    // that generates no code (expansion), and a Projection on a column its input lacks (schema
    // propagation). Strict goes on past each, as Lenient does, and throws them together.
    val orphan = csvOpNoFile()
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val unconfiguredSort = sortOp()
    val badProjection = projectOp(List("DoesNotExist"))
    val workflow = pojo(
      List(orphan, csv, unconfiguredSort, badProjection),
      List(linked(csv, unconfiguredSort), linked(csv, badProjection))
    )
    val failing = List(orphan, unconfiguredSort, badProjection)

    val failure = strictFailure(workflow)

    // Each operator's own error, in the workflow's order; the csv compiled.
    assert(failure.operatorErrors.keys.toList == failing.map(_.operatorIdentifier))
    failure.operatorErrors.foreach {
      case (op, error) =>
        assert(error.`type` == COMPILATION_ERROR)
        assert(error.operatorId == op.id)
        assert(error.details.nonEmpty)
    }
    def messageOf(op: LogicalOp): String = failure.operatorErrors(op.operatorIdentifier).message
    assert(messageOf(orphan).contains("No file selected"), messageOf(orphan))
    assert(
      messageOf(unconfiguredSort) == "java.lang.RuntimeException: Operator is not configured " +
        "properly: requirement failed: Sort operator requires at least one sort key."
    )
    assert(messageOf(badProjection).contains("DoesNotExist"), messageOf(badProjection))
    assert(failure.getMessage == messageListing(failure, 3, failing))
    // The cause is the error of the operator listed first.
    assert(failure.getCause.toString == messageOf(orphan), failure.getCause)
    // The editing compile of the workflow shows its user the same errors.
    val lenient = newCompiler().compile(workflow)
    assert(
      lenient.operatorIdToError.view.mapValues(_.message).toMap ==
        failure.operatorErrors.view.mapValues(_.message).toMap
    )
  }

  it should "make the error of the operator listed first the cause, whichever step found it" in {
    // File resolution runs before expansion, so the scan's error is found before the Sort's; but
    // the workflow has the Sort first, and so does the failure.
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val unconfiguredSort = sortOp()
    val orphan = csvOpNoFile()

    val failure = strictFailure(
      pojo(List(csv, unconfiguredSort, orphan), List(linked(csv, unconfiguredSort)))
    )

    assert(
      failure.operatorErrors.keys.toList ==
        List(unconfiguredSort, orphan).map(_.operatorIdentifier)
    )
    assert(
      failure.getCause.toString ==
        failure.operatorErrors(unconfiguredSort.operatorIdentifier).message,
      failure.getCause
    )
  }

  it should "list the operators upstream first and name five, so a chain's cause comes first" in {
    // A scan of a file that does not exist, and six Limits below it, which then get no schema:
    // seven operators with errors, the cause of them all the most upstream. They are given to
    // the compiler the other way round, so the order is the workflow's, not the order given.
    val scan = csvOp("/does/not/exist/missing.csv")
    val limits = List.fill(6)(limitOp(10))
    val chained = scan :: limits

    val failure = strictFailure(pojo(chained.reverse, chain(chained: _*)))

    assert(failure.operatorErrors.keys.toList == chained.map(_.operatorIdentifier))
    val scanError = failure.operatorErrors(scan.operatorIdentifier).message
    assert(scanError.contains("missing.csv"), scanError)
    limits.foreach { limit =>
      assert(
        failure.operatorErrors(limit.operatorIdentifier).message ==
          s"${classOf[SchemaNotAvailableException].getName}: schema is not available"
      )
    }
    assert(failure.getMessage == messageListing(failure, 7, chained.take(5)))
    // The chain's cause is the failure's cause too.
    assert(failure.getCause.toString == scanError, failure.getCause)
  }

  it should "make from a valid workflow the plan the editing compile makes" in {
    // With nothing to pin, the two compiles differ only in what they do with errors, and here
    // there are none: the plan to run is the plan compiled, whatever Strict does with errors.
    val ops = List(
      csvOp(TestOperators.CountrySalesSmallCsvPath),
      projectOp(List("Region", "Total Profit")),
      limitOp(10),
      filterOp(new FilterPredicate("Total Profit", ComparisonType.GREATER_THAN, "10000")),
      sortOp("Region" -> SortPreference.ASC)
    )
    val workflow = pojo(ops, chain(ops: _*))

    val strict = newCompiler().compile(workflow, CompilationErrorHandling.Strict)
    val lenient = newCompiler().compile(workflow)

    assert(strict.operatorIdToError.isEmpty, s"unexpected errors: ${strict.operatorIdToError}")
    assert(lenient.operatorIdToError.isEmpty, s"unexpected errors: ${lenient.operatorIdToError}")
    assert(strict.operatorIdToOutputSchemas == lenient.operatorIdToOutputSchemas)
    assert(strict.outputPortsNeedingStorage == lenient.outputPortsNeedingStorage)
    assert(assertSavable(strict) == assertSavable(lenient))
  }

  // -------------------- datasets and models a UDF names --------------------

  // A plan made to run (Strict) pins every dataset and model version a UDF names and keeps only
  // the result on the operator; the editing path (Lenient) leaves the binding alone. These tests
  // stand in for the database with the fixture resolver, which knows two versions.

  private val datasetVersionPath = "/dataset/owner@x.com/sales/v1"
  private val modelVersionPath = "/model/owner@x.com/iris/v2"
  private val planMountRoot = TestOperators.fixtureMountRoot

  /**
    * The fixture resolver, recording every path it is asked for; it also refuses `refused`, as
    * for versions the plan's user may not read.
    */
  private class RecordingResolver(refused: Set[String] = Set.empty)
      extends RepositoryVersionResolver {
    val asked: mutable.ArrayBuffer[String] = mutable.ArrayBuffer.empty
    override def resolve(versionPath: String): (String, String) = {
      asked += versionPath
      if (refused.contains(versionPath)) throw new FileNotFoundException(versionPath)
      TestOperators.fixtureRepositoryResolver.resolve(versionPath)
    }
  }

  private def bindingCompiler(
      resolver: RepositoryVersionResolver,
      mountRoot: Option[Path] = Some(planMountRoot)
  ): WorkflowCompiler =
    new WorkflowCompiler(newContext(), TestOperators.fixtureFileResolver, resolver, mountRoot)

  private def uiParameter(
      name: String,
      inputType: String,
      value: String,
      attributeType: AttributeType = AttributeType.STRING
  ): UiUDFParameter = {
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute(name, attributeType)
    parameter.inputType = inputType
    parameter.value = value
    parameter
  }

  private val sourceUdfCode =
    """from pytexera import *
      |
      |class GenerateOperator(UDFSourceOperator):
      |    def produce(self):
      |        yield {'a': 1}
      |""".stripMargin

  private val tupleUdfCode =
    """from pytexera import *
      |
      |class ProcessTupleOperator(UDFOperatorV2):
      |    def process_tuple(self, tuple_, port):
      |        yield tuple_
      |""".stripMargin

  /** A source UDF that names a dataset and a model version, and takes a plain count. */
  private def resourceSourceUdf(): PythonUDFSourceOpDescV2 = {
    val udf = new PythonUDFSourceOpDescV2
    udf.code = sourceUdfCode
    udf.columns = List(new Attribute("a", AttributeType.INTEGER))
    udf.uiParameters = List(
      uiParameter("DATA", "dataset", datasetVersionPath),
      uiParameter("MODEL", "model", modelVersionPath),
      uiParameter("count", "", "7", AttributeType.INTEGER)
    )
    udf
  }

  /** A UDF downstream of `resourceSourceUdf` that names the same dataset version. */
  private def resourceTupleUdf(): PythonUDFOpDescV2 = {
    val udf = new PythonUDFOpDescV2
    udf.code = tupleUdfCode
    udf.retainInputColumns = true
    udf.uiParameters = List(uiParameter("DATA", "dataset", datasetVersionPath))
    udf
  }

  private def resourcePlan(source: LogicalOp, downstream: LogicalOp): LogicalPlanPojo =
    pojo(
      List(source, downstream),
      List(
        LogicalLink(
          source.operatorIdentifier,
          PortIdentity(0),
          downstream.operatorIdentifier,
          PortIdentity(0)
        )
      )
    )

  private def physicalOpOf(result: WorkflowCompilationResult, op: LogicalOp): PhysicalOp =
    result.physicalPlan.get.getPhysicalOpsOfLogicalOp(op.operatorIdentifier).head

  private def mountedAt(name: String, inputType: String, directory: String): UiUDFParameter =
    uiParameter(name, inputType, Paths.get(directory).toString)

  "WorkflowCompiler in strict mode" should
    "pin what each UDF names and keep only the result on the operator" in {
    val resolver = new RecordingResolver
    val source = resourceSourceUdf()
    val downstream = resourceTupleUdf()

    val result = bindingCompiler(resolver)
      .compile(resourcePlan(source, downstream), CompilationErrorHandling.Strict)

    // No operator of a plan made to run holds a binding for the engine to force.
    assert(result.physicalPlan.get.operators.forall(_.resourceBinding.isEmpty))
    val sourceOp = physicalOpOf(result, source)
    assert(
      sourceOp.repositoryMounts.contains(
        RepositoryMounts(planMountRoot.toString, Set("dataset-1:d4t4", "model-1:m0d3l"))
      )
    )
    assert(
      sourceOp.opExecInitInfo == OpExecWithCode(
        PythonUdfUiParameterInjector.inject(
          sourceUdfCode,
          List(
            mountedAt("DATA", "dataset", "/mnt/texera-mounts/dataset-1/d4t4"),
            mountedAt("MODEL", "model", "/mnt/texera-mounts/model-1/m0d3l"),
            uiParameter("count", "", "7", AttributeType.INTEGER)
          )
        ),
        "python"
      )
    )
    val downstreamOp = physicalOpOf(result, downstream)
    assert(
      downstreamOp.repositoryMounts.contains(
        RepositoryMounts(planMountRoot.toString, Set("dataset-1:d4t4"))
      )
    )
    assert(
      downstreamOp.opExecInitInfo == OpExecWithCode(
        PythonUdfUiParameterInjector.inject(
          tupleUdfCode,
          List(mountedAt("DATA", "dataset", "/mnt/texera-mounts/dataset-1/d4t4"))
        ),
        "python"
      )
    )
    assert(
      resolver.asked.sorted == List(datasetVersionPath, datasetVersionPath, modelVersionPath)
    )
    // Binding changes only the code and what to mount: the schemas are those of the compile.
    assert(result.operatorIdToError.isEmpty)
    assert(
      result.operatorIdToOutputSchemas(downstream.operatorIdentifier).values.toList ==
        List(Some(Schema().add(new Attribute("a", AttributeType.INTEGER))))
    )
    assertSavable(result)
  }

  it should "leave an operator that names no dataset or model as it compiled" in {
    val resolver = new RecordingResolver
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)

    val result = bindingCompiler(resolver)
      .compile(pojo(List(csv), List.empty), CompilationErrorHandling.Strict)

    val op = physicalOpOf(result, csv)
    assert(op.repositoryMounts.isEmpty && op.resourceBinding.isEmpty)
    assert(op.opExecInitInfo.isInstanceOf[OpExecWithClassName])
    assert(resolver.asked.isEmpty)
    assertSavable(result)
  }

  it should "pin nothing for a plan that fails otherwise, binding only once the rest is valid" in {
    // Pinning is a database lookup per version, so a plan that could not run costs none: here
    // the UDF sits downstream of a Projection on a column its input does not have.
    val resolver = new RecordingResolver
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val badProjection = projectOp(List("DoesNotExist"))
    val downstream = resourceTupleUdf()

    val failure = strictFailure(
      pojo(
        List(csv, badProjection, downstream),
        List(
          LogicalLink(
            csv.operatorIdentifier,
            PortIdentity(0),
            badProjection.operatorIdentifier,
            PortIdentity(0)
          ),
          LogicalLink(
            badProjection.operatorIdentifier,
            PortIdentity(0),
            downstream.operatorIdentifier,
            PortIdentity(0)
          )
        )
      ),
      bindingCompiler(resolver)
    )
    // Both schema errors, the Projection's own first: then the UDF's, whose input schema is not
    // available.
    assert(
      failure.operatorErrors.keys.toList ==
        List(badProjection.operatorIdentifier, downstream.operatorIdentifier)
    )
    val projectionError = failure.operatorErrors(badProjection.operatorIdentifier).message
    assert(projectionError.contains("DoesNotExist"), projectionError)
    assert(
      failure.operatorErrors(downstream.operatorIdentifier).message ==
        s"${classOf[SchemaNotAvailableException].getName}: schema is not available"
    )
    assert(resolver.asked.isEmpty)
  }

  it should "refuse a version the plan's user cannot read, as the error of the UDF naming it" in {
    val resolver = new RecordingResolver(refused = Set(modelVersionPath))
    val source = resourceSourceUdf()

    val failure =
      strictFailure(resourcePlan(source, resourceTupleUdf()), bindingCompiler(resolver))

    // Only the source names the model.
    val message = onlyErrorOf(failure, source)
    assert(message.startsWith(classOf[FileNotFoundException].getName), message)
    assert(message.contains(modelVersionPath), message)
    assert(failure.getMessage == messageListing(failure, 1, List(source)))
    assert(failure.getCause.isInstanceOf[FileNotFoundException], failure.getCause)
    assert(failure.getCause.toString == message)
  }

  it should "throw, as it is, a failure of the lookup that is no error of the UDF's" in {
    // A version that does not exist, or that the plan's user may not read, is the error of the
    // UDF naming it. A database that does not answer is not: the compile fails with that failure
    // itself, which names no operator, so it is not taken for the user's mistake.
    val fault = new RuntimeException("the database did not answer")
    val resolver: RepositoryVersionResolver = _ => throw fault

    val thrown = intercept[RuntimeException] {
      bindingCompiler(resolver)
        .compile(pojo(List(resourceSourceUdf()), List.empty), CompilationErrorHandling.Strict)
    }

    assert(thrown eq fault, s"expected the resolver's own failure, got: $thrown")
  }

  it should "bind every operator, failing with each refused version as its operator's error" in {
    // One refused version hides no other: each operator is bound by itself.
    val resolver = new RecordingResolver(refused = Set(datasetVersionPath))
    val source = resourceSourceUdf()
    val downstream = resourceTupleUdf()

    val failure = strictFailure(resourcePlan(source, downstream), bindingCompiler(resolver))

    assert(failure.operatorErrors.keys.toList == List(source, downstream).map(_.operatorIdentifier))
    failure.operatorErrors.foreach {
      case (op, error) =>
        assert(error.`type` == COMPILATION_ERROR)
        assert(error.operatorId == op.id)
        assert(error.message.startsWith(classOf[FileNotFoundException].getName), error.message)
        assert(error.message.contains(datasetVersionPath), error.message)
    }
    // Each of the two asked for the version it names.
    assert(resolver.asked.count(_ == datasetVersionPath) == 2, resolver.asked)
    assert(failure.getMessage == messageListing(failure, 2, List(source, downstream)))
  }

  it should "fail, before resolving anything, when there is no mount root to write the code against" in {
    val resolver = new RecordingResolver
    val source = resourceSourceUdf()

    val message = onlyErrorOf(
      strictFailure(pojo(List(source), List.empty), bindingCompiler(resolver, mountRoot = None)),
      source
    )
    assert(message.startsWith(classOf[IllegalStateException].getName), message)
    assert(message.contains(EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT), message)
    assert(message.contains(source.operatorIdentifier.id), message)
    assert(resolver.asked.isEmpty)
  }

  it should "pin nothing unchecked when it is given the resolver for compiles that make no plan" in {
    val source = resourceSourceUdf()

    val message = onlyErrorOf(
      strictFailure(
        pojo(List(source), List.empty),
        bindingCompiler(RepositoryVersionResolver.Unavailable)
      ),
      source
    )
    assert(message.startsWith(classOf[IllegalStateException].getName), message)
    assert(message.contains(datasetVersionPath), message)
  }

  "WorkflowCompiler" should
    "leave a UDF's datasets and models to the plan made to run, asking its resolver nothing" in {
    // The editing path compiles on every edit; even a version that does not exist is no error.
    val resolver =
      new RecordingResolver(refused = Set(datasetVersionPath, modelVersionPath))
    val source = resourceSourceUdf()
    val downstream = resourceTupleUdf()

    val result = bindingCompiler(resolver).compile(resourcePlan(source, downstream))

    assert(resolver.asked.isEmpty)
    assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
    val sourceOp = physicalOpOf(result, source)
    assert(sourceOp.resourceBinding.isDefined)
    assert(sourceOp.repositoryMounts.isEmpty)
    assert(
      sourceOp.opExecInitInfo == OpExecWithCode(
        PythonUdfUiParameterInjector.inject(sourceUdfCode, source.uiParameters),
        "python"
      )
    )
    assert(physicalOpOf(result, downstream).resourceBinding.isDefined)
  }

  "WorkflowCompiler.bindResources" should
    "bind one operator exactly as a strict compile binds it in its plan" in {
    // A change to an operator while its workflow is paused is bound this way, by itself.
    val compiler = bindingCompiler(new RecordingResolver)
    val source = resourceSourceUdf()
    val unbound = physicalOpOf(compiler.compile(pojo(List(source), List.empty)), source)
    val strict = compiler.compile(pojo(List(source), List.empty), CompilationErrorHandling.Strict)
    assertSavable(strict)
    val inPlan = physicalOpOf(strict, source)

    val bound = compiler.bindResources(unbound)

    assert(bound.resourceBinding.isEmpty)
    assert(bound.opExecInitInfo == inPlan.opExecInitInfo)
    assert(bound.repositoryMounts.nonEmpty)
    assert(bound.repositoryMounts == inPlan.repositoryMounts)
    // An operator with nothing to bind comes back as it is.
    assert(compiler.bindResources(bound) eq bound)
  }

  // -------------------- a plan made to run, saved and read back --------------------

  // Each Strict compile above saves its plan too (assertSavable); these cover more operators.

  "A plan made to run" should "save and read back for each operator TestOperators builds" in {
    def csv() = TestOperators.smallCsvScanOpDesc()
    def alone(op: LogicalOp) = pojo(List(op), List.empty)
    def after(upstream: LogicalOp, op: LogicalOp) =
      pojo(List(upstream, op), List(linked(upstream, op)))
    val (build, probe, join) = (csv(), csv(), TestOperators.joinOpDesc("Region", "Region"))
    // AsterixDB's source is left out: compiling it reads its schema from a live AsterixDB server.
    val workflows = List(
      "CSV scan" -> alone(csv()),
      "headerless CSV scan" -> alone(TestOperators.headerlessSmallCsvScanOpDesc()),
      "multi-line CSV scan" -> alone(TestOperators.headerlessSmallMultiLineDataCsvScanOpDesc()),
      "medium CSV scan" -> alone(TestOperators.mediumCsvScanOpDesc()),
      "JSONL scan" -> alone(TestOperators.smallJSONLScanOpDesc()),
      "flattened JSONL scan" -> alone(TestOperators.mediumFlattenJSONLScanOpDesc()),
      "Python source UDF" -> alone(TestOperators.pythonSourceOpDesc(3)),
      "slow Python source UDF" -> alone(TestOperators.slowRegionSourceOpDesc(3, 0.5)),
      "keyword search" -> after(csv(), TestOperators.keywordSearchOpDesc("Region", "Asia")),
      "aggregate" -> after(
        csv(),
        TestOperators.aggregateAndGroupByDesc("Units Sold", AggregationFunction.SUM, List("Region"))
      ),
      "Python UDF" -> after(csv(), TestOperators.pythonOpDesc()),
      "hash join" -> pojo(
        List(build, probe, join),
        List(linked(build, join), linked(probe, join, toPort = 1))
      )
    )
    workflows.foreach {
      case (name, workflow) =>
        withClue(s"$name: ") {
          assertSavable(newCompiler().compile(workflow, CompilationErrorHandling.Strict))
        }
    }
  }

  it should "save and read back for a loop, and for more operators than a small set holds" in {
    val (src, start, project, end) =
      (textInputOp("0\n1"), loopStartOp(), projectOp(List("line")), loopEndOp())
    val loop = newCompiler().compile(
      pojo(List(src, start, project, end), chain(src, start, project, end)),
      CompilationErrorHandling.Strict
    )
    assert(loop.physicalPlan.get.operators.exists(_.isLoopStart))
    assert(loop.physicalPlan.get.operators.exists(_.requiresMaterializedExecution))
    assertSavable(loop)

    val ops = List(
      csvOp(TestOperators.CountrySalesSmallCsvPath),
      projectOp(List("Region", "Total Profit")),
      limitOp(10),
      filterOp(new FilterPredicate("Total Profit", ComparisonType.GREATER_THAN, "10000")),
      filterOp(new FilterPredicate("Region", ComparisonType.NOT_EQUAL_TO, "JPN")),
      limitOp(5)
    )
    val longChain =
      newCompiler().compile(pojo(ops, chain(ops: _*)), CompilationErrorHandling.Strict)
    assert(longChain.physicalPlan.get.operators.size > 4)
    assertSavable(longChain)
  }

  it should "save as the same text each time a workflow of more operators than a small set holds compiles" in {
    val ops = List(
      csvOp(TestOperators.CountrySalesSmallCsvPath),
      projectOp(List("Region", "Total Profit")),
      limitOp(10),
      filterOp(new FilterPredicate("Total Profit", ComparisonType.GREATER_THAN, "10000")),
      filterOp(new FilterPredicate("Region", ComparisonType.NOT_EQUAL_TO, "JPN")),
      limitOp(5)
    )
    // Each compile gives each operator a schema propagation function of its own, so the two
    // plans' sets hash their operators apart.
    val saves = (1 to 3).map { _ =>
      val result = newCompiler().compile(pojo(ops, chain(ops: _*)), CompilationErrorHandling.Strict)
      assert(result.physicalPlan.get.operators.size > 4)
      assertSavable(result)
    }
    assert(saves.distinct.size == 1, "two compiles of one workflow save as different text")
  }

  it should "save and read back an input port that depends on another, as the user declared it" in {
    val (left, right) =
      (csvOp(TestOperators.CountrySalesSmallCsvPath), csvOp(TestOperators.CountrySalesSmallCsvPath))
    val udf = TestOperators.pythonOpDesc()
    udf.inputPorts = List(
      PortDescription("left", "left", disallowMultiInputs = false, isDynamicPort = false, null),
      PortDescription(
        "right",
        "right",
        disallowMultiInputs = false,
        isDynamicPort = false,
        null,
        dependencies = List(0)
      )
    )
    val result = newCompiler().compile(
      pojo(List(left, right, udf), List(linked(left, udf), linked(right, udf, toPort = 1))),
      CompilationErrorHandling.Strict
    )
    val inputs = physicalOpOf(result, udf).inputPorts
    assert(inputs(PortIdentity(1))._1.dependencies == List(PortIdentity(0)))
    assertSavable(result)
  }

  // -------------------- links and ports a plan to run cannot hold --------------------

  "WorkflowCompiler" should "refuse a link given twice, as an error of the operator it goes into" in {
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val limit = limitOp(5)
    val twice = pojo(List(csv, limit), List(linked(csv, limit), linked(csv, limit)))
    val expected =
      s"The link from output port 0 of operator ${csv.operatorIdentifier.id} to input port 0 " +
        s"of operator ${limit.operatorIdentifier.id} is given more than once"

    val lenient = newCompiler().compile(twice)
    assert(lenient.physicalPlan.isEmpty)
    assert(onlyErrorOf(lenient, limit).contains(expected))
    // the rest of the plan still compiles: the operator has its schema
    assert(lenient.operatorIdToOutputSchemas(limit.operatorIdentifier).values.forall(_.isDefined))

    assert(
      onlyErrorOf(strictFailure(twice), limit) == s"java.lang.IllegalArgumentException: $expected"
    )

    // given once, it compiles to a plan that can be saved
    assertSavable(
      newCompiler().compile(
        pojo(List(csv, limit), List(linked(csv, limit))),
        CompilationErrorHandling.Strict
      )
    )
  }

  it should "refuse an input port that depends on a port its operator does not have" in {
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val udf = TestOperators.pythonOpDesc()
    // the property panel takes any number as a port to wait for
    udf.inputPorts = List(
      PortDescription(
        "in",
        "in",
        disallowMultiInputs = false,
        isDynamicPort = false,
        null,
        dependencies = List(3)
      )
    )
    val workflow = pojo(List(csv, udf), List(linked(csv, udf)))
    val expected =
      "Input port 0 of Python UDF depends on input port 3, which the operator does not have"

    assert(onlyErrorOf(newCompiler().compile(workflow), udf).contains(expected))
    assert(
      onlyErrorOf(strictFailure(workflow), udf) == s"java.lang.IllegalArgumentException: $expected"
    )
  }

  // -------------------- loop-variable references --------------------

  /** An operator as the frontend sends it: its properties, then its type, "$..." whatever the type. */
  private def parsed(json: String): LogicalOp = objectMapper.readValue(json, classOf[LogicalOp])

  private def linked(upstream: LogicalOp, downstream: LogicalOp, toPort: Int = 0): LogicalLink =
    LogicalLink(
      upstream.operatorIdentifier,
      PortIdentity(0),
      downstream.operatorIdentifier,
      PortIdentity(toPort)
    )

  private def chain(operators: LogicalOp*): List[LogicalLink] =
    operators.sliding(2).map(pair => linked(pair.head, pair.last)).toList

  private def textInputOp(text: String): TextInputSourceOpDesc = {
    val op = new TextInputSourceOpDesc()
    op.textInput = text
    op
  }

  private def loopStartOp(): LoopStartOpDesc = {
    val op = new LoopStartOpDesc()
    op.initialization = "i = 0"
    op.output = "table.iloc[i]"
    op
  }

  private def loopEndOp(): LoopEndOpDesc = {
    val op = new LoopEndOpDesc()
    op.update = "i += 1"
    op.condition = "i < len(table)"
    op
  }

  /** The class name and descString the worker builds `op`'s executor from. */
  private def executorInit(result: WorkflowCompilationResult, op: LogicalOp): (String, String) =
    result.physicalPlan.get
      .getPhysicalOpsOfLogicalOp(op.operatorIdentifier)
      .head
      .opExecInitInfo match {
      case OpExecWithClassName(className, descString) => (className, descString)
      case other                                      => fail(s"unexpected opExecInitInfo: $other")
    }

  /** The `stateReferences` sidecar a descString carries to the worker. */
  private def sidecarOf(descString: String): Map[String, String] =
    objectMapper.convertValue(
      objectMapper.readTree(descString).get("stateReferences"),
      classOf[Map[String, String]]
    )

  /** The message of the compile's only error, which must be `op`'s. */
  private def onlyErrorOf(result: WorkflowCompilationResult, op: LogicalOp): String = {
    assert(result.operatorIdToError.keySet == Set(op.operatorIdentifier))
    result.operatorIdToError(op.operatorIdentifier).message
  }

  private def line(text: String): Tuple = {
    val schema = Schema().add(new Attribute("line", AttributeType.STRING))
    Tuple.builder(schema).add(schema.getAttribute("line"), text).build()
  }

  "WorkflowCompiler" should "keep a '$AAPL' on a Filter outside every loop block the literal it is on main" in {
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val filter = parsed(
      """{"predicates":[{"attribute":"Region","condition":"=","value":"$AAPL"}],"operatorType":"Filter"}"""
    )

    val result = newCompiler().compile(
      pojo(List(csv, filter), List(linked(csv, filter)))
    )

    assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
    val (_, descString) = executorInit(result, filter)
    assert(sidecarOf(descString).isEmpty)
  }

  it should "report a typed '$n' outside every loop block, naming the property and the variable" in {
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val limit = parsed("""{"limit":"$n","operatorType":"Limit"}""")
    val plan = pojo(List(csv, limit), List(linked(csv, limit)))
    val message = "Limit refers to loop variables (/limit -> $n), but is not inside a loop block"

    val result = newCompiler().compile(plan)

    assert(result.physicalPlan.isEmpty)
    assert(onlyErrorOf(result, limit).contains(message))
    assert(
      onlyErrorOf(strictFailure(plan), limit) == s"java.lang.IllegalArgumentException: $message"
    )
  }

  it should "find a '$i' literal on a descriptor built in Scala inside a loop block" in {
    // No parse step ran: the compiler finds the whole-string '$i' in the operator's own JSON.
    val src = textInputOp("0\n1")
    val start = loopStartOp()
    val filter = filterOp(new FilterPredicate("line", ComparisonType.EQUAL_TO, "$i"))
    val end = loopEndOp()

    val result = newCompiler().compile(
      pojo(List(src, start, filter, end), chain(src, start, filter, end))
    )

    assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
    val (className, descString) = executorInit(result, filter)
    assert(sidecarOf(descString) == Map("/predicates/0/value" -> "i"))
    val exec = ExecFactory.newExecFromJavaClassName(className, descString)
    exec.open()
    exec.registerState(State(Map("i" -> 1L)))
    exec.bindStateReferences()
    assert(exec.processTuple(line("1"), 0).toList == List(line("1")))
    assert(exec.processTuple(line("$i"), 0).isEmpty)
  }

  it should "bind a frontend '$n' in Limit's Int property inside a loop block when the state arrives, end to end" in {
    // TextInput -> LoopStart -> Projection -> Limit("$n") -> LoopEnd, the Limit parsed as the
    // frontend sends it: the state reaches Limit through Projection, another operator of the block.
    val src = textInputOp("0\n1")
    val start = loopStartOp()
    val project = projectOp(List("line"))
    val limit = parsed("""{"limit":"$n","operatorType":"Limit"}""")
    val end = loopEndOp()

    val result = newCompiler().compile(
      pojo(List(src, start, project, limit, end), chain(src, start, project, limit, end))
    )

    assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
    val (className, descString) = executorInit(result, limit)
    assert(sidecarOf(descString) == Map("/limit" -> "n"))
    // Driven the way the worker drives it: Limit's own executor, opened before any state.
    val exec = ExecFactory.newExecFromJavaClassName(className, descString)
    exec.open()
    exec.registerState(State(Map("n" -> 2L)))
    exec.bindStateReferences()
    val passed = (1 to 5).flatMap(i => exec.processTuple(line(i.toString), 0))
    assert(passed.size == 2)
  }

  it should "report a reference inside a loop block on an operator whose code is generated" in {
    // Sort generates its Python from its properties before the loop runs; outside every block
    // "$USD" is the column name it is on main.
    val csv = csvOp(TestOperators.CountrySalesSmallCsvPath)
    val start = loopStartOp()
    val sortJson =
      """{"attributes":[{"attribute":"$%s","sortPreference":"ASC"}],"operatorType":"Sort"}"""
    val sort = parsed(sortJson.format("col"))
    val end = loopEndOp()

    val result = newCompiler().compile(
      pojo(List(csv, start, sort, end), chain(csv, start, sort, end))
    )

    assert(result.physicalPlan.isEmpty)
    assert(result.operatorIdToError.keySet == Set(sort.operatorIdentifier))
    assert(
      result
        .operatorIdToError(sort.operatorIdentifier)
        .message
        .contains("cannot refer to loop variables yet (/attributes/0/attribute -> $col)")
    )

    val outside = parsed(sortJson.format("USD"))
    val outsideResult = newCompiler().compile(
      pojo(List(csv, outside), List(linked(csv, outside)))
    )
    assert(
      outsideResult.operatorIdToError.isEmpty,
      s"unexpected: ${outsideResult.operatorIdToError}"
    )
  }

  /** TextInput -> LoopStart -> `op` -> LoopEnd, every input of `op` fed by the LoopStart. */
  private def insideLoopBlock(op: LogicalOp): LogicalPlanPojo = {
    val src = textInputOp("0\n1")
    val start = loopStartOp()
    val end = loopEndOp()
    val inputs = op.operatorInfo.inputPorts.map(input => linked(start, op, input.id.id))
    pojo(List(src, start, op, end), linked(src, start) :: inputs ::: List(linked(op, end)))
  }

  /**
    * A reference in each property the compiled plan is built from -- an output column's name or
    * type, or what the input is partitioned on: the operator as the frontend sends it, its name,
    * and the references the error names.
    */
  private val referencesInNoLoopVariableProperties: List[(String, String, String)] = List(
    (
      """{"isDrop":false,"attributes":[{"originalAttribute":"line","alias":"$a"}],
        |"operatorType":"Projection"}""".stripMargin,
      "Projection",
      "/attributes/0/alias -> $a"
    ),
    (
      """{"isDrop":"$d","attributes":[{"originalAttribute":"line","alias":""}],
        |"operatorType":"Projection"}""".stripMargin,
      "Projection",
      "/isDrop -> $d"
    ),
    (
      """{"Dictionary":"x","Attribute":"line","result attribute":"$r","Matching type":"Scan",
        |"operatorType":"DictionaryMatcher"}""".stripMargin,
      "Dictionary matcher",
      "/result attribute -> $r"
    ),
    (
      """{"Delimiter":",","Attribute":"line","Result attribute":"$r",
        |"operatorType":"UnnestString"}""".stripMargin,
      "Unnest String",
      "/Result attribute -> $r"
    ),
    (
      """{"aggregations":[{"aggFunction":"count","attribute":"line","result attribute":"$r"}],
        |"groupByKeys":["$g"],"operatorType":"Aggregate"}""".stripMargin,
      "Aggregate",
      "/aggregations/0/result attribute -> $r, /groupByKeys/0 -> $g"
    ),
    (
      """{"attributeName":"$c","outputFileName":"$f","operatorType":"FileScanOp"}""",
      "File Scan From Input",
      "/attributeName -> $c, /outputFileName -> $f"
    ),
    (
      """{"typeCastingUnits":[{"attribute":"$c","resultType":"integer"}],
        |"operatorType":"TypeCasting"}""".stripMargin,
      "Type Casting",
      "/typeCastingUnits/0/attribute -> $c"
    ),
    (
      """{"buildAttributeName":"$b","probeAttributeName":"$p","joinType":"inner",
        |"operatorType":"HashJoin"}""".stripMargin,
      "Hash Join",
      "/buildAttributeName -> $b, /probeAttributeName -> $p"
    ),
    (
      """{"leftAttributeName":"$l","rightAttributeName":"$r","constant":10,"includeLeftBound":true,
        |"includeRightBound":true,"operatorType":"IntervalJoin"}""".stripMargin,
      "Interval Join",
      "/leftAttributeName -> $l, /rightAttributeName -> $r"
    ),
    (
      """{"sortAttributeName":"$s","domainMin":"$lo","domainMax":"$hi",
        |"operatorType":"SortPartitions"}""".stripMargin,
      "Sort Partitions",
      "/domainMax -> $hi, /domainMin -> $lo, /sortAttributeName -> $s"
    )
  )

  it should "report a reference inside a loop block in a property the compiled plan is built from" in {
    // Built from the placeholder, the plan would never see the loop's value: a Projection alias
    // "$a" would output a column named "$a", every row null; a SortPartitions domain would stay
    // 0 to 0. Reported before the physical plan, ahead of a schema error the placeholder causes.
    referencesInNoLoopVariableProperties.foreach {
      case (json, name, references) =>
        val those = if (references.contains(", ")) "those properties" else "that property"
        val message = s"$name cannot refer to loop variables ($references): its output schema " +
          s"or partitioning is built from $those when the workflow is compiled, before the loop " +
          "runs"
        val op = parsed(json)

        val result = newCompiler().compile(insideLoopBlock(op))

        assert(result.physicalPlan.isEmpty, name)
        assert(
          result.operatorIdToError.get(op.operatorIdentifier).exists(_.message.contains(message)),
          s"$name: ${result.operatorIdToError}"
        )
        val strictOp = parsed(json)
        val strict = strictFailure(insideLoopBlock(strictOp)).operatorErrors
        assert(
          strict
            .get(strictOp.operatorIdentifier)
            .map(_.message)
            .contains(
              s"java.lang.IllegalArgumentException: $message"
            ),
          s"$name: $strict"
        )
    }
  }

  it should "accept a reference inside a loop block in a property the executor reads, on an operator the plan is built from in part" in {
    // The dictionary and the delimiter are read by the executor, after the loop state wrote them.
    Seq(
      """{"Dictionary":"$w","Attribute":"line","result attribute":"matched","Matching type":"Scan",
        |"operatorType":"DictionaryMatcher"}""".stripMargin -> Map("/Dictionary" -> "w"),
      """{"Delimiter":"$d","Attribute":"line","Result attribute":"unnested",
        |"operatorType":"UnnestString"}""".stripMargin -> Map("/Delimiter" -> "d")
    ).foreach {
      case (json, sidecar) =>
        val op = parsed(json)
        val result = newCompiler().compile(insideLoopBlock(op))
        assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
        val (_, descString) = executorInit(result, op)
        assert(sidecarOf(descString) == sidecar)
    }
  }

  it should "keep a '$a' Projection alias outside every loop block the literal column name it is on main" in {
    val src = textInputOp("0")
    val projection = parsed(referencesInNoLoopVariableProperties.head._1)

    val result = newCompiler().compile(
      pojo(List(src, projection), List(linked(src, projection)))
    )

    assert(result.operatorIdToError.isEmpty, s"unexpected errors: ${result.operatorIdToError}")
    val schema = result.operatorIdToOutputSchemas(projection.operatorIdentifier)(PortIdentity())
    assert(schema.map(_.getAttributeNames).contains(List("$a")))
  }

  private def intervalJoinOp(): LogicalOp =
    parsed(
      """{"leftAttributeName":"line","rightAttributeName":"line","constant":"$i",
        |"includeLeftBound":true,"includeRightBound":true,"operatorType":"IntervalJoin"}""".stripMargin
    )

  /**
    * TextInput -> LoopStart -> Interval Join -> LoopEnd, the join's other table from outside the
    * block: from a TextInput, or, `nested`, from the Projection of an outer block's body (outer
    * LoopStart -> Projection, and outer LoopStart -> this LoopStart; LoopEnd -> outer LoopEnd).
    */
  private def compileJoin(
      nested: Boolean,
      leftFromOutside: Boolean
  ): (LogicalOp, WorkflowCompilationResult) = {
    val (src, start, end) = (textInputOp("0\n1"), loopStartOp(), loopEndOp())
    val (outerStart, join, outerEnd) = (loopStartOp(), intervalJoinOp(), loopEndOp())
    val outside = if (nested) projectOp(List("line")) else textInputOp("0")
    val (left, right) = if (leftFromOutside) (outside, start) else (start, outside)
    val operators =
      if (!nested) List(outside, src, start, join, end)
      else List(src, outerStart, outside, start, join, end, outerEnd)
    val around =
      if (!nested) chain(src, start)
      else chain(src, outerStart, outside) ++ chain(outerStart, start) ++ chain(end, outerEnd)
    val links = around ++ List(linked(left, join), linked(right, join, 1), linked(join, end))
    (join, newCompiler().compile(pojo(operators, links)))
  }

  it should "report a reference inside a loop block, an inner one too, on an operator whose first input comes from outside it" in {
    // Its right input waits for the left one, whose tuples can arrive before this block's state.
    Seq(false, true).foreach { nested =>
      val (join, result) = compileJoin(nested, leftFromOutside = true)
      assert(
        onlyErrorOf(result, join).contains(
          "Interval Join refers to loop variables (/constant -> $i), but its input 'left table' " +
            "is fed from outside the loop block"
        ),
        s"nested = $nested"
      )
    }
  }

  it should "accept a reference inside a loop block, an inner one too, on an operator whose input from outside it waits for one from inside" in {
    Seq(false, true).foreach { nested =>
      val (join, result) = compileJoin(nested, leftFromOutside = false)
      assert(result.operatorIdToError.isEmpty, s"nested = $nested: ${result.operatorIdToError}")
      val (_, descString) = executorInit(result, join)
      assert(sidecarOf(descString) == Map("/constant" -> "i"))
    }
  }

  it should "report a reference inside a loop block on an operator whose input also has a link from outside the block" in {
    // Limit's one input takes the LoopStart's link and an outside one, whose tuples can come first.
    val outside = textInputOp("0")
    val src = textInputOp("0\n1")
    val start = loopStartOp()
    val limit = parsed("""{"limit":"$n","operatorType":"Limit"}""")
    val end = loopEndOp()

    val result = newCompiler().compile(
      pojo(
        List(outside, src, start, limit, end),
        List(linked(src, start), linked(start, limit), linked(outside, limit), linked(limit, end))
      )
    )

    assert(
      onlyErrorOf(result, limit).contains(
        "Limit refers to loop variables (/limit -> $n), but its input port 0 is fed from " +
          "outside the loop block"
      )
    )
  }

  it should "report a reference in a loop block on an operator with an input from a sibling block" in {
    // Inside the outer block, S1 -> Projection -> E1 and S2 -> Limit("$n") -> E2, and Projection
    // -> Limit: neither of Limit's links carries both S1's and S2's state.
    val src = textInputOp("0\n1")
    val outerStart = loopStartOp()
    val (first, project, firstEnd) = (loopStartOp(), projectOp(List("line")), loopEndOp())
    val (second, limit, secondEnd) =
      (loopStartOp(), parsed("""{"limit":"$n","operatorType":"Limit"}"""), loopEndOp())
    val outerEnd = loopEndOp()

    val result = newCompiler().compile(
      pojo(
        List(src, outerStart, first, project, firstEnd, second, limit, secondEnd, outerEnd),
        chain(src, outerStart, first, project, firstEnd, outerEnd) ++
          chain(outerStart, second, limit, secondEnd, outerEnd) :+ linked(project, limit)
      )
    )

    assert(
      onlyErrorOf(result, limit).contains("but its input port 0 is fed from outside the loop block")
    )
  }
}
