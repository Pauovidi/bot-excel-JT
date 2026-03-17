import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { STEP_KEYS } from "@/lib/constants";
import { nowIso } from "@/lib/dateUtils";
import { isDemoStateless } from "@/lib/env";
import type { DemoState, StepKey, StepStatus } from "@/types/demo";

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "demo-state.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
let stateQueue: Promise<void> = Promise.resolve();
let inMemoryState: DemoState | null = null;
let inMemoryUpload:
  | {
      fileName: string;
      buffer: Buffer;
    }
  | null = null;

function buildDefaultSteps(): Record<StepKey, StepStatus> {
  return STEP_KEYS.reduce(
    (accumulator, step) => {
      accumulator[step] = "idle";
      return accumulator;
    },
    {} as Record<StepKey, StepStatus>
  );
}

export function getInitialDemoState(): DemoState {
  return {
    version: 1,
    spreadsheetId: "",
    spreadsheetUrl: "",
    uploadedFilePath: "",
    importSummary: null,
    records: [],
    logs: [],
    steps: buildDefaultSteps(),
    lastUpdatedAt: nowIso()
  };
}

function cloneState(state: DemoState) {
  return JSON.parse(JSON.stringify(state)) as DemoState;
}

function getMemoryState() {
  if (!inMemoryState) {
    inMemoryState = getInitialDemoState();
  }

  return cloneState(inMemoryState);
}

async function ensureStoragePaths() {
  if (isDemoStateless()) {
    return;
  }

  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });
}

type StateLoadResult = {
  state: DemoState;
  needsRepair: boolean;
};

async function loadStateFromDisk(): Promise<StateLoadResult> {
  if (isDemoStateless()) {
    return {
      state: getMemoryState(),
      needsRepair: false
    };
  }

  await ensureStoragePaths();
  try {
    const content = await readFile(STATE_FILE, "utf8");
    if (!content.trim()) {
      console.warn("[stateStore] demo-state.json vacío. Se restaura estado inicial.");
      return {
        state: getInitialDemoState(),
        needsRepair: true
      };
    }

    try {
      return {
        state: JSON.parse(content) as DemoState,
        needsRepair: false
      };
    } catch {
      console.warn("[stateStore] demo-state.json corrupto. Se restaura estado inicial.");
      return {
        state: getInitialDemoState(),
        needsRepair: true
      };
    }
  } catch (error) {
    const errorCode = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (errorCode === "ENOENT") {
      return {
        state: getInitialDemoState(),
        needsRepair: true
      };
    }

    throw error;
  }
}

async function atomicWriteState(state: DemoState) {
  if (isDemoStateless()) {
    inMemoryState = cloneState(state);
    return;
  }

  await ensureStoragePaths();
  const tempFilePath = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempFilePath, JSON.stringify(state, null, 2), "utf8");
  await rename(tempFilePath, STATE_FILE);
}

function enqueueStateTask<T>(task: () => Promise<T>) {
  const nextTask = stateQueue.then(task, task);
  stateQueue = nextTask.then(
    () => undefined,
    () => undefined
  );
  return nextTask;
}

export async function readState() {
  await stateQueue;
  const { state, needsRepair } = await loadStateFromDisk();
  if (needsRepair) {
    await writeState(state);
  }
  return cloneState(state);
}

export async function writeState(state: DemoState) {
  return enqueueStateTask(async () => {
    state.lastUpdatedAt = nowIso();
    await atomicWriteState(state);
    return state;
  });
}

export async function updateState(mutator: (state: DemoState) => DemoState | void) {
  return enqueueStateTask(async () => {
    const { state } = await loadStateFromDisk();
    const updated = mutator(state) ?? state;
    updated.lastUpdatedAt = nowIso();
    await atomicWriteState(updated);
    return updated;
  });
}

export async function resetDemoState(options?: { clearUploads?: boolean }) {
  return enqueueStateTask(async () => {
    if (isDemoStateless()) {
      inMemoryUpload = null;
      const initialState = getInitialDemoState();
      await atomicWriteState(initialState);
      return initialState;
    }

    if (options?.clearUploads !== false) {
      await ensureStoragePaths();
      const files = await readdir(UPLOAD_DIR).catch(() => []);
      await Promise.all(
        files.map((fileName) =>
          rm(path.join(UPLOAD_DIR, fileName), {
            force: true
          })
        )
      );
    }

    const initialState = getInitialDemoState();
    await atomicWriteState(initialState);
    return initialState;
  });
}

export async function saveUpload(buffer: Buffer, fileName: string) {
  if (isDemoStateless()) {
    inMemoryUpload = {
      fileName,
      buffer: Buffer.from(buffer)
    };
    const uploadPath = `memory:${fileName}`;
    await updateState((state) => {
      state.uploadedFilePath = uploadPath;
    });
    return uploadPath;
  }

  await ensureStoragePaths();
  const uploadPath = path.join(UPLOAD_DIR, fileName);
  await writeFile(uploadPath, buffer);
  await updateState((state) => {
    state.uploadedFilePath = uploadPath;
  });
  return uploadPath;
}

export async function readUploadedExcelBuffer() {
  await stateQueue;
  return inMemoryUpload?.buffer ? Buffer.from(inMemoryUpload.buffer) : null;
}

export function trimLogs<T>(items: T[], maxItems = 120) {
  return items.slice(0, maxItems);
}
