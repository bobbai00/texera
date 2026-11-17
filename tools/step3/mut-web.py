ESS = 'amber/src/main/scala/org/apache/texera/web/storage/ExecutionStateStore.scala'
ERS = 'amber/src/main/scala/org/apache/texera/web/service/ExecutionRuntimeService.scala'
WS = 'amber/src/main/scala/org/apache/texera/web/service/WorkflowService.scala'
WES = 'amber/src/main/scala/org/apache/texera/web/service/WorkflowExecutionService.scala'
SYNC = 'amber/src/main/scala/org/apache/texera/web/resource/SyncExecutionResource.scala'
CUM = 'amber/src/main/scala/org/apache/texera/web/ComputingUnitMaster.scala'
ESTAT = 'amber/src/main/scala/org/apache/texera/web/service/ExecutionStatsService.scala'
P = 'org.apache.texera.web.'
STORE = [P + 'storage.ExecutionStateStoreSpec']
RUNTIME = [P + 'service.ExecutionRuntimeServiceSpec']
WSS = [P + 'service.WorkflowServiceSpec']
WESS = [P + 'service.WorkflowExecutionServiceSpec']
SYNCS = [P + 'resource.SyncExecutionResourceSpec']
CUMS = [P + 'ComputingUnitMasterSpec']
STATS = [P + 'service.ExecutionStatsServiceSpec']
PERSIST = [P + 'service.ExecutionsMetadataPersistServiceSpec']
MUTATIONS = [
    ('no-end-guard', ESS,
     '''      if (ExecutionStateStore.EndStates.contains(metadata.state)) {
        metadata
      } else {''',
     '''      if (false) {
        metadata
      } else {''', STORE + RUNTIME + PERSIST + STATS),
    ('terminated-not-logged', ESS,
     '''      case TERMINATED                                             => Some(KILLED.name)
''', '', STORE),
    ('pausing-logged', ESS,
     '''      case _                                                      => None''',
     '''      case _                                                      => Some(state.name)''', STORE + RUNTIME),
    ('end-time-always', ESS,
     '''    if (taken && ExecutionStateStore.EndStates.contains(state)) {''',
     '''    if (ExecutionStateStore.EndStates.contains(state)) {''', STORE + RUNTIME),
    ('errors-not-kept', ESS,
     '''        metadata.withState(state).addFatalErrors(errors: _*)''',
     '''        metadata.withState(state)''', STORE + STATS),
    ('pause-asks-ended-engine', ERS,
     '''    if (stateStore.transitionTo(PAUSING)) {
      client.coordinatorInterface.pauseWorkflow(EmptyRequest(), ())
    }''',
     '''    stateStore.transitionTo(PAUSING)
    client.coordinatorInterface.pauseWorkflow(EmptyRequest(), ())''', RUNTIME),
    ('resume-reconfigures-ended', ERS,
     '''    if (stateStore.transitionTo(RESUMING)) {
      reconfigurationService.performReconfigurationOnResume()''',
     '''    reconfigurationService.performReconfigurationOnResume()
    if (stateStore.transitionTo(RESUMING)) {''', RUNTIME),
    ('kill-without-reason', ERS,
     '''    stateStore.transitionTo(KILLED, reason = Some("killed by the user"))''',
     '''    stateStore.transitionTo(KILLED)''', RUNTIME + WESS),
    ('idle-kill-before-letting-go', WS,
     '''    unsubscribeAll()
    // Once the run is let go of, as when it is superseded: the kill does not arm the clean-up
    // that records it.
    held.foreach(
      _.executionStateStore.transitionTo(
        KILLED,
        reason = Some(s"stopped: nobody watched it for $cleanUpTimeout s")
      )
    )''',
     '''    held.foreach(
      _.executionStateStore.transitionTo(
        KILLED,
        reason = Some(s"stopped: nobody watched it for $cleanUpTimeout s")
      )
    )
    unsubscribeAll()''', WSS),
    ('no-idle-kill', WS,
     '''    held.foreach(
      _.executionStateStore.transitionTo(
        KILLED,
        reason = Some(s"stopped: nobody watched it for $cleanUpTimeout s")
      )
    )''', '', WSS),
    ('supersede-names-nothing', WS,
     '''          reason = Some(s"replaced by execution ${replacedBy.id}")''',
     '''          reason = None''', WSS),
    ('record-started-late', WS,
     '''    val executionStateStore = new ExecutionStateStore(startRecord(context))''',
     '''    val executionStateStore = new ExecutionStateStore()''', WSS + SYNCS),
    ('targets-ready-killed-first', SYNC,
     '''          executionService.end(
            COMPLETED,
            reason = Some("stopped once its target operators finished")
          )''',
     '''          executionService.end(KILLED, reason = Some(StoppedByCaller))
          executionService.end(
            COMPLETED,
            reason = Some("stopped once its target operators finished")
          )''', SYNCS),
    ('timeout-does-not-end', SYNC,
     '''          case e: Exception if isCausedByTimeout(e) =>
            executionService.end(KILLED, reason = Some(StoppedByCaller))''',
     '''          case e: Exception if isCausedByTimeout(e) =>''', SYNCS),
    ('end-keeps-engine', WES,
     '''    services.foreach(_.client.shutdown())
    executionStateStore.transitionTo(state, errors, reason)''',
     '''    executionStateStore.transitionTo(state, errors, reason)''', WESS),
    ('unit-stop-ends-nothing', CUM,
     '''      runs.foreach(_.end(FAILED, reason = Some("the computing unit was stopped")))''',
     '''      runs.foreach(_.executionStateStore.hasEnded)''', CUMS),
    ('race-outside-lock', ESS,
     '''    var taken = false
    metadataStore.updateState { metadata =>
      if (ExecutionStateStore.EndStates.contains(metadata.state)) {''',
     '''    var taken = false
    val ended = hasEnded
    metadataStore.updateState { metadata =>
      if (ended) {''', STORE),
    ('unit-stop-waits-each', CUM,
     '''      runs.foreach(_.executionStateStore.recorder.awaitIdle(deadline.timeLeft))''',
     '''      runs.foreach(_.executionStateStore.recorder.awaitIdle(StopPatience + deadline.timeLeft * 0))''', CUMS),
    ('unit-stop-skips-ended', CUM,
     '''      val deadline = StopPatience.fromNow
      runs.foreach(_.end(FAILED, reason = Some("the computing unit was stopped")))
      runs.foreach(_.executionStateStore.recorder.awaitIdle(deadline.timeLeft))''',
     '''      val deadline = StopPatience.fromNow
      val live = runs.filter(_.end(FAILED, reason = Some("the computing unit was stopped")))
      live.foreach(_.executionStateStore.recorder.awaitIdle(deadline.timeLeft))''', CUMS),
    ('unit-stop-does-not-wait', CUM,
     '''      runs.foreach(_.executionStateStore.recorder.awaitIdle(deadline.timeLeft))''',
     '''      runs.foreach(_.executionStateStore.hasEnded)''', CUMS),
]
