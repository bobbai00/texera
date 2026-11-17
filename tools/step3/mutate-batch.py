#!/usr/bin/env python3
"""mutate-batch.py <mutations.py> <batch name> <mutation names...> : applies the named mutations
together (they must not touch the same lines), runs the union of their suites once, prints every
case that failed, and restores each file from a copy kept in the scratchpad (never through git).
Each mutation's own case must then be found among the failures by the reader."""
import importlib.util, os, pathlib, shutil, subprocess, sys, xml.etree.ElementTree as ET

S = pathlib.Path(os.environ.get('SCE_WORK', os.path.expanduser('~/.sce-work'))) / 'step3'
W = pathlib.Path(os.environ.get('SCE_WORKTREE', os.path.expanduser('~/Desktop/projects/texera-worktrees/self-contained-engine')))

spec = importlib.util.spec_from_file_location('m', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
batch, names = sys.argv[2], sys.argv[3:]
chosen = [mut for mut in m.MUTATIONS if mut[0] in names]
assert len(chosen) == len(names), [n for n in names if n not in [c[0] for c in chosen]]

backups = {}
suites = []
try:
    for name, path, old, new, its in chosen:
        f = W / path
        if f not in backups:
            backups[f] = S / 'bak' / (f.name + '.mutb')
            shutil.copyfile(f, backups[f])
        text = f.read_text()
        assert text.count(old) == 1, f'{name}: the text to replace occurs {text.count(old)} times'
        f.write_text(text.replace(old, new))
        for suite in its:
            if suite not in suites: suites.append(suite)
    for suite in suites:
        report = W / 'amber/target/test-reports' / f'TEST-{suite}.xml'
        if report.exists(): report.unlink()
    run = subprocess.run([str(S / 'sbtrun.sh'), f'mutb-{batch}', 'WorkflowExecutionService/testOnly ' + ' '.join(suites)],
                         capture_output=True, text=True)
    print(run.stdout.strip().splitlines()[0] if run.stdout.strip() else '(no output)')
    for suite in suites:
        report = W / 'amber/target/test-reports' / f'TEST-{suite}.xml'
        short = suite.split('.')[-1]
        if not report.exists():
            print(f'## {short}: NO REPORT (did it compile?)'); continue
        cases = list(ET.parse(report).getroot().iter('testcase'))
        failed = [tc for tc in cases if tc.find('failure') is not None or tc.find('error') is not None]
        print(f'## {short}: {len(failed)} of {len(cases)} failed')
        for tc in failed:
            print('     ', tc.get('name')[:150])
finally:
    for f, backup in backups.items():
        shutil.copyfile(backup, f)
    print('restored', len(backups), 'files')
