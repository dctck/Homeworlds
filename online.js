// ── Helper ──────────────────────────────────────────────────
function id(x) { return document.getElementById(x); }

// ── Main boot ────────────────────────────────────────────────
async function boot(user) {
  const roomSnap = await get(ref(db, `rooms/${ROOM_ID}`));
  if (!roomSnap.exists()) {
    alert('Room not found. Returning to lobby.');
    window.location.href = 'lobby.html'; return;
  }
  const room = roomSnap.val();
  const myUid = user.uid;
  if (MY_PLAYER === 1 && room.player1?.uid !== myUid) {
    alert('You are not Player 1 in this room.');
    window.location.href = 'lobby.html'; return;
  }
  if (MY_PLAYER === 2 && room.player2?.uid !== myUid) {
    alert('You are not Player 2 in this room.');
    window.location.href = 'lobby.html'; return;
  }

  updatePregameUI(room);

  // Subscribe to room — when status becomes 'playing', start the match
  onValue(ref(db, `rooms/${ROOM_ID}`), snap => {
    const r = snap.val();
    if (!r) return;
    updatePregameUI(r);
    if (r.status === 'playing' && r.player1 && r.player2) {
      startOnlineMatch(r, user);
    }
  });
}

function updatePregameUI(room) {
  if (!id('pg-room-name')) return; // modal already gone
  if (id('pg-room-name')) id('pg-room-name').textContent = room.name || `Room ${ROOM_ID.slice(-6)}`;
  if (room.player1) {
    if (id('pg-name-1'))   id('pg-name-1').textContent   = room.player1.name || 'Player 1';
    if (id('pg-status-1')) { id('pg-status-1').textContent = '✓ JOINED'; id('pg-status-1').style.color = '#22dd77'; }
  }
  if (room.player2) {
    if (id('pg-name-2'))   id('pg-name-2').textContent   = room.player2.name || 'Player 2';
    if (id('pg-status-2')) { id('pg-status-2').textContent = '✓ JOINED'; id('pg-status-2').style.color = '#22dd77'; }
  }
  const bothPresent = room.player1 && room.player2;
  const notStarted  = room.status !== 'playing';
  const startBtn    = id('pg-start-btn');
  const msgEl       = id('pg-msg');
  if (bothPresent && notStarted && startBtn) {
    startBtn.style.display = 'block';
    if (msgEl) msgEl.textContent = 'Both players ready — click START to begin!';
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      startBtn.textContent = 'STARTING…';
      const firstPlayer = Math.random() < 0.5 ? 1 : 2;
      await update(ref(db, `rooms/${ROOM_ID}`), { status: 'playing', firstPlayer });
    };
  } else if (!bothPresent && msgEl) {
    msgEl.textContent = MY_PLAYER === 1
      ? 'Waiting for opponent to join…'
      : 'You joined! Waiting for host to start.';
  }
}

async function startOnlineMatch(room, user) {
  if (window._matchStarted) return;
  window._matchStarted = true;

  const myUid = user.uid;
  const myProfileSnap = await get(ref(db, `players/${myUid}`));
  const myProfile = myProfileSnap.val() || {};
  const firstPlayer = room.firstPlayer || 1;
  window.ONLINE.firstPlayer = firstPlayer;

  const config = {
    p1Name:      room.player1?.name  || 'Player 1',
    p2Name:      room.player2?.name  || 'Player 2',
    p1Stars:     room.player1?.stars || 0,
    p2Stars:     room.player2?.stars || 0,
    timeMs:      room.settings?.timeMs   || 0,
    tcMode:      room.settings?.tcMode   || 'unlimited',
    tcTurnMs:    room.settings?.tcTurnMs || 0,
    advancedMode: myProfile.advancedMode || false,
    firstPlayer,
  };

  await waitForFn('startOnlineGame');
  window.startOnlineGame(config);

  window.ONLINE.onAction  = handleLocalAction;
  window.ONLINE.onEndTurn = handleLocalEndTurn;
  window.ONLINE.onWin     = handleLocalWin;
  window.ONLINE.sendChat  = sendChat;

  const presenceRef = ref(db, `rooms/${ROOM_ID}/presence/p${MY_PLAYER}`);
  await set(presenceRef, { online: true, uid: myUid, ts: Date.now() });
  onDisconnect(presenceRef).set({ online: false, uid: myUid, ts: Date.now() });
  update(ref(db, 'stats'), { online: increment(1) });
  onDisconnect(ref(db, 'stats')).update({ online: increment(-1) });

  subscribeActions();
  subscribeThinking();
  subscribeChat();
  await maybeRestoreState(firstPlayer);
}

// ── Wait for a window function to be defined ────────────────
function waitForFn(name, maxMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (typeof window[name] === 'function') { resolve(); return; }
      if (Date.now() - start > maxMs) { reject(new Error(`Timeout waiting for window.${name}`)); return; }
      setTimeout(check, 50);
    };
    check();
  });
}

// ── Restore state on reconnect ───────────────────────────────
async function maybeRestoreState(firstPlayer) {
  firstPlayer = firstPlayer || window.ONLINE.firstPlayer || 1;
  const stateSnap = await get(ref(db, `rooms/${ROOM_ID}/state`));
  if (!stateSnap.exists()) {
    // Fresh game
    if (MY_PLAYER === firstPlayer) {

      window.doStartMyTurn(); // remove loading, show board, it's my setup turn
    } else {
      const firstPlayerName = firstPlayer === 1
        ? (window.getPlayerConfig?.()?.names[1] || 'Player 1')
        : (window.getPlayerConfig?.()?.names[2] || 'Player 2');
      window.showOnlineWaiting(`${firstPlayerName} is setting up their homeworld first…`);
      window.renderGame();
    }
    return;
  }

  // Restore committed game state
  const savedState = stateSnap.val();
  try {
    const restoredG = JSON.parse(savedState.gJson);
    window.setG(restoredG);
  } catch (e) {
    console.error('Failed to parse saved state', e);
    window.doStartMyTurn();
    return;
  }

  const G = window.getG();

  if (G.phase === 'OVER') {
    // Game already finished — just render
    window.renderGame();
    return;
  }

  // Is it my turn?
  if (G.currentPlayer === MY_PLAYER) {
    window.doStartMyTurn();
  } else {
    window.showOnlineWaiting(`Waiting for opponent's turn…`);
    window.renderGame();
  }
}

// ── Subscribe to opponent's committed END_TURN actions ───────
let _lastProcessedKey = null;

function subscribeActions() {
  // onChildAdded fires for all existing + new children
  onChildAdded(ref(db, `rooms/${ROOM_ID}/actions`), (snap) => {
    const action = snap.val();
    if (!action) return;

    // Skip actions from myself (I already applied them locally)
    if (action.player === MY_PLAYER) {
      _lastProcessedKey = snap.key;
      return;
    }

    // Skip if already processed
    if (snap.key === _lastProcessedKey) return;
    _lastProcessedKey = snap.key;

    processOpponentAction(action);
  });
}

function processOpponentAction(action) {
  if (action.type === ACTION.END_TURN) {
    // Restore opponent's committed G snapshot
    try {
      const theirG = JSON.parse(action.gJson);

      // Preserve my timer state — don't let opponent dictate my clock
      const myCurrentG = window.getG();
      if (myCurrentG && myCurrentG.timers) {
        theirG.timers = theirG.timers || {};
        // Keep the timer tick going by merging in the live timer
        theirG.timers[MY_PLAYER] = myCurrentG.timers[MY_PLAYER];
      }

      window.setG(theirG);
      window.doStartMyTurn();
    } catch (e) {
      console.error('Failed to apply opponent END_TURN', e);
    }
  } else if (action.type === ACTION.GAME_OVER) {
    // Opponent declared game over (they saw the win condition)
    // Our local checkWin() should also catch this — but handle it here too
    const G = window.getG();
    if (G && G.phase !== 'OVER') {
      window.renderGame();
    }
  }
}

// ── Subscribe to thinking state ──────────────────────────────
function subscribeThinking() {
  onValue(ref(db, `rooms/${ROOM_ID}/thinking`), snap => {
    const data = snap.val();
    if (!data || data.player === MY_PLAYER) return; // ignore own broadcasts
    const age = Date.now() - (data.ts || 0);
    if (age > 30000) return; // ignore stale data (>30s old)
    showOpponentThinkingText(data);
  });
}

function showOpponentThinkingText(data) {
  const G = window.getG();
  if (!G || G.currentPlayer === MY_PLAYER) return; // it IS my turn, don't apply

  // Apply live board state so we see opponent's moves in real-time
  if (data.gJson) {
    try {
      const liveG = JSON.parse(data.gJson);
      // Preserve my timer
      if (G.timers) liveG.timers = { ...liveG.timers, [MY_PLAYER]: G.timers[MY_PLAYER] };
      // Keep interaction locked — this is a preview, not my turn
      liveG.interaction = 'IDLE';
      liveG.selectedShipId = null;
      window.setG(liveG);
      window.renderGame();
    } catch(e) { /* ignore parse errors */ }
  }

  const oppName = window.getPlayerConfig?.()?.names[3 - MY_PLAYER] || 'Opponent';
  let msg = `${oppName} is thinking…`;
  if (data.interaction === 'SHIP_SELECTED') msg = `${oppName} selected a ship`;
  if (data.interaction === 'MOVING')        msg = `${oppName} is moving`;
  if (data.interaction === 'TRADING')       msg = `${oppName} is trading`;
  if (data.interaction === 'ATTACKING')     msg = `${oppName} is attacking`;
  if (data.interaction === 'BUILDING')      msg = `${oppName} is building`;
  if (data.interaction === 'DISCOVERING')   msg = `${oppName} is exploring`;
  if (data.pendingCount > 0)               msg += ` (${data.pendingCount} action${data.pendingCount>1?'s':''})`;

  window.showOpponentThinking(msg);
}

// ── Subscribe to chat ─────────────────────────────────────────
let _chatKeys = new Set();
function subscribeChat() {
  onChildAdded(ref(db, `rooms/${ROOM_ID}/chat`), snap => {
    if (_chatKeys.has(snap.key)) return;
    _chatKeys.add(snap.key);
    const msg = snap.val();
    if (!msg) return;
    if (msg.player !== MY_PLAYER) {
      // Opponent message — inject into game's chat system
      if (typeof window.addOnlineChatMsg === 'function') {
        window.addOnlineChatMsg(msg.player, msg.text);
      }
    }
  });
}

// ── Handle local actions (called by game.html via window.ONLINE.onAction) ──
let _thinkingDebounce = null;
function handleLocalAction(type, params) {
  if (type === 'NOTATION') {
    // Debounce: push full G state 300ms after last action for live board
    clearTimeout(_thinkingDebounce);
    _thinkingDebounce = setTimeout(() => broadcastThinking(), 300);
  }
}

function broadcastThinking() {
  const G = window.getG();
  if (!G) return;
  update(ref(db, `rooms/${ROOM_ID}/thinking`), {
    player:       MY_PLAYER,
    interaction:  G.interaction || 'IDLE',
    pendingCount: (G._pendingActions || []).length,
    gJson:        JSON.stringify(G),   // full board state for live preview
    ts:           Date.now(),
  });
}

// ── Handle local End Turn (called by game.html) ──────────────
async function handleLocalEndTurn(G) {
  // Clean up timer state before serialising (don't push live timer ticks)
  const gCopy = JSON.parse(JSON.stringify(G));

  // Push committed turn snapshot as an action
  const actionRef = push(ref(db, `rooms/${ROOM_ID}/actions`));
  await set(actionRef, {
    type:    ACTION.END_TURN,
    player:  MY_PLAYER,
    gJson:   JSON.stringify(gCopy),
    turn:    gCopy.currentTurn,
    ts:      Date.now(),
  });

  // Also write the state snapshot for fast reconnect
  await set(ref(db, `rooms/${ROOM_ID}/state`), {
    gJson:      JSON.stringify(gCopy),
    turn:       gCopy.currentTurn,
    updatedAt:  Date.now(),
  });

  // Clear thinking broadcast
  update(ref(db, `rooms/${ROOM_ID}/thinking`), {
    player: MY_PLAYER, interaction: 'IDLE', pendingCount: 0, ts: Date.now(),
  });
}

// ── Handle win (called by game.html via window.ONLINE.onWin) ──
async function handleLocalWin(winner) {
  const G = window.getG();

  // Push game over action
  await push(ref(db, `rooms/${ROOM_ID}/actions`), {
    type:    ACTION.GAME_OVER,
    player:  MY_PLAYER,
    winner,
    ts:      Date.now(),
  });

  // Mark room as finished
  await update(ref(db, `rooms/${ROOM_ID}`), {
    status:     'finished',
    winner,
    finishedAt: Date.now(),
  });

  // Update stats
  await update(ref(db, 'stats'), { games: increment(1) });

  // Update ELO + stars for both players
  const roomSnap = await get(ref(db, `rooms/${ROOM_ID}`));
  const room     = roomSnap.val();
  if (!room) return;

  const p1Uid = room.player1?.uid;
  const p2Uid = room.player2?.uid;
  if (!p1Uid || !p2Uid) return;

  const [p1Snap, p2Snap] = await Promise.all([
    get(ref(db, `players/${p1Uid}`)),
    get(ref(db, `players/${p2Uid}`)),
  ]);
  const p1 = p1Snap.val() || {};
  const p2 = p2Snap.val() || {};

  const winnerIsP1 = winner === 1;
  const winnerProfile = winnerIsP1 ? p1 : p2;
  const loserProfile  = winnerIsP1 ? p2 : p1;
  const winnerUid     = winnerIsP1 ? p1Uid : p2Uid;
  const loserUid      = winnerIsP1 ? p2Uid : p1Uid;

  // Stars: +2 if beating higher tier, +1 otherwise
  const TIERS = [0,5,10,15,20,25,30,35,40,45];
  function tierIdx(s){return TIERS.filter(t=>s>=t).length - 1;}
  const wStars = winnerProfile.stars || 0;
  const lStars = loserProfile.stars  || 0;
  const starsAwarded = tierIdx(lStars) > tierIdx(wStars) ? 2 : 1;

  // ELO (stored but not shown — used for internal ranking accuracy)
  const wElo = winnerProfile.elo || 1200;
  const lElo = loserProfile.elo  || 1200;
  const k    = 32;
  const exp  = 1 / (1 + Math.pow(10, (lElo - wElo) / 400));
  const eloDelta = Math.round(k * (1 - exp));

  // Write winner
  await update(ref(db, `players/${winnerUid}`), {
    stars:  (wStars + starsAwarded),
    wins:   increment(1),
    elo:    wElo + eloDelta,
  });

  // Write loser
  await update(ref(db, `players/${loserUid}`), {
    losses: increment(1),
    elo:    Math.max(100, lElo - eloDelta),
  });

  // Write match history for both
  const matchBase = { timestamp: Date.now(), opponentName: '', starsAwarded: 0 };
  await push(ref(db, `matchHistory/${winnerUid}`), {
    ...matchBase,
    result:       'win',
    opponentName: loserProfile.name  || 'Opponent',
    starsAwarded,
    eloDelta:     `+${eloDelta}`,
  });
  await push(ref(db, `matchHistory/${loserUid}`), {
    ...matchBase,
    result:       'loss',
    opponentName: winnerProfile.name || 'Opponent',
    starsAwarded: 0,
    eloDelta:     `-${eloDelta}`,
  });

  // Save to room for display
  await update(ref(db, `rooms/${ROOM_ID}`), { eloDeltas: { [winnerUid]: eloDelta, [loserUid]: -eloDelta } });
}

// ── Send chat ────────────────────────────────────────────────
async function sendChat(text) {
  if (!text.trim()) return;
  await push(ref(db, `rooms/${ROOM_ID}/chat`), {
    player: MY_PLAYER,
    text:   text.trim(),
    ts:     Date.now(),
  });
}
