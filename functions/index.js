// ============================================================
//  HOMEWORLDS — Firebase Cloud Functions
//  Runtime: Node 18 (firebase-functions v4+)
//
//  SETUP STEPS:
//  1. firebase login
//  2. firebase init functions  (pick existing project, Node 18, ESLint no)
//  3. npm install firebase-functions@latest firebase-admin@latest
//  4. Copy this file to functions/index.js
//  5. firebase deploy --only functions
//
//  Budget notes: well within Blaze free tier
//  (~2M free invocations/month, this game uses hundreds at most)
// ============================================================

const { onValueWritten } = require('firebase-functions/v2/database');
const { initializeApp }  = require('firebase-admin/app');
const { getDatabase }    = require('firebase-admin/database');

initializeApp();

// ── ELO calculation ──────────────────────────────────────────
function calcEloDelta(myElo, oppElo, actual /* 0, 0.5, or 1 */) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (oppElo - myElo) / 400));
  return Math.round(K * (actual - expected));
}

// ── Trigger: fires whenever a room node is written ───────────
//  Only acts when status flips to 'archived'.
exports.onRoomStatusChange = onValueWritten(
  { ref: 'rooms/{roomId}', region: 'us-central1' },
  async event => {
    const after  = event.data.after.val();
    const before = event.data.before.val();

    // Guard: only run when a game just ended
    if (!after || after.status !== 'archived') return null;
    // Idempotency: don't re-process if CF already ran for this room
    if (after.cfProcessed) return null;

    const roomId = event.params.roomId;
    const db     = getDatabase();
    const roomRef = db.ref(`rooms/${roomId}`);

    // Lock immediately to prevent concurrent duplicate runs
    await roomRef.update({ cfProcessed: true });

    const winner = after.winner;   // 1 | 2 | 0 (draw)
    const isDraw = winner === 0;

    const p1Uid  = after.player1?.uid;
    const p2Uid  = after.player2?.uid;
    const p1Name = after.player1?.name || 'Player 1';
    const p2Name = after.player2?.name || 'Player 2';

    if (!p1Uid || !p2Uid) {
      console.warn(`[CF] Room ${roomId}: missing player UIDs`);
      return null;
    }

    // ── Read current player records ────────────────────────
    const [snap1, snap2] = await Promise.all([
      db.ref(`players/${p1Uid}`).get(),
      db.ref(`players/${p2Uid}`).get(),
    ]);
    const p1 = snap1.val() || {};
    const p2 = snap2.val() || {};
    const elo1 = p1.elo || 1200;
    const elo2 = p2.elo || 1200;

    // ── Extract game log from stored gJson ──────────────────
    let moves = [];
    try {
      const gameSnap = await db.ref(`rooms/${roomId}/game`).get();
      const gJson    = gameSnap.val()?.gJson;
      if (gJson) {
        const g = JSON.parse(gJson);
        (g.log || []).forEach(entry => {
          (entry.actions || []).forEach(action => {
            moves.push({ turn: entry.turn, player: entry.player, action });
          });
        });
      }
    } catch(e) {
      console.warn('[CF] Could not read game log:', e.message);
    }

    // ── Archive game record (push = auto-ID, no counter race) 
    const gameRecord = {
      winner,
      isDraw,
      playedAt: Date.now(),
      players: {
        1: { uid: p1Uid, name: p1Name, eloAtGame: elo1 },
        2: { uid: p2Uid, name: p2Name, eloAtGame: elo2 },
      },
      moves,  // [{turn, player, action}] — full deterministic replay source
    };
    const gameRef = await db.ref('gamesPlayed').push(gameRecord);
    const gameId  = gameRef.key;

    // Write gameId back so lobby review links work
    await roomRef.update({ archivedGameId: gameId });

    // ── Calculate ELO and star deltas ───────────────────────
    let d1, d2, s1, s2;   // elo deltas, star deltas

    if (isDraw) {
      d1 = calcEloDelta(elo1, elo2, 0.5);
      d2 = calcEloDelta(elo2, elo1, 0.5);
      s1 = 0; s2 = 0;
    } else {
      const isUpset = (winner === 1) ? (elo1 < elo2) : (elo2 < elo1);
      d1 = calcEloDelta(elo1, elo2, winner === 1 ? 1 : 0);
      d2 = calcEloDelta(elo2, elo1, winner === 2 ? 1 : 0);
      s1 = winner === 1 ? (isUpset ? 2 : 1) : -1;
      s2 = winner === 2 ? (isUpset ? 2 : 1) : -1;
    }

    const newElo1  = Math.max(100, elo1 + d1);
    const newElo2  = Math.max(100, elo2 + d2);
    const newStar1 = Math.max(0, (p1.stars || 0) + s1);
    const newStar2 = Math.max(0, (p2.stars || 0) + s2);

    const hist1 = Array.isArray(p1.recentGames) ? p1.recentGames : [];
    const hist2 = Array.isArray(p2.recentGames) ? p2.recentGames : [];

    // ── Write both player records atomically ────────────────
    await Promise.all([
      db.ref(`players/${p1Uid}`).update({
        elo:         newElo1,
        stars:       newStar1,
        wins:        (p1.wins   || 0) + (!isDraw && winner === 1 ? 1 : 0),
        losses:      (p1.losses || 0) + (!isDraw && winner === 2 ? 1 : 0),
        draws:       (p1.draws  || 0) + (isDraw ? 1 : 0),
        hasUnseenResult: true,
        recentGames: [{ gameId, result: isDraw ? 'draw' : winner === 1 ? 'win' : 'loss',
                        opponent: p2Name, starDelta: s1, eloChange: d1, playedAt: Date.now() },
                      ...hist1].slice(0, 20),
      }),
      db.ref(`players/${p2Uid}`).update({
        elo:         newElo2,
        stars:       newStar2,
        wins:        (p2.wins   || 0) + (!isDraw && winner === 2 ? 1 : 0),
        losses:      (p2.losses || 0) + (!isDraw && winner === 1 ? 1 : 0),
        draws:       (p2.draws  || 0) + (isDraw ? 1 : 0),
        hasUnseenResult: true,
        recentGames: [{ gameId, result: isDraw ? 'draw' : winner === 2 ? 'win' : 'loss',
                        opponent: p1Name, starDelta: s2, eloChange: d2, playedAt: Date.now() },
                      ...hist2].slice(0, 20),
      }),
    ]);

    console.log(`[CF] Archived game ${gameId}. winner=${winner} | P1 ${elo1}→${newElo1} (${d1>0?'+':''}${d1}) | P2 ${elo2}→${newElo2} (${d2>0?'+':''}${d2})`);
    return null;
  }
);
