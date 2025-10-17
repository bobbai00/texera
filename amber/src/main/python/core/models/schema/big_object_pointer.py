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

"""
BigObjectPointer represents a reference to a large object stored externally (e.g., S3).
This is a schema type class used throughout the system for handling BIG_OBJECT attribute types.
"""


class BigObjectPointer:
    """
    Represents a pointer to a large object stored in S3.
    The pointer is formatted as a URI: s3://bucket/path/to/object

    This is a lightweight value object that only stores the URI reference.
    To actually read the object's content, use BigObjectManager.open(pointer).
    """

    def __init__(self, uri: str):
        """
        Create a new BigObjectPointer.

        Args:
            uri: S3 URI in the format s3://bucket/path/to/object

        Raises:
            ValueError: If the URI is invalid or doesn't start with s3://
        """
        if not uri or not uri.startswith("s3://"):
            raise ValueError(
                f"BigObjectPointer URI must start with 's3://' but was: {uri}"
            )
        self.uri = uri

    def __str__(self) -> str:
        """Return the URI as string representation."""
        return self.uri

    def __repr__(self) -> str:
        """Return developer-friendly representation."""
        return f"BigObjectPointer('{self.uri}')"

    def __eq__(self, other) -> bool:
        """Check equality based on URI."""
        if isinstance(other, BigObjectPointer):
            return self.uri == other.uri
        return False

    def __hash__(self) -> int:
        """Make BigObjectPointer hashable for use in sets/dicts."""
        return hash(self.uri)
