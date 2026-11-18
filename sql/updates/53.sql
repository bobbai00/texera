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

-- The closing record of an execution: how it ended, why and when, written by the Dashboard
-- service once the execution is over. Until now a computing unit wrote `status` as its run went,
-- so a unit that vanished left its run "Running" for ever.
--
-- Every execution that exists is closed here, since nothing will close it later: with its status
-- when that is an ending (3 completed, 4 failed, 5 killed), else as failed. Its results are
-- marked expired, as the tables they are in are not ones the closing record's readers look for.
--
-- The columns and the rows go together, and only where the columns are not there yet: a database
-- made from a texera_ddl.sql that has them holds executions that are closed as they end, which
-- this must not close.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'texera_db'
          AND table_name = 'workflow_executions'
          AND column_name = 'ended_at'
    ) THEN
        ALTER TABLE texera_db.workflow_executions
            ADD COLUMN outcome SMALLINT,
            ADD COLUMN outcome_reason TEXT,
            ADD COLUMN ended_at TIMESTAMP,
            -- Whether the outcome is the ending the execution's log holds, and not a verdict the
            -- Dashboard service made without one.
            ADD COLUMN outcome_from_log BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN stored_bytes BIGINT,
            ADD COLUMN results_expired_at TIMESTAMP,
            ADD COLUMN notification TEXT;

        UPDATE texera_db.workflow_executions
        SET outcome = CASE WHEN status IN (3, 4, 5) THEN status ELSE 4 END,
            outcome_reason = CASE WHEN status IN (3, 4, 5) THEN NULL
                                  ELSE 'closed when Texera was upgraded' END,
            ended_at = COALESCE(last_update_time, starting_time),
            -- A unit recorded these endings itself, as the log does now.
            outcome_from_log = status IN (3, 4, 5),
            stored_bytes = 0,
            results_expired_at = now();
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workflow_executions_open
    ON texera_db.workflow_executions (eid) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_executions_verdict
    ON texera_db.workflow_executions (ended_at)
    WHERE ended_at IS NOT NULL AND outcome_from_log = FALSE AND results_expired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_executions_unexpired
    ON texera_db.workflow_executions (ended_at)
    WHERE ended_at IS NOT NULL AND results_expired_at IS NULL;

COMMIT;
