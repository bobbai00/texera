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

import os
from typing import BinaryIO
from core.models.schema.big_object_pointer import BigObjectPointer


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

    @classmethod
    def _get_s3_client(cls):
        """Initialize S3 client (lazy, cached)."""
        if cls._s3_client is None:
            try:
                import boto3
                from botocore.config import Config

                cls._s3_client = boto3.client(
                    "s3",
                    endpoint_url=os.environ.get(
                        "STORAGE_S3_ENDPOINT", "http://localhost:9000"
                    ),
                    aws_access_key_id=os.environ.get(
                        "STORAGE_S3_AUTH_USERNAME", "texera_minio"
                    ),
                    aws_secret_access_key=os.environ.get(
                        "STORAGE_S3_AUTH_PASSWORD", "password"
                    ),
                    region_name=os.environ.get("STORAGE_S3_REGION", "us-west-2"),
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
            return BigObjectStream(body, pointer)
        except Exception as e:
            raise RuntimeError(f"Failed to open {pointer.uri}: {e}")
