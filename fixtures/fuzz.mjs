// Fixtures for the fuzz gate, used by the Action dogfood in CI: one function that honours the never-throw boundary
// and one that crashes on the first hostile value, so the gate is seen to pass the first and fail the second.
export function tolerant(x) { try { return String(x).length; } catch { return 0; } }
export function brittle(x) { return x.length; }
