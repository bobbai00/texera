// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

package org.apache.texera

import jakarta.ws.rs.core.{HttpHeaders, MultivaluedHashMap, Response, UriInfo}
import org.apache.texera.auth.JwtAuth
import org.apache.texera.auth.util.HeaderField
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.enums.{
  PrivilegeEnum,
  UserRoleEnum,
  WorkflowComputingUnitTypeEnum
}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  UserJupyterDao,
  ComputingUnitUserAccessDao,
  UserDao,
  WorkflowComputingUnitDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  UserJupyter,
  ComputingUnitUserAccess,
  User,
  WorkflowComputingUnit
}
import org.apache.texera.service.resource.AccessControlResource
import org.mockito.Mockito._
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.BeforeAndAfterAll

import java.net.URI
import java.util

class AccessControlResourceSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val testURI: String = "http://localhost:8080/"
  // The one route a computing unit serves through the gateway.
  private val testPath: String = "/wsapi/workflow-websocket"

  // The host:port the managing service records for a computing unit when it
  // creates the pod. The access-control-service routes to this recorded URI.
  private val testRecordedUri: String =
    "computing-unit-2.compute-unit-svc.default.svc.cluster.local:8888"

  // A second, deliberately different recorded URI. Routing tests that target the
  // read-only unit assert on this value so a Host header that ignored the looked-up
  // row (or hard-coded the other unit's host) would fail.
  private val testReadOnlyRecordedUri: String =
    "computing-unit-5.compute-unit-svc.default.svc.cluster.local:9999"

  // Recorded URI of the routable unit testUser1 has no privilege on. It exists so a
  // request refused by the privilege check cannot be confused with one refused for
  // being unroutable.
  private val testNoAccessRecordedUri: String =
    "computing-unit-6.compute-unit-svc.default.svc.cluster.local:7777"

  // What the provisioner records for a user's Jupyter: scheme, authority and the base path
  // the pod serves under. Only the authority may reach Envoy as a Host header.
  private val testJupyterInternalUrl: String =
    "http://jupyter-1.jupyter-svc.texera-jupyter-pool.svc.cluster.local:8888/jupyter/1"

  private val testUser1: User = {
    val user = new User()
    user.setUid(1)
    user.setName("testuser")
    user.setEmail("test@example.com")
    user.setRole(UserRoleEnum.REGULAR)
    user
  }

  private val testUser2: User = {
    val user = new User()
    user.setUid(2)
    user.setName("testuser2")
    user.setEmail("test2@example.com")
    user.setRole(UserRoleEnum.REGULAR)
    user
  }

  private val testCU: WorkflowComputingUnit = {
    val cu = new WorkflowComputingUnit()
    cu.setUid(2)
    cu.setType(WorkflowComputingUnitTypeEnum.kubernetes)
    cu.setCuid(2)
    cu.setName("test-cu")
    cu.setUri(testRecordedUri)
    cu
  }

  // A computing unit the user can access but for which no URI was ever recorded
  // (e.g. the pod was never created). Such a unit is not routable and must be
  // refused.
  private val testCUNoUri: WorkflowComputingUnit = {
    val cu = new WorkflowComputingUnit()
    cu.setUid(2)
    cu.setType(WorkflowComputingUnitTypeEnum.kubernetes)
    cu.setCuid(3)
    cu.setName("test-cu-no-uri")
    cu
  }

  // A computing unit whose recorded URI is blank/whitespace-only — also treated
  // as "no URI recorded" and refused.
  private val testCUBlankUri: WorkflowComputingUnit = {
    val cu = new WorkflowComputingUnit()
    cu.setUid(2)
    cu.setType(WorkflowComputingUnitTypeEnum.kubernetes)
    cu.setCuid(4)
    cu.setName("test-cu-blank-uri")
    cu.setUri("   ")
    cu
  }

  // A routable computing unit on which testUser1 holds READ (not WRITE). Every other
  // fixture grants WRITE, so this is the only unit whose privilege header can tell a
  // real lookup apart from a hard-coded WRITE.
  private val testCUReadOnly: WorkflowComputingUnit = {
    val cu = new WorkflowComputingUnit()
    cu.setUid(2)
    cu.setType(WorkflowComputingUnitTypeEnum.kubernetes)
    cu.setCuid(5)
    cu.setName("test-cu-read-only")
    cu.setUri(testReadOnlyRecordedUri)
    cu
  }

  // A perfectly routable computing unit owned by testUser2 on which testUser1 is
  // granted nothing at all. It is the only fixture whose refusal can come from the
  // privilege check itself: every other refusal in this suite is produced either by
  // the unit not existing or by it having no recorded URI.
  private val testCUNoAccess: WorkflowComputingUnit = {
    val cu = new WorkflowComputingUnit()
    cu.setUid(testUser2.getUid)
    cu.setType(WorkflowComputingUnitTypeEnum.kubernetes)
    cu.setCuid(6)
    cu.setName("test-cu-no-access")
    cu.setUri(testNoAccessRecordedUri)
    cu
  }

  private var token: String = _

  // A token for the *other* user. Tests that must tell "the authenticated user" apart
  // from "user 1" need a second identity to compare against.
  private var token2: String = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    val userDao = new UserDao(getDSLContext.configuration())
    val computingUnitDao = new WorkflowComputingUnitDao(getDSLContext.configuration())
    val computingUnitOfUserDao = new ComputingUnitUserAccessDao(getDSLContext.configuration())

    // insert user, computing unit, and access privilege into the mock database
    userDao.insert(testUser1)
    userDao.insert(testUser2)
    computingUnitDao.insert(testCU)
    computingUnitDao.insert(testCUNoUri)
    computingUnitDao.insert(testCUBlankUri)
    computingUnitDao.insert(testCUReadOnly)
    // Deliberately inserted with NO computing_unit_user_access row for testUser1.
    computingUnitDao.insert(testCUNoAccess)

    // Grant testUser1 WRITE access to every test computing unit so the routing
    // logic (not the access check) is what each routing test exercises.
    Seq(testCU, testCUNoUri, testCUBlankUri).foreach { cu =>
      val cuAccess = new ComputingUnitUserAccess()
      cuAccess.setUid(testUser1.getUid)
      cuAccess.setCuid(cu.getCuid)
      cuAccess.setPrivilege(PrivilegeEnum.WRITE)
      computingUnitOfUserDao.insert(cuAccess)
    }

    val readOnlyAccess = new ComputingUnitUserAccess()
    readOnlyAccess.setUid(testUser1.getUid)
    readOnlyAccess.setCuid(testCUReadOnly.getCuid)
    readOnlyAccess.setPrivilege(PrivilegeEnum.READ)
    computingUnitOfUserDao.insert(readOnlyAccess)

    // Per-user Jupyter: user 1 has one registered, user 2 deliberately does not.
    val jupyterDao = new UserJupyterDao(getDSLContext.configuration())
    val jupyter = new UserJupyter()
    jupyter.setUid(testUser1.getUid)
    jupyter.setInternalUrl(testJupyterInternalUrl)
    jupyter.setPublicUrl("https://texera.example.com/jupyter/1")
    jupyterDao.insert(jupyter)

    token = JwtAuth.jwtToken(JwtAuth.jwtClaims(testUser1))
    token2 = JwtAuth.jwtToken(JwtAuth.jwtClaims(testUser2))
  }

  override protected def afterAll(): Unit = {
    closeConnectionPool()
  }

  "AccessControlResource" should "return FORBIDDEN for a GET request without a token" in {
    val mockUriInfo = mock(classOf[UriInfo])
    val mockHttpHeaders = mock(classOf[HttpHeaders])
    val queryParams = new MultivaluedHashMap[String, String]()
    queryParams.add("cuid", "1")
    val requestHeaders = new MultivaluedHashMap[String, String]()

    when(mockUriInfo.getQueryParameters).thenReturn(queryParams)
    when(mockUriInfo.getRequestUri).thenReturn(new URI(testURI))
    when(mockUriInfo.getPath).thenReturn(testPath)
    when(mockHttpHeaders.getRequestHeaders).thenReturn(requestHeaders)
    when(mockHttpHeaders.getRequestHeader("Authorization")).thenReturn(new util.ArrayList[String]())

    val accessControlResource = new AccessControlResource()
    val response = accessControlResource.authorizeGet(mockUriInfo, mockHttpHeaders)

    response.getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  it should "return FORBIDDEN for a GET request with a non-integer cuid" in {
    val mockUriInfo = mock(classOf[UriInfo])
    val mockHttpHeaders = mock(classOf[HttpHeaders])
    val queryParams = new MultivaluedHashMap[String, String]()
    queryParams.add("cuid", "abc")
    val requestHeaders = new MultivaluedHashMap[String, String]()
    requestHeaders.add("Authorization", "Bearer dummy-token")

    when(mockUriInfo.getQueryParameters).thenReturn(queryParams)
    when(mockUriInfo.getRequestUri).thenReturn(new URI(testURI))
    when(mockUriInfo.getPath).thenReturn(testPath)
    when(mockHttpHeaders.getRequestHeaders).thenReturn(requestHeaders)
    when(mockHttpHeaders.getRequestHeader("Authorization"))
      .thenReturn(util.Arrays.asList("Bearer dummy-token"))

    val accessControlResource = new AccessControlResource()
    val response = accessControlResource.authorizeGet(mockUriInfo, mockHttpHeaders)

    response.getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  it should "return FORBIDDEN for a POST request without a token" in {
    val mockUriInfo = mock(classOf[UriInfo])
    val mockHttpHeaders = mock(classOf[HttpHeaders])
    val queryParams = new MultivaluedHashMap[String, String]()
    queryParams.add("cuid", "1")
    val requestHeaders = new MultivaluedHashMap[String, String]()

    when(mockUriInfo.getQueryParameters).thenReturn(queryParams)
    when(mockUriInfo.getRequestUri).thenReturn(new URI(testURI))
    when(mockUriInfo.getPath).thenReturn(testPath)
    when(mockHttpHeaders.getRequestHeaders).thenReturn(requestHeaders)
    when(mockHttpHeaders.getRequestHeader("Authorization")).thenReturn(new util.ArrayList[String]())

    val accessControlResource = new AccessControlResource()
    val response = accessControlResource.authorizePost(mockUriInfo, mockHttpHeaders)

    response.getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  "AccessControlResource" should "return FORBIDDEN for an unknown computing unit" in {
    // Mock the request context
    val mockUriInfo = mock(classOf[UriInfo])
    val mockHttpHeaders = mock(classOf[HttpHeaders])

    // cuid 1 is not in the fixture DB at all, so this exercises the "no such unit"
    // path. The privilege check itself is exercised by the no-privilege test below,
    // which uses a unit that exists and is routable.
    val queryParams = new MultivaluedHashMap[String, String]()
    queryParams.add("cuid", "1")

    // Prepare request headers with the generated JWT
    val requestHeaders = new MultivaluedHashMap[String, String]()
    requestHeaders.add("Authorization", "Bearer " + token)

    // Stub the mock objects to return the prepared data
    when(mockUriInfo.getQueryParameters).thenReturn(queryParams)
    when(mockUriInfo.getRequestUri).thenReturn(new URI(testURI))
    when(mockUriInfo.getPath).thenReturn(testPath)
    when(mockHttpHeaders.getRequestHeaders).thenReturn(requestHeaders)
    when(mockHttpHeaders.getRequestHeader("Authorization"))
      .thenReturn(util.Arrays.asList("Bearer " + token))

    // Instantiate the resource and call the method under test
    val accessControlResource = new AccessControlResource()
    val response = accessControlResource.authorizeGet(mockUriInfo, mockHttpHeaders)

    // Assert that the response status is FORBIDDEN
    response.getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  it should "return OK and correct headers when user has access" in {
    // Mock the request context
    val mockUriInfo = mock(classOf[UriInfo])
    val mockHttpHeaders = mock(classOf[HttpHeaders])

    // Prepare query parameters with a computing unit ID the user HAS access to
    val queryParams = new MultivaluedHashMap[String, String]()
    queryParams.add("cuid", testCU.getCuid.toString)

    // Prepare request headers with the generated JWT
    val requestHeaders = new MultivaluedHashMap[String, String]()
    requestHeaders.add("Authorization", "Bearer " + token)

    // Stub the mock objects to return the prepared data
    when(mockUriInfo.getQueryParameters).thenReturn(queryParams)
    when(mockUriInfo.getRequestUri).thenReturn(new URI(testURI))
    when(mockUriInfo.getPath).thenReturn(testPath)
    when(mockHttpHeaders.getRequestHeaders).thenReturn(requestHeaders)
    when(mockHttpHeaders.getRequestHeader("Authorization"))
      .thenReturn(util.Arrays.asList("Bearer " + token))

    // Instantiate the resource and call the method under test
    val accessControlResource = new AccessControlResource()
    val response = accessControlResource.authorizeGet(mockUriInfo, mockHttpHeaders)

    // Assert that the response status is OK and headers are correct
    response.getStatus shouldBe Response.Status.OK.getStatusCode
    response.getHeaderString(
      HeaderField.UserComputingUnitAccess
    ) shouldBe PrivilegeEnum.WRITE.toString
    response.getHeaderString(HeaderField.UserId) shouldBe testUser1.getUid.toString
    response.getHeaderString(HeaderField.UserName) shouldBe testUser1.getName
    response.getHeaderString(HeaderField.UserEmail) shouldBe testUser1.getEmail
    // Envoy routes by the rewritten Host header, which must be the URI recorded
    // for the computing unit.
    response.getHeaderString("Host") shouldBe testRecordedUri
  }

  it should "return FORBIDDEN when the user has no privilege on a routable computing unit" in {
    // testCUNoAccess exists, is owned by testUser2, and has a recorded URI — so the
    // routing check would happily let this through. The only thing that can refuse it
    // is the PrivilegeEnum.NONE guard.
    val (uri, headers) = mockRequest(testPath, Some(testCUNoAccess.getCuid.toString))
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  it should "refuse the connection when no URI is recorded for the computing unit" in {
    val (uri, headers) = mockRequest(testPath, Some(testCUNoUri.getCuid.toString))
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  it should "refuse the connection when the recorded URI is blank" in {
    val (uri, headers) = mockRequest(testPath, Some(testCUBlankUri.getCuid.toString))
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  /**
    * Builds a mocked request context.
    *
    * @param authorizationHeader `None` models a client that sent no Authorization
    *                            header at all — JAX-RS returns `null` from
    *                            `getRequestHeader` in that case.
    * @param accessTokenQueryParam value for the `access-token` query parameter, when
    *                              the token travels in the URL instead.
    */
  private def mockRequest(
      path: String,
      cuidQueryParam: Option[String],
      authorizationHeader: Option[String] = Some("Bearer " + token),
      accessTokenQueryParam: Option[String] = None
  ): (UriInfo, HttpHeaders) = {
    val mockUriInfo = mock(classOf[UriInfo])
    val mockHttpHeaders = mock(classOf[HttpHeaders])

    val queryParams = new MultivaluedHashMap[String, String]()
    cuidQueryParam.foreach(queryParams.add("cuid", _))
    accessTokenQueryParam.foreach(queryParams.add("access-token", _))

    val requestHeaders = new MultivaluedHashMap[String, String]()

    when(mockUriInfo.getQueryParameters).thenReturn(queryParams)
    when(mockUriInfo.getRequestUri).thenReturn(new URI(testURI))
    when(mockUriInfo.getPath).thenReturn(path)

    authorizationHeader match {
      case Some(header) =>
        requestHeaders.add("Authorization", header)
        when(mockHttpHeaders.getRequestHeader("Authorization"))
          .thenReturn(util.Arrays.asList(header))
      case None =>
        // JAX-RS hands back null for a header the client never sent.
        when(mockHttpHeaders.getRequestHeader("Authorization"))
          .thenReturn(null.asInstanceOf[util.List[String]])
    }
    when(mockHttpHeaders.getRequestHeaders).thenReturn(requestHeaders)

    (mockUriInfo, mockHttpHeaders)
  }

  // The form Jersey actually hands to the resource: UriInfo.getPath returns the path relative to
  // the base URI, so a check for /auth/wsapi/... arrives as "auth/wsapi/..." — no leading slash,
  // and with the "auth/" segment still attached.
  it should "return OK for the gateway-relative form of the computing unit route" in {
    val (uri, headers) =
      mockRequest("auth/wsapi/workflow-websocket", Some(testCU.getCuid.toString))
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.OK.getStatusCode
    response.getHeaderString("Host") shouldBe testRecordedUri
  }

  // An execution's statistics and exports are read from what it stored, by the Dashboard
  // service: routed to a unit, they would be answered only while that unit lives.
  it should "not authorize an execution's statistics or exports as routes of a computing unit" in {
    for (
      path <- Seq(
        "/api/executions/1/stats/1",
        "auth/api/executions/1/stats/1",
        "/api/executions/result/export",
        "/api/executions/result/export/dataset",
        "auth/api/executions/result/export/local"
      )
    ) withClue(path) {
      // A user with WRITE on a routable unit, named as every unit route names it.
      val (uri, headers) = mockRequest(path, Some(testCU.getCuid.toString))
      val resource = new AccessControlResource()

      Seq(resource.authorizeGet(uri, headers), resource.authorizePost(uri, headers)).foreach {
        response =>
          response.getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
          response.getHeaderString("Host") shouldBe null
      }
    }
  }

  it should "return FORBIDDEN for a request that names no computing unit" in {
    // Envoy forwards `?cuid=` verbatim when the client sends the parameter with no value.
    for (cuid <- Seq(None, Some(""))) withClue(cuid) {
      val (uri, headers) = mockRequest(testPath, cuid)
      val response = new AccessControlResource().authorizeGet(uri, headers)

      response.getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
    }
  }

  it should "return FORBIDDEN for a path it has no rule for, whatever access the user has" in {
    // Among them the Python environment paths, which no computing unit serves.
    for (path <- Seq("/random/garbage", "/pve/system", s"/pve/pves/${testCU.getCuid}"))
      withClue(path) {
        val (uri, headers) = mockRequest(path, Some(testCU.getCuid.toString))
        val response = new AccessControlResource().authorizeGet(uri, headers)

        response.getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
      }
  }

  it should "report the privilege and the recorded URI of the requested computing unit" in {
    val (uri, headers) = mockRequest(testPath, Some(testCUReadOnly.getCuid.toString))
    val response = new AccessControlResource().authorizeGet(uri, headers)

    // testUser1 holds READ (not WRITE) on this unit, and this unit's recorded URI
    // differs from every other fixture's, so both headers are answered from the
    // row actually looked up rather than from a constant.
    response.getStatus shouldBe Response.Status.OK.getStatusCode
    response.getHeaderString(
      HeaderField.UserComputingUnitAccess
    ) shouldBe PrivilegeEnum.READ.toString
    response.getHeaderString("Host") shouldBe testReadOnlyRecordedUri
  }

  it should "resolve the privilege and identity of the authenticated user, not a fixed one" in {
    // testUser2 owns testCUReadOnly, so the owner branch of the lookup gives it WRITE,
    // while testUser1 — the identity every other test authenticates as — only holds
    // READ on that same unit. Answering for the wrong user is therefore visible in
    // both the privilege header and the forwarded identity headers.
    val (uri, headers) = mockRequest(
      testPath,
      Some(testCUReadOnly.getCuid.toString),
      authorizationHeader = Some("Bearer " + token2)
    )
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.OK.getStatusCode
    response.getHeaderString(
      HeaderField.UserComputingUnitAccess
    ) shouldBe PrivilegeEnum.WRITE.toString
    response.getHeaderString(HeaderField.UserId) shouldBe testUser2.getUid.toString
    response.getHeaderString(HeaderField.UserName) shouldBe testUser2.getName
    response.getHeaderString(HeaderField.UserEmail) shouldBe testUser2.getEmail
  }

  it should "authorize the /wsapi/workflow-websocket route using the access-token query parameter" in {
    // The Authorization header carries a token that cannot be parsed, so a 200 is
    // only reachable if the access-token query parameter is read AND preferred.
    val (uri, headers) = mockRequest(
      "/wsapi/workflow-websocket",
      Some(testCU.getCuid.toString),
      authorizationHeader = Some("Bearer not-a-real-jwt"),
      accessTokenQueryParam = Some(token)
    )
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.OK.getStatusCode
    response.getHeaderString("Host") shouldBe testRecordedUri
  }

  it should "ignore an empty access-token query parameter and fall back to the Authorization header" in {
    val (uri, headers) = mockRequest(
      testPath,
      Some(testCU.getCuid.toString),
      accessTokenQueryParam = Some("")
    )
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.OK.getStatusCode
  }

  it should "accept a lower-case bearer scheme" in {
    // RFC 7235 makes the auth scheme case-insensitive, so a client sending "bearer"
    // must not be turned away.
    val (uri, headers) = mockRequest(
      testPath,
      Some(testCU.getCuid.toString),
      authorizationHeader = Some("bearer " + token)
    )
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.OK.getStatusCode
    response.getHeaderString("Host") shouldBe testRecordedUri
  }

  it should "accept an Authorization value that is a padded bare token" in {
    // The scheme is stripped only if present, so a client that sends the raw token is
    // still understood — and the surrounding whitespace has to be removed before the
    // JWT parser sees it. (Padding after a "Bearer " scheme would prove nothing: the
    // strip regex already eats the leading whitespace, and jose4j ignores trailing
    // whitespace because it lands in the base64url signature segment. Only a
    // scheme-less value can carry *leading* whitespace this far, and leading
    // whitespace corrupts the signing input.)
    val (uri, headers) = mockRequest(
      testPath,
      Some(testCU.getCuid.toString),
      authorizationHeader = Some("  " + token + "  ")
    )
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.OK.getStatusCode
    response.getHeaderString("Host") shouldBe testRecordedUri
  }

  it should "take no request body: a unit route's token is in its URL or its headers" in {
    // The browser's export form carried its token in its body, and no unit route does.
    val routes = Set("authorizeGet", "authorizePost", "authorizePut", "authorizeDelete")
    val handlers = classOf[AccessControlResource].getMethods.filter(m => routes(m.getName))

    handlers.map(_.getName).toSet shouldBe routes
    handlers.foreach { handler =>
      withClue(handler.getName) {
        handler.getParameterTypes.toSeq shouldBe Seq(classOf[UriInfo], classOf[HttpHeaders])
      }
    }
  }

  it should "refuse an Authorization header that is a bare bearer scheme" in {
    val (uri, headers) = mockRequest(
      testPath,
      Some(testCU.getCuid.toString),
      authorizationHeader = Some("Bearer ")
    )

    new AccessControlResource().authorizeGet(uri, headers).getStatus shouldBe
      Response.Status.FORBIDDEN.getStatusCode
  }

  // -- per-user JupyterLab routing --------------------------------------------

  it should "route a Jupyter request to the pod recorded for the uid in the path" in {
    val (uri, headers) = mockRequest("/jupyter/1/notebooks/work/notebook.ipynb", None)
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.OK.getStatusCode
    // The scheme and base path are stripped: Envoy routes on an authority alone.
    response.getHeaderString("Host") shouldBe
      "jupyter-1.jupyter-svc.texera-jupyter-pool.svc.cluster.local:8888"
  }

  it should "route Jupyter's own subrequests, which carry no token" in {
    // The iframe's asset and API calls cannot present Texera credentials, so routing has to
    // work without one. The per-user Jupyter token is what authorizes them.
    val (uri, headers) =
      mockRequest("/jupyter/1/api/contents", None, authorizationHeader = None)
    val response = new AccessControlResource().authorizeGet(uri, headers)

    response.getStatus shouldBe Response.Status.OK.getStatusCode
    response.getHeaderString("Host") should startWith("jupyter-1.")
  }

  it should "route what Jupyter saves and deletes, sent as PUT and DELETE, like what it reads" in {
    val (uri, headers) =
      mockRequest("/jupyter/1/api/contents/work/notebook.ipynb", None, authorizationHeader = None)
    val resource = new AccessControlResource()

    val saved = resource.authorizePut(uri, headers)
    val deleted = resource.authorizeDelete(uri, headers)

    saved.getStatus shouldBe Response.Status.OK.getStatusCode
    saved.getHeaderString("Host") should startWith("jupyter-1.")
    deleted.getStatus shouldBe Response.Status.OK.getStatusCode
    deleted.getHeaderString("Host") should startWith("jupyter-1.")
  }

  it should "refuse a Jupyter request for a user with none registered" in {
    val (uri, headers) = mockRequest("/jupyter/2/tree", None)
    new AccessControlResource()
      .authorizeGet(uri, headers)
      .getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  it should "refuse a Jupyter request for a uid that does not exist" in {
    val (uri, headers) = mockRequest("/jupyter/999999/tree", None)
    new AccessControlResource()
      .authorizeGet(uri, headers)
      .getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  it should "not treat a Jupyter path without a uid as routable" in {
    // Falls through to the catch-all, which denies.
    val (uri, headers) = mockRequest("/jupyter/tree", None)
    new AccessControlResource()
      .authorizeGet(uri, headers)
      .getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  it should "route the gateway-relative form of a Jupyter path" in {
    val (uri, headers) = mockRequest("auth/jupyter/1/tree", None)
    new AccessControlResource()
      .authorizeGet(uri, headers)
      .getStatus shouldBe Response.Status.OK.getStatusCode
  }

  it should "refuse a Jupyter uid too large to be a user id" in {
    // The path regex accepts any run of digits, so the conversion to Int has to be caught
    // rather than allowed out as a 500.
    val (uri, headers) = mockRequest("/jupyter/9999999999/tree", None)
    new AccessControlResource()
      .authorizeGet(uri, headers)
      .getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
  }

  // Registers an address for testUser2, who otherwise has none, for the rows that should be
  // refused rather than routed.
  private def withRecordedJupyter(internalUrl: String)(check: => Unit): Unit = {
    val jupyterDao = new UserJupyterDao(getDSLContext.configuration())
    val row = new UserJupyter()
    row.setUid(testUser2.getUid)
    row.setInternalUrl(internalUrl)
    row.setPublicUrl(internalUrl)
    jupyterDao.insert(row)
    try check
    finally jupyterDao.deleteById(testUser2.getUid)
  }

  it should "refuse a Jupyter request whose recorded address has no authority" in {
    // Parses cleanly but yields a null authority, which must not become a Host header of
    // "null" for Envoy to route on.
    withRecordedJupyter("jupyter-2-with-no-scheme:8888") {
      val (uri, headers) = mockRequest(s"/jupyter/${testUser2.getUid}/tree", None)
      new AccessControlResource()
        .authorizeGet(uri, headers)
        .getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
    }
  }

  it should "build the uid regex from the configured base path" in {
    val custom = AccessControlResource.jupyterPathRegex("/lab/notebooks")
    "/lab/notebooks/7/tree" should fullyMatch regex custom
    "auth/lab/notebooks/7" should fullyMatch regex custom
    "/jupyter/7/tree" should not(fullyMatch regex custom)
  }

  it should "tolerate a base path written with surrounding slashes" in {
    val slashed = AccessControlResource.jupyterPathRegex("/jupyter/")
    "/jupyter/7/tree" should fullyMatch regex slashed
  }

  it should "treat the base path as a path, not a pattern" in {
    // Unquoted, the dot would match any character and route /axb to the /a.b pool.
    val dotted = AccessControlResource.jupyterPathRegex("/a.b")
    "/a.b/7" should fullyMatch regex dotted
    "/axb/7" should not(fullyMatch regex dotted)
  }

  it should "refuse a Jupyter request whose recorded address will not parse" in {
    // A stray escape throws from the URI constructor. That parse sits inside the same guard
    // as the lookup, so this is denied like any other unusable row instead of raising a 500.
    withRecordedJupyter("http://jupyter-2:8888/%zz") {
      val (uri, headers) = mockRequest(s"/jupyter/${testUser2.getUid}/tree", None)
      new AccessControlResource()
        .authorizeGet(uri, headers)
        .getStatus shouldBe Response.Status.FORBIDDEN.getStatusCode
    }
  }
}
