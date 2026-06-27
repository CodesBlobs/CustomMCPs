import { spawn } from "node:child_process";

import { buildPairingCaptureUrl, type PairingFile } from "@agentic-browser-mcp/shared";

interface PairingTabLaunchOptions {
  readonly preferredBrowser?: string;
}

interface LaunchCommand {
  readonly command: string;
  readonly args: string[];
  readonly detached?: boolean;
  readonly waitForExit?: boolean;
}

export async function openPairingTab(
  pairingFile: PairingFile,
  options: PairingTabLaunchOptions = {},
): Promise<string> {
  const pairingUrl = buildPairingCaptureUrl(pairingFile);
  const launchCommands = getLaunchCommands(pairingUrl, options.preferredBrowser);

  let lastError: Error | undefined;
  for (const launchCommand of launchCommands) {
    try {
      await runLaunchCommand(launchCommand);
      return pairingUrl;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) {
    throw lastError;
  }

  return pairingUrl;
}

function getLaunchCommands(
  url: string,
  preferredBrowser?: string,
): LaunchCommand[] {
  if (preferredBrowser) {
    return [{ command: preferredBrowser, args: [url], detached: true }];
  }

  switch (process.platform) {
    case "darwin":
      return [
        {
          command: "open",
          args: ["-a", "Google Chrome", url],
          waitForExit: true,
        },
        {
          command: "open",
          args: [url],
          waitForExit: true,
        },
      ];
    case "win32":
      return [
        {
          command: "cmd.exe",
          args: ["/c", "start", "", "chrome", url],
          waitForExit: true,
        },
        {
          command: "cmd.exe",
          args: ["/c", "start", "", url],
          waitForExit: true,
        },
      ];
    default:
      return [
        {
          command: "google-chrome",
          args: [url],
          detached: true,
        },
        {
          command: "chromium-browser",
          args: [url],
          detached: true,
        },
        {
          command: "xdg-open",
          args: [url],
          waitForExit: true,
        },
      ];
  }
}

async function runLaunchCommand(launchCommand: LaunchCommand): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launchCommand.command, launchCommand.args, {
      detached: launchCommand.detached ?? false,
      stdio: "ignore",
    });

    child.once("error", reject);

    if (launchCommand.waitForExit) {
      child.once("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`${launchCommand.command} exited with code ${String(code)}`));
      });
      return;
    }

    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
