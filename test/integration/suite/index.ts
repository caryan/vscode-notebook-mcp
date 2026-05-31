import * as path from "path";
import Mocha from "mocha";
import { glob } from "glob";

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 120_000,
    slow: 5_000
  });

  // Allow targeting a subset of tests during development, e.g.
  //   MOCHA_GREP="kernel id" npm test
  if (process.env.MOCHA_GREP) {
    mocha.grep(process.env.MOCHA_GREP);
  }

  const testsRoot = __dirname;
  const files = await glob("**/*.test.js", { cwd: testsRoot });
  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) =>
        failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()
      );
    } catch (err) {
      reject(err);
    }
  });
}
