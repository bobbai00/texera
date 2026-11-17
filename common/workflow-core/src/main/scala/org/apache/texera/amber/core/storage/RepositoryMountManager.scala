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

import com.fasterxml.jackson.databind.ObjectMapper
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.workflow.RepositoryMounts
import org.apache.texera.common.config.EnvironmentalVariable

import java.net.{HttpURLConnection, URI}
import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path, Paths}
import scala.io.Source
import scala.util.{Try, Using}

/**
  * Makes a versioned LakeFS repository readable inside this computing unit's pod.
  *
  * The mount is not performed here — this pod runs user code and is unprivileged. It asks the
  * mount authority, presenting the pod's own user JWT, and the mount reaches this pod through
  * Kubernetes mount propagation.
  *
  * A repository is addressed by a locator "<repositoryName>:<commitHash>". A commit is
  * immutable, so one mount serves every worker and execution for the life of the pod.
  */
class RepositoryMountManager(
    env: String => Option[String],
    post: (String, String, String) => Unit,
    isMounted: Path => Boolean,
    mountTimeoutMs: Long
) extends LazyLogging {

  private val mapper = new ObjectMapper()

  /**
    * The directory this computing unit mounts repositories under, or None when it can mount
    * none. A plan made here writes its code against it.
    */
  def mountRoot: Option[Path] =
    env(EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT)
      .map(_.trim)
      .filter(_.nonEmpty)
      .map(Paths.get(_))

  private def inPodMountRoot: Path =
    mountRoot.getOrElse(
      throw new IllegalStateException(
        s"${EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT} is not set in this computing unit."
      )
    )

  /** Where `locator` is, or will be, readable in this pod. */
  private def mountPointOf(locator: String): Path =
    RepositoryMountManager.mountPoint(inPodMountRoot, locator)

  /**
    * Mount every repository an operator's code reads, deduplicated, in one place rather than
    * once per worker — after checking that the code expects the mounts where this pod puts them
    * (see [[RepositoryMountManager.requireMountableUnder]]).
    *
    * Warning: a FUSE mount is visible only in the mount namespace of the process that receives
    * it, which is fine while a region's controller and workers share one pod. Were workers ever
    * to become separate pods, this step — and only this step — would have to be dispatched to
    * each of them.
    *
    * @param mounts the repositories to mount, and the root the operators' code reads them under
    * @throws IllegalStateException if this pod mounts no repository, or mounts them under another
    *                               root than the code reads them under
    */
  def ensureAllMounted(mounts: RepositoryMounts): Unit = {
    RepositoryMountManager.requireMountableUnder(mounts, mountRoot)
    mounts.locators.foreach(ensureMounted)
  }

  /** Mount `locator` if it is not already mounted, and return its in-pod path. */
  def ensureMounted(locator: String): Path =
    synchronized {
      val (repository, commit) = RepositoryMounts.parseLocator(locator)
      val mountPoint = mountPointOf(locator)

      if (isMounted(mountPoint)) {
        logger.info(s"$locator is already mounted at $mountPoint")
        return mountPoint
      }

      val Seq(accessControlService, cuid, jwt) = Seq(
        EnvironmentalVariable.ENV_ACCESS_CONTROL_SERVICE_URL,
        EnvironmentalVariable.ENV_CU_ID,
        EnvironmentalVariable.ENV_USER_JWT_TOKEN
      ).map(name =>
        env(name).map(_.trim).filter(_.nonEmpty).getOrElse {
          throw new IllegalStateException(s"$name is not set in this computing unit.")
        }
      )

      val body = mapper.createObjectNode()
      body.put("repositoryName", repository)
      body.put("commitHash", commit)
      logger.info(s"requesting a mount of $locator for computing unit $cuid")
      post(s"$accessControlService/api/mounts/$cuid", body.toString, jwt)

      // A successful response is not yet a readable directory: GeeseFS is daemonized, and the
      // mount still has to propagate in.
      val deadline = System.currentTimeMillis() + mountTimeoutMs
      while (!isMounted(mountPoint)) {
        if (System.currentTimeMillis() > deadline) {
          throw new RuntimeException(
            s"$locator did not appear as a mount at $mountPoint within ${mountTimeoutMs}ms."
          )
        }
        Thread.sleep(200)
      }
      logger.info(s"$locator mounted at $mountPoint")
      mountPoint
    }
}

object RepositoryMountManager
    extends RepositoryMountManager(
      name => sys.env.get(name),
      InPodMount.postJson,
      InPodMount.isFuseMounted,
      35000
    ) {

  /**
    * Where `locator` is, or will be, readable on a computing unit that mounts repositories under
    * `root`. Pure: it neither mounts nor checks anything, because a plan writes this path into an
    * operator's code long before the mount happens.
    *
    * @throws IllegalArgumentException if `locator` is not "<repositoryName>:<commitHash>"
    */
  def mountPoint(root: Path, locator: String): Path = {
    val (repository, commit) = RepositoryMounts.parseLocator(locator)
    root.resolve(repository).resolve(commit)
  }

  /**
    * Fails unless code that reads `mounts` under their root finds them on a computing unit that
    * mounts repositories under `unitRoot`. The code was written when its plan was made, so a unit
    * with another root would hand the operator directories that never appear. Two spellings of
    * one directory are the same root.
    *
    * @throws IllegalStateException if the unit mounts no repository, or mounts them elsewhere
    */
  def requireMountableUnder(mounts: RepositoryMounts, unitRoot: Option[Path]): Unit = {
    val expected = Paths.get(mounts.root).normalize()
    val root = unitRoot
      .map(_.normalize())
      .getOrElse(
        throw new IllegalStateException(
          s"${EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT} is not set in this computing unit, " +
            s"so it cannot mount ${mounts.locators.toSeq.sorted.mkString(", ")}."
        )
      )
    if (root != expected) {
      throw new IllegalStateException(
        s"The plan's code reads its datasets and models under $expected, but this computing " +
          s"unit mounts them under $root (${EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT})."
      )
    }
  }
}

private[amber] object InPodMount {

  def postJson(url: String, body: String, jwt: String): Unit = {
    val connection = URI.create(url).toURL.openConnection().asInstanceOf[HttpURLConnection]
    connection.setRequestMethod("POST")
    connection.setRequestProperty("Content-Type", "application/json")
    connection.setRequestProperty("Authorization", s"Bearer $jwt")
    connection.setDoOutput(true)
    connection.setConnectTimeout(10000)
    connection.setReadTimeout(40000)
    try {
      Using(connection.getOutputStream)(_.write(body.getBytes(StandardCharsets.UTF_8)))
      val code = connection.getResponseCode
      if (code < 200 || code >= 300) {
        val error = Option(connection.getErrorStream)
          .map(stream => new String(stream.readAllBytes(), StandardCharsets.UTF_8))
          .getOrElse("")
        throw new RuntimeException(s"the mount request was refused: HTTP $code $error")
      }
    } finally {
      connection.disconnect()
    }
  }

  /**
    * True if a live FUSE mount is at `mountPoint`.
    *
    * Being listed is not enough. A mount whose GeeseFS process has died keeps its entry, and
    * the kernel can still answer stat() from attributes it cached, but every read fails with
    * "Transport endpoint is not connected". Counted as mounted, it would never be requested
    * again -- and the mounter, which replaces a dead mount when asked, would never be asked.
    */
  def isFuseMounted(mountPoint: Path): Boolean =
    isListedAsFuse(mountPoint) && responds(mountPoint)

  // /proc/mounts is the kernel's read-only view of this pod's mount table: the kernel adds the
  // entry when a propagated GeeseFS mount arrives and removes it on unmount, so nothing writes it.
  private def isListedAsFuse(mountPoint: Path): Boolean = {
    if (!Files.exists(mountPoint)) {
      return false
    }
    val target = mountPoint.toAbsolutePath.toString
    Using(Source.fromFile("/proc/mounts")) { source =>
      source.getLines().exists { line =>
        val fields = line.split(" ")
        fields.length > 2 && fields(1) == target && fields(2).startsWith("fuse")
      }
    }.getOrElse(false)
  }

  /** True if `directory` can be listed, which a dead FUSE mount cannot. */
  def responds(directory: Path): Boolean =
    Try(Using.resource(Files.newDirectoryStream(directory))(_.iterator().hasNext)).isSuccess
}
