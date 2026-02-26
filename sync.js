// ============================================================
//  SYNC.JS
//  Firebase real-time layer. Imported by game.html.
//
//  How it works:
//  - Every action is pushed to /rooms/{roomId}/actions (append-only)
//  - On load, replay all existing actions from scratch to rebuild state
//  - Subscribe to new actions → apply them live as opponent moves
//  - /rooms/{roomId}/thinking → live broadcast of current player's
//    interaction state so opponent can see what they're considering
// ============================================================

import { getDatabase, ref, push, onChildAdded,
         get, update, onValue, off }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

// ── Init ─────────────────────────────────────────────────────
let _db       = null;
let _roomId   = null;
let _myPlayer = null;   // 1 or 2
let _onAction = null;   // callback(actionObj) when opponent acts
let _onThink  = null;   // callback(thinkingObj) for live thinking display
let _onRoomUpdate = null; // callback(roomMeta)
let _unsubActions = null;
let _unsubThinking = null;
let _unsubRoom = null;

export function initSync(db, roomId, myPlayer) {
  _db       = db;
  _roomId   = roomId;
  _myPlayer = myPlayer;
}

// ── Push a single action to Firebase ─────────────────────────
// Called after every local action (move, build, trade, etc.)
export async function pushAction(actionObj) {
  if (!_db || !_roomId) return;
  await push(ref(_db, `rooms/${_roomId}/actions`), {
    ...actionObj,
    player:    _myPlayer,
    timestamp: Date.now(),
  });
}

// ── Push end-turn signal ──────────────────────────────────────
export async function pushEndTurn() {
  await pushAction({ type: 'END_TURN' });
  // Clear thinking state
  await update(ref(_db, `rooms/${_roomId}/thinking`), {
    interaction: 'IDLE', pendingActions: [], selectedShipId: null,
    player: _myPlayer, timestamp: Date.now(),
  });
}

// ── Broadcast current thinking state (live for opponent) ──────
// Call this on every state change during your turn.
// Opponent sees it in real time as a "they're considering..." indicator.
export async function broadcastThinking(G) {
  if (!_db || !_roomId) return;
  try {
    await update(ref(_db, `rooms/${_roomId}/thinking`), {
      player:         _myPlayer,
      interaction:    G.interaction,
      pendingActions: G._pendingActions || [],
      selectedShipId: G.selectedShipId || null,
      timestamp:      Date.now(),
    });
  } catch (_) { /* non-critical */ }
}

// ── Load all existing actions (replay on join/refresh) ────────
// Returns array of action objects in order.
export async function loadActions() {
  if (!_db || !_roomId) return [];
  const snap = await get(ref(_db, `rooms/${_roomId}/actions`));
  if (!snap.exists()) return [];
  return Object.values(snap.val()).sort((a, b) => a.timestamp - b.timestamp);
}

// ── Subscribe to new actions from opponent ────────────────────
// onActionCb is called for each new action pushed while subscribed.
// Skips actions from _myPlayer (we already applied those locally).
export function subscribeActions(onActionCb, skipMine = true) {
  if (!_db || !_roomId) return;
  _onAction = onActionCb;

  // onChildAdded fires for ALL existing children first, then new ones.
  // We track a "loaded" flag so we only call back for genuinely new ones.
  let initialLoadDone = false;
  let existingKeys = new Set();

  // First, get all existing keys so we can skip them
  get(ref(_db, `rooms/${_roomId}/actions`)).then(snap => {
    if (snap.exists()) {
      Object.keys(snap.val()).forEach(k => existingKeys.add(k));
    }
    initialLoadDone = true;
  });

  const actionsRef = ref(_db, `rooms/${_roomId}/actions`);
  _unsubActions = onChildAdded(actionsRef, (snap) => {
    if (!initialLoadDone) return; // still loading existing
    if (existingKeys.has(snap.key)) return; // was already there
    const action = snap.val();
    if (skipMine && action.player === _myPlayer) return;
    _onAction && _onAction(action);
  });
}

// ── Subscribe to opponent's live thinking state ───────────────
export function subscribeThinking(onThinkCb) {
  if (!_db || !_roomId) return;
  _onThink = onThinkCb;
  const thinkRef = ref(_db, `rooms/${_roomId}/thinking`);
  _unsubThinking = onValue(thinkRef, (snap) => {
    if (!snap.exists()) return;
    const t = snap.val();
    // Only show if it's the opponent's thinking (not our own echoed back)
    if (t.player === _myPlayer) return;
    _onThink && _onThink(t);
  });
}

// ── Subscribe to room metadata changes ───────────────────────
export function subscribeRoom(onRoomCb) {
  if (!_db || !_roomId) return;
  _unsubRoom = onValue(ref(_db, `rooms/${_roomId}`), (snap) => {
    if (snap.exists()) onRoomCb(snap.val());
  });
}

// ── Unsubscribe all listeners ─────────────────────────────────
export function unsubscribeAll() {
  if (_unsubActions)  { off(ref(_db, `rooms/${_roomId}/actions`),  'child_added', _unsubActions); }
  if (_unsubThinking) { off(ref(_db, `rooms/${_roomId}/thinking`), 'value',       _unsubThinking); }
  if (_unsubRoom)     { off(ref(_db, `rooms/${_roomId}`),          'value',       _unsubRoom); }
}

// ── Mark game over in room metadata ──────────────────────────
export async function pushGameOver(winnerPlayer, eloDeltas) {
  if (!_db || !_roomId) return;
  await update(ref(_db, `rooms/${_roomId}`), {
    status:    'finished',
    winner:    winnerPlayer,
    finishedAt: Date.now(),
    eloDeltas,
  });
}

// ── Fetch room metadata once ──────────────────────────────────
export async function getRoomMeta() {
  if (!_db || !_roomId) return null;
  const snap = await get(ref(_db, `rooms/${_roomId}`));
  return snap.exists() ? snap.val() : null;
}
