// Step 10: single source of truth for history limits. Nothing here touches
// pixels — history stores serializable editor state only (§21 memory rule).

export const MAX_HISTORY = 50;
export const HISTORY_VERSION = 1;
// Continuous edits (slider drags, typing, layer moves) coalesce into one
// history entry when they share a label inside this window (§10, §62).
export const COALESCE_MS = 700;
