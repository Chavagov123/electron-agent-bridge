import type { FlowResult } from './flow-runner.js';

/** JUnit XML (one test suite per flow, one test case per step) for CI test reports. */
export function toJunit(results: readonly FlowResult[]): string {
  const totals = results.reduce(
    (sum, result) => ({
      tests: sum.tests + Math.max(1, result.steps.length),
      failures: sum.failures + failuresOf(result),
      time: sum.time + result.durationMs,
    }),
    { tests: 0, failures: 0, time: 0 },
  );
  const suites = results.map((result) => {
    const cases =
      result.steps.length === 0
        ? [
            testCase(
              result,
              'flow',
              0,
              result.error === undefined ? '' : failure(result.error.code, result.error.message),
            ),
          ]
        : result.steps.map((step) => {
            const body =
              step.status === 'skipped'
                ? '<skipped/>'
                : step.error === undefined
                  ? ''
                  : failure(
                      step.error.code,
                      step.error.message,
                      [step.error.hint, ...step.artifacts].filter(Boolean).join('\n'),
                    );
            return testCase(result, `${step.index + 1}. ${step.name}`, step.durationMs, body);
          });
    const skipped = result.steps.filter((step) => step.status === 'skipped').length;
    return (
      `  <testsuite name="${xml(result.name)}" tests="${Math.max(1, result.steps.length)}" ` +
      `failures="${failuresOf(result)}" skipped="${skipped}" time="${seconds(result.durationMs)}"` +
      `${result.file === undefined ? '' : ` file="${xml(result.file)}"`}>\n${cases.join('\n')}\n  </testsuite>`
    );
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites name="eab flows" tests="${totals.tests}" failures="${totals.failures}" time="${seconds(totals.time)}">\n` +
    `${suites.join('\n')}\n</testsuites>\n`
  );
}

function failuresOf(result: FlowResult): number {
  if (result.steps.length === 0) return result.passed ? 0 : 1;
  return result.steps.filter((step) => step.status === 'failed').length;
}

function testCase(result: FlowResult, name: string, durationMs: number, body: string): string {
  const open = `    <testcase classname="${xml(result.name)}" name="${xml(name)}" time="${seconds(durationMs)}"`;
  return body === '' ? `${open}/>` : `${open}>\n      ${body}\n    </testcase>`;
}

function failure(code: string, message: string, details = ''): string {
  return `<failure type="${xml(code)}" message="${xml(message)}">${xml(details)}</failure>`;
}

function seconds(ms: number): string {
  return (ms / 1_000).toFixed(3);
}

/** Text safe in XML attributes and content; characters XML 1.0 forbids are dropped. */
function xml(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- removing the control characters XML cannot carry
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}
