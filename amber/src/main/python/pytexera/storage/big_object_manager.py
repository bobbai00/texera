# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""BigObjectManager for reading large objects from S3."""

import time
import uuid
from typing import BinaryIO, Union, Optional
from io import BytesIO
from datetime import datetime
from core.models.schema.big_object_pointer import BigObjectPointer
from core.storage.storage_config import StorageConfig
from core.architecture.managers.execution_context import ExecutionContext


class BigObjectStream:
    """Stream for reading big objects (matches Scala/R BigObjectStream)."""

    def __init__(self, body: BinaryIO, pointer: BigObjectPointer):
        self._body = body
        self._pointer = pointer
        self._closed = False

    def read(self, n: int = -1) -> bytes:
        """Read n bytes from stream (-1 = read all)."""
        if self._closed:
            raise ValueError("I/O operation on closed stream")
        if n == -1:
            return self._body.read()
        return self._body.read(n)

    def close(self):
        """Close the stream."""
        if not self._closed:
            self._closed = True
            self._body.close()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - automatically cleanup."""
        self.close()
        return False


class BigObjectManager:
    """Manager for reading big objects from S3."""

    _s3_client = None
    _db_connection = None
    DEFAULT_BUCKET = "texera-big-objects"

    @classmethod
    def _get_s3_client(cls):
        """Initialize S3 client (lazy, cached)."""
        if cls._s3_client is None:
            try:
                import boto3
                from botocore.config import Config

                cls._s3_client = boto3.client(
                    "s3",
                    endpoint_url=StorageConfig.S3_ENDPOINT,
                    aws_access_key_id=StorageConfig.S3_AUTH_USERNAME,
                    aws_secret_access_key=StorageConfig.S3_AUTH_PASSWORD,
                    region_name=StorageConfig.S3_REGION,
                    config=Config(
                        signature_version="s3v4", s3={"addressing_style": "path"}
                    ),
                )
            except ImportError:
                raise RuntimeError("boto3 required. Install with: pip install boto3")
            except Exception as e:
                raise RuntimeError(f"Failed to initialize S3 client: {e}")

        return cls._s3_client

    @classmethod
    def _get_db_connection(cls):
        """Get database connection for registering big objects."""
        if cls._db_connection is None:
            try:
                import psycopg2

                # Parse JDBC URL to extract host, port, database, and schema
                # Format: jdbc:postgresql://host:port/database?currentSchema=texera_db,public
                jdbc_url = StorageConfig.JDBC_URL
                if jdbc_url.startswith("jdbc:postgresql://"):
                    url_part = jdbc_url.replace("jdbc:postgresql://", "")
                    # Split by '?' to separate params
                    url_parts = url_part.split("?")
                    url_without_params = url_parts[0]

                    # Parse schema from params (e.g., currentSchema=texera_db,public)
                    schema = "texera_db"  # default
                    if len(url_parts) > 1:
                        params = url_parts[1]
                        for param in params.split("&"):
                            if param.startswith("currentSchema="):
                                schema_value = param.split("=")[1]
                                # Take first schema from comma-separated list
                                schema = schema_value.split(",")[0]

                    # Split by '/' to get host:port and database
                    parts = url_without_params.split("/")
                    host_port = parts[0]
                    database = parts[1] if len(parts) > 1 else "texera_db"

                    # Split host and port
                    if ":" in host_port:
                        host, port = host_port.split(":")
                        port = int(port)
                    else:
                        host = host_port
                        port = 5432

                    # Connect and set search_path
                    cls._db_connection = psycopg2.connect(
                        host=host,
                        port=port,
                        user=StorageConfig.JDBC_USERNAME,
                        password=StorageConfig.JDBC_PASSWORD,
                        database=database,
                        options=f"-c search_path={schema},public",
                    )
                else:
                    raise ValueError(f"Invalid JDBC URL format: {jdbc_url}")
            except ImportError:
                raise RuntimeError(
                    "psycopg2 required. Install with: pip install psycopg2-binary"
                )
            except Exception as e:
                raise RuntimeError(f"Failed to connect to database: {e}")
        return cls._db_connection

    @classmethod
    def _create_bucket_if_not_exist(cls, bucket: str):
        """Create S3 bucket if it doesn't exist."""
        s3 = cls._get_s3_client()
        try:
            s3.head_bucket(Bucket=bucket)
        except:
            # Bucket doesn't exist, create it
            try:
                s3.create_bucket(Bucket=bucket)
            except Exception as e:
                raise RuntimeError(f"Failed to create bucket {bucket}: {e}")

    @classmethod
    def create(cls, data: Union[bytes, BinaryIO]) -> BigObjectPointer:
        """
        Creates a big object from bytes or stream, uploads to S3, and registers in database.
        Automatically retrieves execution_id and operator_id from ExecutionContext.

        Args:
            data: Bytes or file-like object containing the data.

        Returns:
            BigObjectPointer for use in tuples.
        """
        # Get IDs from ExecutionContext
        execution_id = ExecutionContext.get_execution_id()
        operator_id = ExecutionContext.get_operator_id()

        if execution_id is None or operator_id is None:
            raise RuntimeError(
                "ExecutionContext not initialized. This should not happen in normal workflow execution."
            )

        cls._create_bucket_if_not_exist(cls.DEFAULT_BUCKET)

        # Generate unique S3 key and URI
        object_key = f"{int(time.time() * 1000)}/{uuid.uuid4()}"
        uri = f"s3://{cls.DEFAULT_BUCKET}/{object_key}"
        s3 = cls._get_s3_client()

        # Upload to S3
        try:
            if isinstance(data, bytes):
                s3.put_object(Bucket=cls.DEFAULT_BUCKET, Key=object_key, Body=data)
            else:
                s3.upload_fileobj(data, cls.DEFAULT_BUCKET, object_key)
        except Exception as e:
            raise RuntimeError(f"Failed to upload big object to S3: {e}")

        # Register in database
        try:
            conn = cls._get_db_connection()
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO big_object (execution_id, operator_id, uri) VALUES (%s, %s, %s)",
                (execution_id, operator_id, uri),
            )
            conn.commit()
            cursor.close()
        except Exception as e:
            # Clean up S3 object if database registration fails
            try:
                s3.delete_object(Bucket=cls.DEFAULT_BUCKET, Key=object_key)
            except:
                pass
            raise RuntimeError(f"Failed to create big object: {e}")

        # Send event to frontend
        cls._send_big_object_event(operator_id, uri, "CREATE")

        return BigObjectPointer(uri)

    @classmethod
    def open(cls, pointer: BigObjectPointer) -> BigObjectStream:
        """
        Open a big object for reading.

        Usage: with BigObjectManager.open(tuple_["document"]) as stream:
                   content = stream.read().decode('utf-8')
        """
        if not isinstance(pointer, BigObjectPointer):
            raise TypeError(f"Expected BigObjectPointer, got {type(pointer)}")

        # Parse s3://bucket/key
        parts = pointer.uri.removeprefix("s3://").split("/", 1)
        if len(parts) != 2:
            raise ValueError(
                f"Invalid S3 URI (expected s3://bucket/key): {pointer.uri}"
            )

        bucket, key = parts

        try:
            body = cls._get_s3_client().get_object(Bucket=bucket, Key=key)["Body"]

            # Send event to frontend
            operator_id = ExecutionContext.get_operator_id()
            if operator_id:
                cls._send_big_object_event(operator_id, pointer.uri, "READ")

            return BigObjectStream(body, pointer)
        except Exception as e:
            raise RuntimeError(f"Failed to open {pointer.uri}: {e}")

    @classmethod
    def _send_big_object_event(cls, operator_id: str, uri: str, event_type: str):
        """Sends BigObjectEvent to controller for forwarding to frontend."""
        try:
            from proto.org.apache.amber.engine.architecture.rpc import (
                BigObjectEvent,
                BigObjectEventTriggeredRequest,
                BigObjectEventType,
            )
            from datetime import datetime, timezone

            client = ExecutionContext.get_async_rpc_client()
            if not client:
                return

            event = BigObjectEvent(
                operator_id=operator_id,
                uri=uri,
                event_type=(
                    BigObjectEventType.CREATE
                    if event_type == "CREATE"
                    else BigObjectEventType.READ
                ),
                timestamp=datetime.now(timezone.utc),
            )
            client.controller_stub().big_object_event_triggered(
                BigObjectEventTriggeredRequest(event=event)
            )
        except Exception:
            pass
