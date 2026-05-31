import * as assert from "assert";
import * as crypto from "crypto";
import {
  controllerIdForInterpreter,
  normalizeInterpreterPath
} from "../../../src/utils/kernel.js";

// Pure-function coverage for the controller-id computation that used to live
// only in the test helper. Moving it into src means agents can point
// notebook_select_kernel at an interpreter path instead of hashing one
// themselves; these tests pin the exact format the Jupyter extension expects.
suite("kernel id computation", () => {
  test("normalizeInterpreterPath strips /bin for venv-style paths", () => {
    assert.strictEqual(
      normalizeInterpreterPath("/x/y/.venv/bin/python"),
      "/x/y/.venv/python"
    );
  });

  test("normalizeInterpreterPath leaves system interpreters untouched", () => {
    assert.strictEqual(
      normalizeInterpreterPath("/usr/bin/python3"),
      "/usr/bin/python3"
    );
  });

  test("controllerIdForInterpreter builds the Jupyter controller id", () => {
    const id = controllerIdForInterpreter("/x/y/.venv/bin/python");
    const norm = "/x/y/.venv/python";
    const sha = crypto.createHash("sha256").update(norm).digest("hex");
    assert.strictEqual(
      id,
      `.jvsc74a57bd0${sha}.${norm}.${norm}.-m#ipykernel_launcher`
    );
  });
});
