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

package org.apache.texera.amber.operator.udf.python

import org.apache.texera.amber.operator.udf.UiUDFParameter

import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.executor.{OpExecWithCode, JavaRuntimeCompilation}
import org.apache.texera.amber.operator.udf.java.JavaUDFOpDesc
import org.apache.texera.amber.core.storage.FileResolver
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{BoundResources, PhysicalOp}
import org.apache.texera.amber.operator.udf.r.{
  RUDFOpDesc,
  RUDFSourceOpDesc,
  RUdfUiParameterInjector
}
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.enums.{PrivilegeEnum, UserRoleEnum}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  DatasetDao,
  DatasetUserAccessDao,
  DatasetVersionDao,
  ModelDao,
  ModelVersionDao,
  UserDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  Dataset,
  DatasetUserAccess,
  DatasetVersion,
  Model,
  ModelVersion,
  User
}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import java.nio.file.{Path, Paths}

/**
  * Binds a UDF's datasets and models against real dataset and model rows, with the resolver a
  * plan made to run is given: the one scoped to the user the plan is made for.
  */
class PythonUdfUiParameterSupportSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private def userNamed(uid: Int, name: String, role: UserRoleEnum): User = {
    val user = new User
    user.setUid(uid)
    user.setName(name)
    user.setEmail(s"$name@test.com")
    user.setRole(role)
    user
  }

  // `owner` owns both private resources, `grantee` may read the dataset only, and `stranger`
  // may read neither.
  private val owner: User = userNamed(1, "owner", UserRoleEnum.ADMIN)
  private val grantee: User = userNamed(2, "grantee", UserRoleEnum.REGULAR)
  private val stranger: User = userNamed(3, "stranger", UserRoleEnum.REGULAR)

  private val dataset: Dataset = {
    val dataset = new Dataset
    dataset.setDid(1)
    dataset.setName("sales")
    dataset.setRepositoryName("dataset-1")
    dataset.setDescription("")
    dataset.setIsPublic(false)
    dataset.setOwnerUid(owner.getUid)
    dataset
  }

  private val datasetVersion: DatasetVersion = {
    val version = new DatasetVersion
    version.setDvid(1)
    version.setDid(dataset.getDid)
    version.setName("v1")
    version.setCreatorUid(owner.getUid)
    version.setVersionHash("d4t4")
    version
  }

  private val model: Model = {
    val model = new Model
    model.setMid(1)
    model.setName("iris")
    model.setRepositoryName("model-1")
    model.setDescription("")
    model.setIsPublic(false)
    model.setIsDownloadable(true)
    model.setOwnerUid(owner.getUid)
    model
  }

  private val modelVersion: ModelVersion = {
    val version = new ModelVersion
    version.setMvid(1)
    version.setMid(model.getMid)
    version.setName("v2")
    version.setCreatorUid(owner.getUid)
    version.setVersionHash("m0d3l")
    version
  }

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    val config = getDSLContext.configuration()
    val users = new UserDao(config)
    Seq(owner, grantee, stranger).foreach(users.insert(_))
    new DatasetDao(config).insert(dataset)
    new DatasetVersionDao(config).insert(datasetVersion)
    new ModelDao(config).insert(model)
    new ModelVersionDao(config).insert(modelVersion)
    val grant = new DatasetUserAccess
    grant.setDid(dataset.getDid)
    grant.setUid(grantee.getUid)
    grant.setPrivilege(PrivilegeEnum.READ)
    new DatasetUserAccessDao(config).insert(grant)
  }

  override protected def afterAll(): Unit = closeConnectionPool()

  private val code =
    """from pytexera import *
      |
      |class ProcessTupleOperator(UDFOperatorV2):
      |    def process_tuple(self, tuple_, port):
      |        yield tuple_
      |""".stripMargin

  private val datasetPath = "/dataset/owner@test.com/sales/v1"
  private val modelPath = "/model/owner@test.com/iris/v2"

  private def parameter(
      name: String,
      attributeType: AttributeType,
      inputType: String,
      value: String
  ): UiUDFParameter = {
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute(name, attributeType)
    parameter.inputType = inputType
    parameter.value = value
    parameter
  }

  private def data(value: String = datasetPath): UiUDFParameter =
    parameter("DATA", AttributeType.STRING, "dataset", value)

  private def modelParameter(value: String = modelPath): UiUDFParameter =
    parameter("MODEL", AttributeType.STRING, "model", value)

  // The root the chart passes to each computing-unit pod, which a plan made today writes against.
  private val podMountRoot = Paths.get("/mnt/texera-mounts")

  /** Binds `op` as a plan made to run for `user` does. */
  private def bindFor(user: User, op: PhysicalOp, mountRoot: Path = podMountRoot): BoundResources =
    op.resourceBinding
      .getOrElse(fail("an operator that names a dataset or model must hold a binding"))
      .bind(FileResolver.repositoryVersionResolverForUser(user.getUid), mountRoot)

  private def mounted(name: String, inputType: String, directory: String): UiUDFParameter =
    parameter(name, AttributeType.STRING, inputType, Paths.get(directory).toString)

  private def udfWith(parameters: UiUDFParameter*): PythonUDFOpDescV2 = {
    val udf = new PythonUDFOpDescV2
    udf.code = code
    udf.uiParameters = parameters.toList
    udf
  }

  private def compile(udf: PythonUDFOpDescV2): PhysicalOp =
    udf.getPhysicalOp(WorkflowIdentity(1L), ExecutionIdentity(1L))

  "A Python UDF's binding" should "hand workers the mount directory of every resource it names" in {
    val count = parameter("count", AttributeType.INTEGER, "", "7")
    val op = compile(udfWith(data(), modelParameter(), count))

    val bound = bindFor(owner, op)

    bound.mountLocators shouldBe Set("dataset-1:d4t4", "model-1:m0d3l")
    bound.opExecInitInfo shouldBe OpExecWithCode(
      PythonUdfUiParameterInjector.inject(
        code,
        List(
          mounted("DATA", "dataset", "/mnt/texera-mounts/dataset-1/d4t4"),
          mounted("MODEL", "model", "/mnt/texera-mounts/model-1/m0d3l"),
          count
        )
      ),
      "python"
    )
    // Binding gives the result; the compile-time view still names the versions.
    op.opExecInitInfo shouldBe OpExecWithCode(
      PythonUdfUiParameterInjector.inject(code, List(data(), modelParameter(), count)),
      "python"
    )
  }

  it should "write each mount directory under the root the plan is made against" in {
    val bound = bindFor(owner, compile(udfWith(data())), Paths.get("/plan/root"))

    bound.opExecInitInfo shouldBe OpExecWithCode(
      PythonUdfUiParameterInjector.inject(
        code,
        List(mounted("DATA", "dataset", "/plan/root/dataset-1/d4t4"))
      ),
      "python"
    )
  }

  it should "pin a version for a user granted read access on it" in {
    bindFor(grantee, compile(udfWith(data()))).mountLocators shouldBe Set("dataset-1:d4t4")
  }

  it should "refuse a version the plan's user cannot read, as if it did not exist" in {
    for (
      (user, parameters, refused) <- Seq(
        (stranger, Seq(data()), datasetPath),
        (stranger, Seq(modelParameter()), modelPath),
        // The grantee may read the dataset, but not the model beside it.
        (grantee, Seq(data(), modelParameter()), modelPath)
      )
    ) {
      val op = compile(udfWith(parameters: _*))
      val failure = the[FileNotFoundException] thrownBy bindFor(user, op)
      failure.getMessage should include(refused)
    }
  }

  it should "refuse a version that does not exist when the plan is made, not while editing" in {
    val op = compile(udfWith(data("/dataset/owner@test.com/sales/v9")))

    val failure = the[FileNotFoundException] thrownBy bindFor(owner, op)
    failure.getMessage should include("/dataset/owner@test.com/sales/v9")
  }

  "An R UDF's binding" should "resolve resource selections for both operators and APIs" in {
    for (source <- Seq(false, true); tuple <- Seq(false, true)) {
      val parameters = List(data(), modelParameter())
      val rCode = "function() { data.frame() }"
      val descriptor = if (source) {
        val udf = new RUDFSourceOpDesc
        udf.code = rCode
        udf.uiParameters = parameters
        udf.useTupleAPI = tuple
        udf
      } else {
        val udf = new RUDFOpDesc
        udf.code = rCode
        udf.uiParameters = parameters
        udf.useTupleAPI = tuple
        udf
      }
      val op = descriptor.getPhysicalOp(WorkflowIdentity(1L), ExecutionIdentity(1L))
      descriptor.uiParameters =
        Nil // A later edit must not change the compiled binding's parameters.
      val bound = bindFor(owner, op)
      bound.mountLocators shouldBe Set("dataset-1:d4t4", "model-1:m0d3l")
      bound.opExecInitInfo shouldBe OpExecWithCode(
        RUdfUiParameterInjector.inject(
          rCode,
          List(
            mounted("DATA", "dataset", "/mnt/texera-mounts/dataset-1/d4t4"),
            mounted("MODEL", "model", "/mnt/texera-mounts/model-1/m0d3l")
          )
        ),
        if (tuple) "r-tuple" else "r-table"
      )
      parameters.head.value shouldBe datasetPath
    }
  }

  "A Java UDF's binding" should "initialize fields with the selected resource mount directories" in {
    for (workers <- Seq(1, 2)) {
      val descriptor = new JavaUDFOpDesc
      descriptor.code = """import org.apache.texera.amber.operator.udf.java.UiParameter;
        |public class JavaUDFOpExec {
        |  @UiParameter(value="DATA", resource="dataset") public String data;
        |  @UiParameter(value="MODEL", resource="model") public String model;
        |}
        |""".stripMargin
      descriptor.workers = workers
      descriptor.uiParameters = List(data(), modelParameter())
      val op = descriptor.getPhysicalOp(WorkflowIdentity(1), ExecutionIdentity(1))
      descriptor.uiParameters = Nil
      val bound = bindFor(owner, op)
      bound.mountLocators shouldBe Set("dataset-1:d4t4", "model-1:m0d3l")
      val OpExecWithCode(code, language) = bound.opExecInitInfo: @unchecked
      language shouldBe "java"
      val cls = JavaRuntimeCompilation.compileCode(code)
      val instance = cls.getDeclaredConstructor().newInstance()
      cls.getField("data").get(instance) shouldBe Paths
        .get("/mnt/texera-mounts/dataset-1/d4t4")
        .toString
      cls.getField("model").get(instance) shouldBe Paths
        .get("/mnt/texera-mounts/model-1/m0d3l")
        .toString
    }
  }

}
