import { randomUUID } from "node:crypto";

import { trimLogs, updateState } from "@/lib/stateStore";
import type { LogEntry } from "@/types/demo";

type LogInput = Omit<LogEntry, "id" | "timestamp">;

export async function logActivity(input: LogInput) {
  const entry: LogEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...input
  };

  console.log(JSON.stringify(entry));

  await updateState((state) => {
    state.logs = trimLogs([entry, ...state.logs]);
  });

  return entry;
}
