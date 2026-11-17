B1-B9 now pass twice in a row from empty volumes on `sce/step2m`, and the work is committed (not pushed). My stack is down and I hold no lock; another job ("step3 lane lakekeeper") has it now.

**Commits** (`/Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e`, main)
- `c7cf39e` driver: browser smoke on the editor after upstream's #9060; B9 (`driver/browser_smoke.py` only)
- `f66b67f` README: the cases as they now are, B9, the evidence, how the page is driven
- `cb70584` README: the verification row for step2m

`run-browser-smoke.sh` is unchanged, and there are no browser-smoke tests.

**Final runs** (harness `f66b67f`, clean; 10, 17, 13, 15, 15, 11, 18, 22, 16 checks; scenario a passed after each)
- `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e/reports/browser-smoke-20261117T105415Z/report.json`
- `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e/reports/browser-smoke-20261117T105958Z/report.json`

**The failing checks**

The cause was upstream's #9060/#9063, as you expected. The product shows everything in the new place; I looked at screenshots before adapting each check.
- **Result rows (B1, B2 after the fix, B4/B7/B8, B5):** the result is now in a window pinned beside the operator, holding the same table. The smoke opens it with a double-click on the operator (B2 uses "pin result" in the right-click menu) and reads columns, pages and rows there. A page holds 6-7 rows now, where it held 5.
- **B4/B7/B8:** the window opens on page 1, all `v1`; page 50 is all `v2`. The check now also requires that the first page read is page 1.
- **B5:** the window opened after the first run is left open and shows the second run's stamp afterwards. The check now also requires that the window stayed open.
- **B2's error:** errors are console messages now. The smoke selects the Projection, opens the console with its button, and requires the console narrowed to the Projection with a message of type ERROR naming the column.

**B9**
- **Through the UI:**
  - On the Dashboard: sidebar Environments, Create Environment, a name, one package row (`tabulate`, `==`, `0.9.0`), Save.
  - In the editor: select the UDF, uncheck Default Python Environment, pick the environment in the Virtual Environment list (it lists it), open the console, Run.
  - After the run: open the ready message, double-click the UDF, open the computing-unit menu.
- **Through the API or the driver:** the workflow is saved (as in every case, with the UDF in the default environment), and `GET /api/environments` is read back as a cross-check. Scenario g's precondition and its removal of an earlier install run with `docker exec` in the unit's container, so B9 runs on the single-node stack only.
- **What it saw:**
  - `POST /api/environments` answered 201, and the create carried `defaultEnv: false` with the name.
  - The UDF's console said "Installing … (1 package)", then "… is ready (2.9 s)" (3.3 s in the second run), both while the run button said Submitting.
  - After the run the ready message lists `tabulate==0.9.0`, and the result row says `0.9.0`.
  - The unit's row of the menu offers rename, details and disconnect; no "+", and nothing names an environment.

**Product findings** (evidence under `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e/reports/browser-probes-step2m-20261117/`)
1. **The UDF's console is empty while the run is Running.** The two install messages vanish when the run goes from Initializing to Running and return at the next message or state. The gap was 0.4-0.5 s in B9 and about 7 s with a UDF that sleeps 6 s. Each B9 report notes it; see also `probe1-out/p5-02-run-04.png` and `probe1-out/p5-console-samples.json`.
2. **The install messages look like errors.** Their titles are bold red, though their badge is the grey one; the stylesheet colours every message that has a detail. See `B9-console-after-run.png` in either final report directory.
3. **A run that fails before it starts leaves no sign on the page with the console closed.** After an environment pip cannot install, the run button is back to Run, the operators are grey and there is no toast (`probe3-out/R2-02-ended-console-closed.png`). The same holds after a refused create (`probe1-out/p3-01-after-400-nothing-clicked.png`). During an install the only sign is "Submitting" on the run button.
4. **The failed install is listed twice in the console,** once from the unit and once as the run's error (`probe3-out/R2-04-console-nothing-selected.png`).
5. **The same compile error is listed twice** after a refused create once the editor's own compile also answers. This is only reachable in the race B2 forces (`probe1-out/p3-07-after-editor-compile.png`).
6. **The hover card and the result window of a failed operator show the Java class name** ("java.lang.RuntimeException: …"), which the console strips (`probe1-out/p3-02-hover-card.png`).
7. **The result window is drawn over the property editor** for an operator far right, and over the operator's output count (`B1-completed.png` in either final report directory).
8. **A page that opens on a run already going logs a `TypeError … reading 'attr'` when the run ends.** It is upstream's region colouring, and it has been in every B7 and B8 since step2b, so it is not from the merge.

**Not verified**
- Whether the pre-merge frontend behaved differently for findings 3-6.
- The "reused" message as a check: I saw it only in a probe, and B9 runs once.
- The picker's search fallback for a long list: only one environment existed.
- Results after reloading a completed run.
- The services' logs of the two final runs, which the script does not keep.