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

-- Names are schema-qualified because the two runners disagree about the search path: the
-- liquibase runner in sql/docker-compose.yml strips `SET search_path` out of these files before
-- applying them, while bin/local-dev.sh keeps it.

\c texera_db

SET search_path TO texera_db;

BEGIN;

-- A computing unit keeps a run's state, statistics, console and results in the lake, and sends
-- Postgres nothing. So what it used to write here goes: the state of a run and where its
-- statistics are, on the execution's row, and the two tables that registered where its console
-- and its results are, with their sizes and counts. How an execution ended is its closing
-- record, which sql/updates/53.sql added and filled from `status` and `last_update_time`.
--
-- Everything is dropped only if it is there, so this changes nothing on a database made from
-- a texera_ddl.sql that no longer has them. Each column is listed with what it was.
ALTER TABLE texera_db.workflow_executions
    DROP COLUMN IF EXISTS status,              -- was SMALLINT NOT NULL DEFAULT 1
    DROP COLUMN IF EXISTS result,              -- was TEXT
    DROP COLUMN IF EXISTS last_update_time,    -- was TIMESTAMP
    DROP COLUMN IF EXISTS runtime_stats_uri,   -- was TEXT
    DROP COLUMN IF EXISTS runtime_stats_size;  -- was BIGINT DEFAULT 0

-- Where an execution's console tables were, and how large.
DROP TABLE IF EXISTS texera_db.operator_executions;
-- Where the result of each output port was, with its size, its row count and its output mode.
DROP TABLE IF EXISTS texera_db.operator_port_executions;

-- The output mode of a result, after the table whose column was of it.
DROP TYPE IF EXISTS texera_db.output_mode_enum;

COMMIT;
