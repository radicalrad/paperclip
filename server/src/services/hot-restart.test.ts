import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMissingHotRestartSnapshotRunIds,
  isHotRestartShutdownPending,
  isObservedHotRestartTargetAlive,
  parseHotRestartIntent,
  quarantineHotRestartIntent,
  readHotRestartIntent,
  readProcessStartedAt,
  removeHotRestartIntent,
  resolveHotRestartIntentPath,
  resolveLegacyHotRestartIntentPath,
  writeHotRestartIntent,
  writeHotRestartShutdownSnapshot,
} from "./hot-restart.js";

const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
});

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hot-restart-paths-"));
  try {
    return await fn(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

describe("hot-restart path compatibility", () => {
  it("reads version-1 native recovery fields without making them mandatory", () => {
    expect(
      parseHotRestartIntent({
        version: 1,
        requestedAt: "2026-09-04T10:00:00.000Z",
        recoveryRequestId: "restart-request-1",
        previousServerPid: 123,
        drainRequired: false,
        requestedByRunId: null,
        preflightActiveRunIds: ["run-1"],
        shutdownSnapshot: {
          capturedAt: "2026-09-04T10:00:01.000Z",
          signal: "SIGTERM",
          activeRuns: [
            {
              runId: "run-1",
              companyId: "company-1",
              agentId: "agent-1",
              adapterType: "paperclip_runner",
              status: "running",
              processPid: 456,
              processGroupId: 456,
              issueId: "issue-1",
              runtimeMode: "native",
              nativeSessionId: "session-1",
              runnerInstanceId: "runner-1",
              processStartedAt: "2026-09-04T09:59:00.000Z",
            },
          ],
        },
      }),
    ).toMatchObject({
      version: 1,
      recoveryRequestId: "restart-request-1",
      shutdownSnapshot: {
        activeRuns: [
          {
            runtimeMode: "native",
            nativeSessionId: "session-1",
            runnerInstanceId: "runner-1",
            processStartedAt: "2026-09-04T09:59:00.000Z",
          },
        ],
      },
    });

    expect(
      parseHotRestartIntent({
        version: 1,
        requestedAt: "2026-09-04T10:00:00.000Z",
        previousServerPid: 123,
        drainRequired: false,
        requestedByRunId: null,
        preflightActiveRunIds: [],
      }),
    ).not.toBeNull();
  });

  it("reads Linux process birth from kernel ticks rather than proc directory metadata", async () => {
    await expect(
      readProcessStartedAt(123, {
        platform: "linux",
        linuxProcessStart: {
          clockTicksPerSecond: 100,
          readFile: (target) => target === "/proc/stat"
            ? `btime ${Date.parse("2026-08-01T01:00:00.000Z") / 1000}\n`
            : target === "/proc/123/stat"
              ? `123 (runner) S ${Array(18).fill("0").join(" ")} 123\n`
              : (() => { throw new Error("Unexpected proc read"); })(),
        },
      }),
    ).resolves.toBe("2026-08-01T01:00:01.230Z");
  });

  it("reads macOS process start time through ps", async () => {
    await expect(
      readProcessStartedAt(456, {
        platform: "darwin",
        runCommand: async (command, args) => {
          expect([command, ...args]).toEqual([
            "ps",
            "-o",
            "lstart=",
            "-p",
            "456",
          ]);
          return "Fri Aug  1 01:02:03 2026\n";
        },
      }),
    ).resolves.toBe(new Date("Fri Aug  1 01:02:03 2026").toISOString());
  });

  it("reads Windows process start time through PowerShell", async () => {
    await expect(
      readProcessStartedAt(789, {
        platform: "win32",
        runCommand: async (command, args) => {
          expect(command).toBe("powershell.exe");
          expect(args.at(-1)).toContain("Get-Process -Id 789");
          return "2026-08-01T01:02:03.456Z\r\n";
        },
      }),
    ).resolves.toBe("2026-08-01T01:02:03.456Z");
  });

  it("falls back from Windows PowerShell to pwsh", async () => {
    const commands: string[] = [];
    await expect(
      readProcessStartedAt(790, {
        platform: "win32",
        runCommand: async (command) => {
          commands.push(command);
          if (command === "powershell.exe") throw new Error("not installed");
          return "2026-08-01T01:02:04.000Z\n";
        },
      }),
    ).resolves.toBe("2026-08-01T01:02:04.000Z");
    expect(commands).toEqual(["powershell.exe", "pwsh.exe"]);
  });

  it("surfaces supported-platform process identity probe failures", async () => {
    await expect(readProcessStartedAt(791, {
      platform: "darwin",
      runCommand: async () => {
        throw new Error("ps unavailable");
      },
    })).rejects.toThrow("ps unavailable");
  });

  it("distinguishes recycled PIDs and rejects unknown live claim classification", () => {
    const intent = {
      version: 1 as const,
      requestedAt: "2026-08-01T01:05:00.000Z",
      previousServerPid: 123,
      previousServerIdentity: "server-boot-a",
      previousServerStartedAt: "2026-08-01T01:00:00.000Z",
      previousServerVersion: "old-version",
      drainRequired: false,
      requestedByRunId: null,
      preflightActiveRunIds: [],
    };

    expect(isObservedHotRestartTargetAlive(intent, {
      alive: true,
      startedAt: "2026-08-01T01:00:00.000Z",
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "server-boot-a",
      },
    })).toBe(true);
    expect(isObservedHotRestartTargetAlive(intent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "server-boot-b",
      },
    })).toBe(false);

    const legacyIntent = {
      ...intent,
      previousServerIdentity: null,
      previousServerStartedAt: null,
    };
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: "2026-08-01T01:06:00.000Z",
    })).toBe(false);
    expect(() => isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
    })).toThrow("Cannot establish process identity");
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "2026-08-01T01:04:00.000Z",
      },
    })).toBe(true);
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "2026-08-01T01:06:00.000Z",
      },
    })).toBe(false);
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: null,
        previousServerStartedAt: "2026-08-01T01:04:00.000Z",
      },
    })).toBe(true);
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: null,
        previousServerStartedAt: "2026-08-01T01:06:00.000Z",
      },
    })).toBe(false);
  });

  it("refuses to create an unidentifiable process claim", async () => {
    await withTempHome(async (homeDir) => {
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: 2_147_483_647,
        previousServerStartedAt: null,
      })).rejects.toThrow("process start time are unavailable");

      await expect(fs.stat(resolveHotRestartIntentPath(homeDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(resolveLegacyHotRestartIntentPath(homeDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("reclaims a live recycled PID when server boot identities differ", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        previousServerIdentity: "server-boot-a",
        requestedByRunId: "blue-deploy",
      });

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        previousServerIdentity: "server-boot-b",
        requestedByRunId: "green-deploy",
      })).resolves.toMatchObject({
        previousServerIdentity: "server-boot-b",
        requestedByRunId: "green-deploy",
      });
    });
  });

  it("writes both paths but does not merge a legacy snapshot from another request", async () => {
    process.env.PAPERCLIP_INSTANCE_ID = "blue";

    await withTempHome(async (homeDir) => {
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: 101,
        previousServerStartedAt: "2026-08-01T01:00:00.000Z",
        requestedAt: new Date("2026-08-01T02:00:00.000Z"),
        requestedByRunId: "blue-deploy",
        preflightActiveRunIds: ["blue-run"],
      });
      await expect(fs.stat(resolveHotRestartIntentPath(homeDir))).resolves.toBeDefined();
      await expect(fs.stat(resolveLegacyHotRestartIntentPath(homeDir))).resolves.toBeDefined();

      const unrelatedLegacyIntent = {
        version: 1,
        requestedAt: "2026-08-01T02:00:01.000Z",
        previousServerPid: 202,
        previousServerVersion: "other-instance",
        drainRequired: false,
        requestedByRunId: "other-deploy",
        shutdownSnapshot: {
          capturedAt: "2026-08-01T02:00:02.000Z",
          signal: "SIGTERM",
          activeRuns: [],
        },
      };
      await fs.writeFile(
        resolveLegacyHotRestartIntentPath(homeDir),
        `${JSON.stringify(unrelatedLegacyIntent, null, 2)}\n`,
        "utf8",
      );

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        previousServerPid: 101,
        requestedByRunId: "blue-deploy",
        preflightActiveRunIds: ["blue-run"],
      });
      expect((await readHotRestartIntent(homeDir))?.shutdownSnapshot).toBeUndefined();
    });
  });

  it("does not let a non-default instance consume an uncorrelated legacy-only marker", async () => {
    process.env.PAPERCLIP_INSTANCE_ID = "green";

    await withTempHome(async (homeDir) => {
      await fs.writeFile(
        resolveLegacyHotRestartIntentPath(homeDir),
        `${JSON.stringify({
          version: 1,
          requestedAt: "2026-08-01T03:00:00.000Z",
          previousServerPid: 303,
          previousServerVersion: "legacy",
          drainRequired: false,
          requestedByRunId: null,
        })}\n`,
        "utf8",
      );

      await expect(readHotRestartIntent(homeDir)).resolves.toBeNull();
    });
  });

  it("ignores a malformed legacy marker when the instance marker is valid", async () => {
    process.env.PAPERCLIP_INSTANCE_ID = "blue";

    await withTempHome(async (homeDir) => {
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: 304,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:30:00.000Z"),
        preflightActiveRunIds: ["blue-run"],
      });
      await fs.writeFile(resolveLegacyHotRestartIntentPath(homeDir), "not-json", "utf8");

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        previousServerPid: 304,
        preflightActiveRunIds: ["blue-run"],
      });
    });
  });

  it("does not overwrite another instance's active legacy handoff", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date("2026-08-01T03:40:00.000Z"),
        requestedByRunId: "blue-deploy",
      });

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: 502,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:40:01.000Z"),
        requestedByRunId: "green-deploy",
      })).rejects.toMatchObject({ code: "EEXIST" });

      const legacyIntent = JSON.parse(
        await fs.readFile(resolveLegacyHotRestartIntentPath(homeDir), "utf8"),
      ) as Record<string, unknown>;
      expect(legacyIntent).toMatchObject({
        previousServerPid: process.pid,
        requestedByRunId: "blue-deploy",
      });
      await expect(fs.stat(resolveHotRestartIntentPath(homeDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("reclaims an abandoned legacy handoff after its target process exits", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: 2_147_483_647,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:50:00.000Z"),
        requestedByRunId: "abandoned-deploy",
      });

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date("2026-08-01T03:51:00.000Z"),
        requestedByRunId: "green-deploy",
      })).resolves.toMatchObject({ requestedByRunId: "green-deploy" });

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        previousServerPid: process.pid,
        requestedByRunId: "green-deploy",
      });
    });
  });

  it("reclaims an abandoned handoff when its PID belongs to a newer process", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date("2020-01-01T00:00:00.000Z"),
        requestedByRunId: "expired-deploy",
      });
      const legacyPath = resolveLegacyHotRestartIntentPath(homeDir);
      const legacyIntent = JSON.parse(
        await fs.readFile(legacyPath, "utf8"),
      ) as Record<string, unknown>;
      delete legacyIntent.previousServerStartedAt;
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify(legacyIntent, null, 2)}\n`,
        "utf8",
      );

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedByRunId: "green-deploy",
      })).resolves.toMatchObject({ requestedByRunId: "green-deploy" });

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        requestedByRunId: "green-deploy",
      });
    });
  });

  it("keeps an old handoff while its original target process is alive", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date(),
        requestedByRunId: "blue-deploy",
      });

      vi.useFakeTimers({ now: Date.now() + 10 * 60_000 });
      try {
        process.env.PAPERCLIP_INSTANCE_ID = "green";
        await expect(writeHotRestartIntent({
          homeDir,
          previousServerPid: process.pid,
          requestedByRunId: "green-deploy",
        })).rejects.toMatchObject({ code: "EEXIST" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not let matching cleanup delete replacement intent markers", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      const abandonedIntent = await writeHotRestartIntent({
        homeDir,
        previousServerPid: 2_147_483_647,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:55:00.000Z"),
        requestedByRunId: "abandoned-deploy",
      });

      await Promise.all([
        removeHotRestartIntent(homeDir, abandonedIntent),
        writeHotRestartIntent({
          homeDir,
          previousServerPid: process.pid,
          requestedAt: new Date("2026-08-01T03:56:00.000Z"),
          requestedByRunId: "replacement-deploy",
        }),
      ]);

      const legacyIntent = JSON.parse(
        await fs.readFile(resolveLegacyHotRestartIntentPath(homeDir), "utf8"),
      ) as Record<string, unknown>;
      expect(legacyIntent).toMatchObject({ requestedByRunId: "replacement-deploy" });
      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        requestedByRunId: "replacement-deploy",
      });
    });
  });

  it("treats every preflight run omitted from the shutdown snapshot as missing", () => {
    expect(findMissingHotRestartSnapshotRunIds({
      version: 1,
      requestedAt: "2026-08-01T04:00:00.000Z",
      previousServerPid: 404,
      previousServerVersion: "old-version",
      drainRequired: false,
      requestedByRunId: null,
      preflightActiveRunIds: ["captured-run", "missing-run"],
      shutdownSnapshot: {
        capturedAt: "2026-08-01T04:00:01.000Z",
        signal: "SIGTERM",
        activeRunsCaptured: true,
        activeRuns: [{
          runId: "captured-run",
          companyId: "company",
          agentId: "agent",
          adapterType: "codex_local",
          status: "running",
          processPid: 405,
          processGroupId: null,
          issueId: "issue",
        }],
      },
    })).toEqual(["missing-run"]);
  });
});

describe("hot-restart intent capture flag and fail-closed probe", () => {
  const PID = 4242;

  it("parses a pre-flag snapshot as having captured its run list", () => {
    expect(
      parseHotRestartIntent({
        version: 1,
        requestedAt: "2026-11-12T11:35:03.000Z",
        previousServerPid: PID,
        drainRequired: false,
        shutdownSnapshot: {
          capturedAt: "2026-11-12T11:35:04.000Z",
          signal: "SIGTERM",
          activeRuns: [],
        },
      })?.shutdownSnapshot?.activeRunsCaptured,
    ).toBe(true);
  });

  it("round-trips an unknown run list through a write/read cycle", async () => {
    await withTempHome(async (homeDir) => {
      const intent = await writeHotRestartIntent({
        homeDir,
        previousServerPid: PID,
        previousServerStartedAt: "2026-11-12T11:34:00.000Z",
        drainRequired: false,
      });
      await writeHotRestartShutdownSnapshot({
        intent,
        signal: "SIGTERM",
        activeRuns: [],
        activeRunsCaptured: false,
        homeDir,
      });

      const reread = await readHotRestartIntent(homeDir);
      expect(reread?.shutdownSnapshot?.activeRunsCaptured).toBe(false);
      expect(reread?.shutdownSnapshot?.activeRuns).toEqual([]);
      expect(reread?.shutdownSnapshot?.signal).toBe("SIGTERM");
    });
  });

  it("is pending for an intent that targets this pid without requiring a drain", async () => {
    await withTempHome(async (homeDir) => {
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: PID,
        previousServerStartedAt: "2026-11-12T11:34:00.000Z",
        drainRequired: false,
      });
      await expect(isHotRestartShutdownPending({ homeDir, pid: PID })).resolves.toBe(true);
    });
  });

  it("is not pending once the intent requires the graceful drain", async () => {
    await withTempHome(async (homeDir) => {
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: PID,
        previousServerStartedAt: "2026-11-12T11:34:00.000Z",
        drainRequired: true,
      });
      await expect(isHotRestartShutdownPending({ homeDir, pid: PID })).resolves.toBe(false);
    });
  });

  it("is not pending when no intent is on disk", async () => {
    await withTempHome(async (homeDir) => {
      await expect(isHotRestartShutdownPending({ homeDir, pid: PID })).resolves.toBe(false);
    });
  });

  it("is pending when the intent cannot be parsed", async () => {
    // Fail closed: a corrupt file must never release a SIGTERM of every live run.
    await withTempHome(async (homeDir) => {
      const intentPath = resolveHotRestartIntentPath(homeDir);
      await fs.mkdir(path.dirname(intentPath), { recursive: true });
      await fs.writeFile(intentPath, "{ not json", "utf8");
      await expect(isHotRestartShutdownPending({ homeDir, pid: PID })).resolves.toBe(true);
    });
  });
});

describe("quarantineHotRestartIntent", () => {
  const PID = 4242;

  it("moves an unreadable intent aside, keeps its bytes and stops it influencing shutdown", async () => {
    await withTempHome(async (homeDir) => {
      const source = resolveHotRestartIntentPath(homeDir);
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, "{ not json", "utf8");

      const quarantined = await quarantineHotRestartIntent(homeDir);

      expect(quarantined).toBeTruthy();
      expect(path.basename(quarantined as string)).toMatch(
        /^hot-restart-intent\.corrupt-.+\.json$/,
      );
      await expect(fs.readFile(quarantined as string, "utf8")).resolves.toBe("{ not json");
      await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
      // The point of quarantining: the fail-closed probe can no longer see it.
      await expect(isHotRestartShutdownPending({ homeDir, pid: PID })).resolves.toBe(false);
    });
  });

  it("returns null when there is nothing to quarantine", async () => {
    await withTempHome(async (homeDir) => {
      await expect(quarantineHotRestartIntent(homeDir)).resolves.toBeNull();
    });
  });
});
