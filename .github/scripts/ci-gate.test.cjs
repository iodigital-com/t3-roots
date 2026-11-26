const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const workflow = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
const query = workflow.match(/jq -e '([\s\S]+?)' > \/dev\/null/)[1];
const names = ["build", "test", "test_web", "test_server", "rust", "windows"];
const passing = () => ({
  changes: { result: "success", outputs: Object.fromEntries(names.map((name) => [name, "true"])) },
  ...Object.fromEntries(names.map((name) => [name, { result: "success" }])),
});
function check(results) {
  const run = spawnSync("jq", ["-e", query], { input: JSON.stringify(results), encoding: "utf8" });
  if (run.error) throw run.error;
  return run.status === 0;
}

test("the actual CI gate rejects failures, cancellations and unexpected skips", () => {
  assert.equal(check(passing()), true);
  for (const name of ["changes", ...names]) {
    const missing = passing();
    delete missing[name];
    assert.equal(check(missing), false, `${name} missing`);
    for (const result of ["failure", "cancelled", "skipped"]) {
      const jobs = passing();
      jobs[name].result = result;
      assert.equal(check(jobs), false, `${name}: ${result}`);
    }
  }
  for (const name of names.filter((name) => name !== "build")) {
    const jobs = passing();
    jobs[name].result = "skipped";
    jobs.changes.outputs[name] = "false";
    assert.equal(check(jobs), true, `${name} deliberately skipped`);
    delete jobs.changes.outputs[name];
    assert.equal(check(jobs), false, `${name} missing gate`);
  }
});
