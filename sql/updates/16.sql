-- Licensed to the Apache Software Foundation (ASF) under one
-- or more contributor license agreements.  See the NOTICE file
-- distributed with this work for additional information
-- regarding copyright ownership.  The ASF licenses this file
-- to you under the Apache License, Version 2.0 (the
-- "License"); you may not use this file except in compliance
-- with the License.  You may obtain a copy of the License at
--
--   http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing,
-- software distributed under the License is distributed on an
-- "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
-- KIND, either express or implied.  See the License for the
-- specific language governing permissions and limitations
-- under the License.

-- Update 16: Add workflow_cache table for caching operator results

-- Create workflow_cache table
CREATE TABLE IF NOT EXISTS workflow_cache
(
    cache_key         VARCHAR(64) PRIMARY KEY,
    operator_id       VARCHAR(100) NOT NULL,
    port_id           VARCHAR(100) NOT NULL,
    result_uri        TEXT NOT NULL,
    result_size       INT DEFAULT 0,
    tuple_count       BIGINT DEFAULT 0,
    schema_json       TEXT,
    created_time      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_accessed     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    access_count      INT DEFAULT 1
);

-- Create index on last_accessed for efficient cache eviction queries
CREATE INDEX IF NOT EXISTS idx_workflow_cache_last_accessed ON workflow_cache(last_accessed);
