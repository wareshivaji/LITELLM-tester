/**
 * A test harness in thirty lines.
 *
 * No framework, on purpose: these tests cover pure functions with no I/O, no
 * async and no mocking, and a runner would be more dependency than the thing it
 * runs. `node test/<file>.mjs` works, and so does the aggregate `npm test`.
 */

export function createSuite(name) {
  let pass = 0;
  let fail = 0;
  console.log(`=== ${name} ===`);

  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
      pass++;
      console.log(`  PASS  ${label}`);
    } else {
      fail++;
      console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
    }
  };

  const truthy = (label, actual) => check(label, Boolean(actual), true);

  const done = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  };

  return { check, truthy, done };
}
