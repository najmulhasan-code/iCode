export interface TestCase {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

/**
 * Runs the cases in order and rejects when any of them fails, so the VS Code
 * process that hosts the run exits with a failure.
 */
export async function runAll(cases: readonly TestCase[]): Promise<void> {
  const failures: string[] = [];
  for (const testCase of cases) {
    try {
      await testCase.run();
      console.log(`ok - ${testCase.name}`);
    } catch (error) {
      failures.push(testCase.name);
      console.error(`not ok - ${testCase.name}`);
      console.error(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${String(failures.length)} of ${String(cases.length)} tests failed`);
  }
}

export async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
