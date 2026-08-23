import type { PermissionGate, PermissionRequest } from '../permissions.js';

/**
 * Stand-ins for the real gate. The tool dispatcher only calls `check`, so a
 * plain object with that method is enough — no need to construct a real gate
 * with a fake terminal behind it.
 */
export function allowAll(): PermissionGate {
  return { check: async () => true } as unknown as PermissionGate;
}

export function denyAll(): PermissionGate {
  return { check: async () => false } as unknown as PermissionGate;
}

/** Records what the gate was asked, then answers with `answer`. */
export function spyGate(answer = true): {
  gate: PermissionGate;
  seen: PermissionRequest[];
} {
  const seen: PermissionRequest[] = [];
  const gate = {
    check: async (request: PermissionRequest) => {
      seen.push(request);
      return answer;
    },
  } as unknown as PermissionGate;
  return { gate, seen };
}
