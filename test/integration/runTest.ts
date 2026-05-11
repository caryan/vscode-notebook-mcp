import * as path from "path";
import { spawnSync } from "child_process";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests
} from "@vscode/test-electron";

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const workspacePath = path.resolve(
    extensionDevelopmentPath,
    "test/fixtures/workspace"
  );

  // Use Insiders so the tests can run while the user has a stable VS Code
  // open. macOS refuses to launch a second extension-host of the same bundle
  // id ("Running extension tests from the command line is currently only
  // supported if no other instance of Code is running"), and stable + Insiders
  // are the only co-installable pair with distinct bundle ids.
  const channel = process.env.VSCODE_TEST_CHANNEL ?? "insiders";
  const vscodeExecutablePath = await downloadAndUnzipVSCode(channel);
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(
    vscodeExecutablePath
  );

  // Install both extensions explicitly. ms-python.python is technically a
  // dependency of ms-toolsai.jupyter but the test VS Code doesn't auto-pull
  // optional/extension-pack dependencies; without it the Python extension API
  // is unavailable and kernel selection cannot work.
  for (const extId of ["ms-python.python", "ms-toolsai.jupyter"]) {
    const install = spawnSync(
      cli,
      [...cliArgs, "--install-extension", extId, "--force"],
      { encoding: "utf-8", stdio: "inherit" }
    );
    if (install.status !== 0) {
      throw new Error(`failed to install ${extId} into the test VS Code`);
    }
  }

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-telemetry"
    ]
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
