// ============================================================
//  ONLINE.JS  —  Firebase sync layer for game.html
//  Loaded as <script type="module" src="online.js"> in game.html.
//
//  CRITICAL: ES modules are ALWAYS deferred — DOMContentLoaded
//  has already fired by the time this runs.  Never wait for it.
// ============================================================

import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getDatabase, ref, get, set, push, update,
         onChildAdded, onValue, onDisconnect, increment }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

// ── Action type constants ───────────────────────────────────
const ACTION = { END_TURN: 'END_TURN', GAME_OVER: 'GAME_OVER' };

// ── Firebase init ───────────────────────────────────────────
const fbApp = initializeApp(firebaseConfig);
const auth  = getAuth(fbApp);
const db    = getDatabase(fbApp);

// ── URL params ──────────────────────────────────────────────
const params    = new URLSearchParams(window.location.search);
const ROOM_ID   = params.get('room');
const MY_PLAYER = parseInt(params.get('player')) || 0;

// ── Only activate when we have valid online params ──────────
if (ROOM_ID && (MY_PLAYER === 1 || MY_PLAYER === 2)) {
  // ES modules are deferred — DOM is already parsed, no need for DOMContentLoaded.
  onAuthStateChanged(auth, user => {
    if (!user) { window.location.href = 'index.html'; return; }
    boot(user);
  });
}

// ── Shorthand ───────────────────────────────────────────────
const $el = id => document.getElementById(id);

// ── Boot: verify room, show pre-game lobby ──────────────────
async function boot(user) {
  const roomSnap = await get(ref(db, `rooms/${ROOM_ID}`));
  if (!roomSnap.exists()) {
    alert('Room not found.'); window.location.href = 'lobby.html'; return;
  }
  const room  = roomSnap.val();
  const myUid = user.uid;

  if (MY_PLAYER === 1 && room.player1?.uid !== myUid) {
    alert('You are not Player 1 in this room.');
    window.location.href = 'lobby.html'; return;
  }
  if (MY_PLAYER === 2 && room.player2?.uid !== myUid) {
    alert('You are not Player 2 in this room.');
    window.location.href = 'lobby.html'; return;
  }

  // Render the lobby UI right away with whatever we know
  updatePregameUI(room);

  // Live subscription: fires immediately + on every change
  onValue(ref(db, `rooms/${ROOM_ID}`), snap => {
    const r = snap.val();
    if (!r) return;
    updatePregameUI(r);
    if (r.status === 'playing' && r.player1 && r.player2 && !window._matchStarted) {
      startOnlineMatch(r, user);
    }
  });
}

// ── Pre-game lobby UI ───────────────────────────────────────
function updatePregameUI(room) {
  if (!$el('pg-room-name')) return; // modal already gone (game started)

  $el('pg-room-name').textContent =
    room.name || `Room ${ROOM_ID.slice(-6).toUpperCase()}`;

  if (room.player1?.name) {
    $el('pg-name-1').textContent   = room.player1.name;
    $el('pg-status-1').textContent = '✓ JOINED';
    $el('pg-status-1').style.color = '#22dd77';
  }
  if (room.player2?.name) {
    $el('pg-name-2').textContent   = room.player2.name;
    $el('pg-status-2').textContent = '✓ JOINED';
    $el('pg-status-2').style.color = '#22dd77';
  }

  const bothPresent = !!(room.player1 && room.player2);
  const notStarted  = room.status !== 'playing';
  const startBtn    = $el('pg-start-btn');
  const msgEl       = $el('pg-msg');

  if (bothPresent && notStarted) {
    if (startBtn) startBtn.style.display = 'block';
    if (msgEl)    msgEl.textContent = 'Both players ready — click START to begin!';
    if (startBtn && !startBtn._bound) {
      startBtn._bound = true;
      startBtn.onclick = async () => {
        startBtn.disabled    = true;
        startBtn.textContent = 'STARTING…';
        const firstPlayer = Math.random() < 0.5 ? 1 : 2;
        await update(ref(db, `rooms/${ROOM_ID}`), { status: 'playing', firstPlayer });
      };
    }
  } else if (!bothPresent) {
    if (msgEl) msgEl.textContent = MY_PLAYER === 1
      ? 'Waiting for opponent to join…'
      : 'You joined! Waiting for host to start.';
  }
}

// ── Start the actual match ──────────────────────────────────
async function startOnlineMatch(room, user) {
  if (window._matchStarted) return;
  window._matchStarted = true;

  const myUid         = user.uid;
  const profileSnap   = await get(ref(db, `players/${myUid}`));
  const myProfile     = profileSnap.val() || {};
  const firstPlayer   = room.firstPlayer || 1;

  window.ONLINE.firstPlayer = firstPlayer;

  const config = {
    p1Name:       room.player1?.name   || 'Player 1',
    p2Name:       room.player2?.name   || 'Player 2',
    p1Stars:      room.player1?.stars  || 0,
    p2Stars:      room.player2?.stars  || 0,
    timeMs:       room.settings?.timeMs   || 0,
    tcMode:       room.settings?.tcMode   || 'unlimited',
    tcTurnMs:     room.settings?.tcTurnMs || 0,
    advancedMode: myProfile.advancedMode  || false,
    firstPlayer,
  };

  await waitForFn('startOnlineGame');
  window.startOnlineGame(config);

  // Wire all callbacks
  window.ONLINE.onAction  = handleLocalAction;
  window.ONLINE.onEndTurn = handleLocalEndTurn;
  window.ONLINE.onWin     = handleLocalWin;
  window.ONLINE.sendChat  = sendChat;

  // Presence tracking
  const presRef = ref(db, `rooms/${ROOM_ID}/presence/p${MY_PLAYER}`);
  await set(presRef, { online: true, uid: myUid, ts: Date.now() });
  onDisconnect(presRef).set({ online: false, uid: myUid, ts: Date.now() });
  update(ref(db, 'stats'), { online: increment(1) });
  onDisconnect(ref(db, 'stats')).update({ online: increment(-1) });

  await subscribeActions();  // await: must load existing keys before restoring state
  subscribeThinking();
  subscribeChat();
  await maybeRestoreState(firstPlayer);
}

// ── Poll until window.fn is defined ────────────────────────
function waitForFn(name, maxMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (typeof window[name] === 'function') { resolve(); return; }
      if (Date.now() - t0 > maxMs) { reject(new Error(`Timeout: window.${name}`)); return; }
      setTimeout(tick, 50);
    };
    tick();
  });
}

// ── Restore state on reconnect ──────────────────────────────
async function maybeRestoreState(firstPlayer) {
  firstPlayer = firstPlayer || window.ONLINE.firstPlayer || 1;
  const stateSnap = await get(ref(db, `rooms/${ROOM_ID}/state`));

  if (!stateSnap.exists()) {
    // Fresh game — firstPlayer sets up first
    if (MY_PLAYER === firstPlayer) {
      window.doStartMyTurn();
    } else {
      const cfg    = window.getPlayerConfig?.() || {};
      const fpName = cfg.names?.[firstPlayer] || `Player ${firstPlayer}`;
      window.showOnlineWaiting(`${fpName} is setting up their homeworld first…`);
      window.renderGame();
    }
    return;
  }

  // Reconnect: restore saved state
  try {
    const restoredG = JSON.parse(stateSnap.val().gJson);
    window.setG(restoredG);
  } catch (e) {
    console.error('State restore failed', e);
    window.doStartMyTurn(); return;
  }

  const G = window.getG();
  if (!G || G.phase === 'OVER') { window.renderGame(); return; }
  if (G.currentPlayer === MY_PLAYER) {
    window.doStartMyTurn();
  } else {
    window.showOnlineWaiting('Waiting for opponent…');
    window.renderGame();
  }
}

// ── Subscribe: opponent END_TURN actions ────────────────────
let _lastKey = null;
async function subscribeActions() {
  // Snapshot existing keys BEFORE subscribing so we skip history on startup.
  // onChildAdded fires immediately for all existing children — we only want NEW ones.
  const existingSnap = await get(ref(db, `rooms/${ROOM_ID}/actions`));
  const existingKeys = new Set(existingSnap.exists() ? Object.keys(existingSnap.val()) : []);

  onChildAdded(ref(db, `rooms/${ROOM_ID}/actions`), snap => {
    if (existingKeys.has(snap.key)) return; // skip historical actions
    const action = snap.val();
    if (!action || snap.key === _lastKey) return;
    _lastKey = snap.key;
    if (action.player === MY_PLAYER) return; // echo of own action
    processOpponentAction(action);
  });
}

function processOpponentAction(action) {
  if (action.type === ACTION.END_TURN) {
    try {
      const theirG = JSON.parse(action.gJson);
      const myG    = window.getG();
      // Preserve my timer
      if (myG?.timers) {
        theirG.timers = theirG.timers || {};
        theirG.timers[MY_PLAYER] = myG.timers[MY_PLAYER];
      }
      window.setG(theirG);
      window.doStartMyTurn();
    } catch (e) { console.error('END_TURN apply failed', e); }
  }
  // GAME_OVER is handled by local checkWin()
}

// ── Subscribe: live thinking / board state ──────────────────
function subscribeThinking() {
  onValue(ref(db, `rooms/${ROOM_ID}/thinking`), snap => {
    const data = snap.val();
    if (!data || data.player === MY_PLAYER) return;
    if (Date.now() - (data.ts || 0) > 30000) return; // stale
    applyOpponentThinking(data);
  });
}

function applyOpponentThinking(data) {
  const G = window.getG();
  if (!G || G.currentPlayer === MY_PLAYER) return; // my turn, ignore

  // Apply live board so we see moves in real time
  if (data.gJson) {
    try {
      const liveG = JSON.parse(data.gJson);
      if (G.timers) liveG.timers = { ...liveG.timers, [MY_PLAYER]: G.timers[MY_PLAYER] };
      liveG.interaction    = 'IDLE';  // never apply opponent's cursor state
      liveG.selectedShipId = null;
      window.setG(liveG);
      window.renderGame();
    } catch (e) { /* ignore parse errors */ }
  }

  const cfg     = window.getPlayerConfig?.() || {};
  const oppName = cfg.names?.[3 - MY_PLAYER] || 'Opponent';
  const labels  = {
    SHIP_SELECTED: 'selected a ship', MOVING: 'is moving', TRADING: 'is trading',
    ATTACKING: 'is attacking', BUILDING: 'is building', DISCOVERING: 'is exploring',
  };
  let msg = `${oppName} ${labels[data.interaction] || 'is thinking…'}`;
  if (data.pendingCount > 0) msg += ` (${data.pendingCount} action${data.pendingCount > 1 ? 's' : ''})`;
  window.showOpponentThinking(msg);
}

// ── Subscribe: chat ─────────────────────────────────────────
const _chatSeen = new Set();
function subscribeChat() {
  onChildAdded(ref(db, `rooms/${ROOM_ID}/chat`), snap => {
    if (_chatSeen.has(snap.key)) return;
    _chatSeen.add(snap.key);
    const msg = snap.val();
    if (msg?.player !== MY_PLAYER && typeof window.addOnlineChatMsg === 'function') {
      window.addOnlineChatMsg(msg.player, msg.text);
    }
  });
}

// ── Local action hook (game.html calls this) ────────────────
let _thinkDebounce = null;
function handleLocalAction(type) {
  if (type !== 'NOTATION') return;
  clearTimeout(_thinkDebounce);
  _thinkDebounce = setTimeout(broadcastThinking, 300);
}

function broadcastThinking() {
  const G = window.getG();
  if (!G) return;
  update(ref(db, `rooms/${ROOM_ID}/thinking`), {
    player:       MY_PLAYER,
    interaction:  G.interaction || 'IDLE',
    pendingCount: (G._pendingActions || []).length,
    gJson:        JSON.stringify(G),
    ts:           Date.now(),
  });
}

// ── Local End Turn (game.html calls this) ───────────────────
async function handleLocalEndTurn(G) {
  const gCopy = JSON.parse(JSON.stringify(G));
  await set(push(ref(db, `rooms/${ROOM_ID}/actions`)), {
    type: ACTION.END_TURN, player: MY_PLAYER,
    gJson: JSON.stringify(gCopy), ts: Date.now(),
  });
  await set(ref(db, `rooms/${ROOM_ID}/state`), {
    gJson: JSON.stringify(gCopy), updatedAt: Date.now(),
  });
  update(ref(db, `rooms/${ROOM_ID}/thinking`), {
    player: MY_PLAYER, interaction: 'IDLE', pendingCount: 0, ts: Date.now(),
  });
}

// ── Local Win (game.html calls this) ───────────────────────
async function handleLocalWin(winner) {
  await set(push(ref(db, `rooms/${ROOM_ID}/actions`)), {
    type: ACTION.GAME_OVER, player: MY_PLAYER, winner, ts: Date.now(),
  });
  await update(ref(db, `rooms/${ROOM_ID}`), {
    status: 'finished', winner, finishedAt: Date.now(),
  });
  await update(ref(db, 'stats'), { games: increment(1) });

  // Stats update
  const roomSnap = await get(ref(db, `rooms/${ROOM_ID}`));
  const room     = roomSnap.val();
  if (!room?.player1?.uid || !room?.player2?.uid) return;

  const [s1, s2] = await Promise.all([
    get(ref(db, `players/${room.player1.uid}`)),
    get(ref(db, `players/${room.player2.uid}`)),
  ]);
  const p1 = s1.val() || {}, p2 = s2.val() || {};
  const wIsP1 = winner === 1;
  const wUid  = wIsP1 ? room.player1.uid : room.player2.uid;
  const lUid  = wIsP1 ? room.player2.uid : room.player1.uid;
  const wP    = wIsP1 ? p1 : p2;
  const lP    = wIsP1 ? p2 : p1;

  const TIERS = [0,5,10,15,20,25,30,35,40,45];
  const tier  = s => TIERS.filter(t => s >= t).length - 1;
  const wS    = wP.stars || 0, lS = lP.stars || 0;
  const award = tier(lS) > tier(wS) ? 2 : 1;

  const wElo = wP.elo || 1200, lElo = lP.elo || 1200;
  const exp   = 1 / (1 + Math.pow(10, (lElo - wElo) / 400));
  const delta = Math.round(32 * (1 - exp));

  await update(ref(db, `players/${wUid}`), { stars: wS + award, wins:  increment(1), elo: wElo + delta });
  await update(ref(db, `players/${lUid}`), { losses: increment(1), elo: Math.max(100, lElo - delta) });
  await set(push(ref(db, `matchHistory/${wUid}`)), { result:'win',  opponentName: lP.name||'Opponent', starsAwarded: award, ts: Date.now() });
  await set(push(ref(db, `matchHistory/${lUid}`)), { result:'loss', opponentName: wP.name||'Opponent', starsAwarded: 0,     ts: Date.now() });
}

// ── Send chat ───────────────────────────────────────────────
async function sendChat(text) {
  if (!text?.trim()) return;
  await set(push(ref(db, `rooms/${ROOM_ID}/chat`)), {
    player: MY_PLAYER, text: text.trim(), ts: Date.now(),
  });
}
