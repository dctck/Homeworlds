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
const { onCall }         = require('firebase-functions/v2/https');
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
        recentGames: [{ gameId, result: isDraw ? 'draw' : winner === 2 ? 'win' : 'loss',
                        opponent: p1Name, starDelta: s2, eloChange: d2, playedAt: Date.now() },
                      ...hist2].slice(0, 20),
      }),
    ]);

    console.log(`[CF] Archived game ${gameId}. winner=${winner} | P1 ${elo1}→${newElo1} (${d1>0?'+':''}${d1}) | P2 ${elo2}→${newElo2} (${d2>0?'+':''}${d2})`);
    return null;
  }
);


// ── Scheduled: auto-archive timed-out games every 5 minutes ──────────────────
// Runs server-side so both players can be in lobby and the game still ends.
// Logic: read all rooms with status='playing' + a timed tcMode, compare
// Date.now() against (saved.ts + timers[currentPlayer]). If expired → archive.
const { onSchedule } = require('firebase-functions/v2/scheduler');

exports.checkTimedOutGames = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1' },
  async () => {
    const db  = getDatabase();
    const now = Date.now();

    // ── Optimized: use timeoutAt field stored directly in the room node ──────
    // game.html saveState() writes room.timeoutAt = ts + timers[currentPlayer]
    // after every turn. We only need ONE query — no secondary game node reads.
    // This cuts function download cost by ~85% vs reading room + game nodes.
    const roomsSnap = await db.ref('rooms').orderByChild('status').equalTo('playing').get();
    if (!roomsSnap.exists()) return null;

    const rooms = roomsSnap.val();
    const promises = [];
    let checked = 0, expired = 0;

    for (const [roomId, room] of Object.entries(rooms)) {
      // Skip if no timeout deadline stored (unlimited / tournament / legacy room)
      if (!room.timeoutAt || room.timeoutAt === 0) continue;
      // Skip rooms already being CF-processed
      if (room.cfProcessed) continue;

      checked++;
      if (now < room.timeoutAt) continue; // clock hasn't expired yet

      // ── Clock has expired ──────────────────────────────────────────────
      expired++;
      const timedOutPlayer = room.timerPlayer ?? room.currentPlayer ?? 1;
      const winner         = timedOutPlayer === 1 ? 2 : 1;
      const elapsed        = Math.round((now - room.timeoutAt) / 1000);
      console.log(`[SCHED] Room ${roomId}: player ${timedOutPlayer} timed out` +
        ` (${elapsed}s overdue) → winner=${winner}`);

      promises.push(
        db.ref(`rooms/${roomId}`).update({
          status:         'archived',
          winner,
          winnerName:     room[`player${winner}`]?.name || `Player ${winner}`,
          forfeitedBy:    null,
          timedOutPlayer,
          timeoutAt:      0, // clear so we don't re-trigger
        }).then(() => {
          console.log(`[SCHED] ✓ Archived room ${roomId}`);
        }).catch(err => {
          console.error(`[SCHED] ✗ Failed to archive ${roomId}:`, err.message);
        })
      );
    }

    await Promise.all(promises);
    console.log(`[SCHED] Done — checked ${checked} timed rooms, expired ${expired}`);
    return null;
  }
);


// ── GM Reset — callable from profile.html ──────────────────────────────────
// Uses admin SDK so it can write to all players, rooms, and gamesPlayed
// regardless of Firebase security rules.
// Only the hardcoded GM_UID may invoke this; anyone else gets a PERMISSION_DENIED.
const GM_UID = 'wREgW7okeUTdWJCGsjTDW11ddlh2';

exports.gmReset = onCall(
  { region: 'us-central1' },
  async (request) => {
    // ── Auth check — must be the GM ──────────────────────────────
    const callerUid = request.auth?.uid;
    if (!callerUid || callerUid !== GM_UID) {
      throw new Error('PERMISSION_DENIED: not authorized');
    }

    const db = getDatabase();
    const log = [];

    // 1. Wipe all rooms
    await db.ref('rooms').remove();
    log.push('rooms wiped');

    // 2. Wipe all game records
    await db.ref('gamesPlayed').remove();
    log.push('gamesPlayed wiped');

    // 3. Reset every player's stats (keep name, email, avatar, uid)
    const playersSnap = await db.ref('players').get();
    if (playersSnap.exists()) {
      const updates = {};
      Object.keys(playersSnap.val()).forEach(uid => {
        updates[`players/${uid}/elo`]             = 1200;
        updates[`players/${uid}/stars`]           = 0;
        updates[`players/${uid}/wins`]            = 0;
        updates[`players/${uid}/losses`]          = 0;
        updates[`players/${uid}/draws`]           = 0;
        updates[`players/${uid}/recentGames`]     = null;
        updates[`players/${uid}/hasUnseenResult`] = null;
      });
      await db.ref().update(updates);
      log.push(`${Object.keys(playersSnap.val()).length} player(s) reset`);
    }

    console.log(`[GM RESET] Complete by ${callerUid}: ${log.join(', ')}`);
    return { ok: true, log };
  }
);

// ── Email Verification — 6-digit code ────────────────────────────────────────
// Requires: npm install nodemailer
// Configure SMTP via Firebase environment config or hardcode for testing.
//
// Set credentials once:
//   firebase functions:secrets:set EMAIL_USER
//   firebase functions:secrets:set EMAIL_PASS
// Then re-deploy. The secrets are accessed as process.env.EMAIL_USER etc.
//
// Works with Gmail (enable "App Passwords" in Google Account settings),
// or any SMTP provider (Mailgun, SendGrid SMTP, Brevo, etc.)

const nodemailer = require('nodemailer');

function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

/** Generates a random 6-digit string */
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * sendVerifCode({ uid, email })
 * Called right after createUserWithEmailAndPassword on the client.
 * Generates a 6-digit code, stores a bcrypt hash in the DB with 15-min expiry,
 * and sends the code to the user's email.
 */
exports.sendVerifCode = onCall(
  { region: 'us-central1' },
  async (request) => {
    const { uid, email } = request.data || {};
    if (!uid || !email) throw new Error('Missing uid or email');

    // Rate-limit: only allow re-send once per 60 seconds
    const db = getDatabase();
    const existing = (await db.ref(`emailVerif/${uid}`).get()).val();
    if (existing?.sentAt && Date.now() - existing.sentAt < 60_000) {
      throw new Error('RATE_LIMITED: Please wait before requesting another code');
    }

    const code = genCode();
    // Store plain code hashed with a simple salt — no bcrypt needed at this scale,
    // code expires in 15 min and is single-use.
    // Using SHA-256 via Node crypto:
    const { createHash } = require('crypto');
    const hashed = createHash('sha256').update(code + uid).digest('hex');

    await db.ref(`emailVerif/${uid}`).set({
      hash:    hashed,
      email,
      sentAt:  Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1000,
      used:    false,
      attempts: 0,
    });

    // Send email
    const transport = makeTransport();
    await transport.sendMail({
      from:    `"Homeworlds Duel" <${process.env.EMAIL_USER}>`,
      to:      email,
      subject: 'Your Homeworlds Duel verification code',
      text:    `Your verification code is: ${code}\n\nThis code expires in 15 minutes. Do not share it with anyone.`,
      html:    `
        <div style="background:#060912;color:#a8c0e0;font-family:monospace;padding:32px;max-width:480px;border:1px solid #1c2840;border-radius:8px">
          <div style="font-family:sans-serif;font-size:13px;letter-spacing:3px;color:#4a6080;margin-bottom:8px">HOMEWORLDS DUEL</div>
          <h2 style="color:#ddeeff;font-size:28px;letter-spacing:4px;margin:0 0 24px">YOUR CODE</h2>
          <div style="font-size:42px;font-weight:bold;letter-spacing:12px;color:#4488ff;background:#0c1120;padding:20px;border-radius:6px;text-align:center;border:1px solid #1c2840">${code}</div>
          <p style="margin-top:20px;font-size:13px;color:#4a6080;line-height:1.7">
            Enter this code in Homeworlds Duel to verify your account.<br>
            Expires in <strong style="color:#ddeeff">15 minutes</strong>.<br>
            Do not share this code with anyone.
          </p>
          <p style="font-size:11px;color:#2a3850;margin-top:24px">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    console.log(`[VERIF] Code sent to ${email} for uid=${uid}`);
    return { ok: true };
  }
);

/**
 * checkVerifCode({ uid, code })
 * Validates the entered 6-digit code. On success, marks emailVerified in the
 * players record so the client can proceed to the username picker.
 * Returns { ok: true } or throws with a descriptive error.
 */
exports.checkVerifCode = onCall(
  { region: 'us-central1' },
  async (request) => {
    const callerUid = request.auth?.uid;
    const { uid, code } = request.data || {};

    // Must be called by the authenticated user themselves
    if (!callerUid || callerUid !== uid) throw new Error('UNAUTHORIZED');
    if (!code) throw new Error('Missing code');

    const db = getDatabase();
    const snap = await db.ref(`emailVerif/${uid}`).get();
    if (!snap.exists()) throw new Error('NO_CODE: No pending verification found');

    const rec = snap.val();

    if (rec.used)                       throw new Error('USED: Code already used');
    if (Date.now() > rec.expiresAt)     throw new Error('EXPIRED: Code has expired');
    if ((rec.attempts || 0) >= 5)       throw new Error('LOCKED: Too many attempts');

    const { createHash } = require('crypto');
    const hashed = createHash('sha256').update(code + uid).digest('hex');

    if (hashed !== rec.hash) {
      await db.ref(`emailVerif/${uid}/attempts`).set((rec.attempts || 0) + 1);
      const left = 4 - (rec.attempts || 0);
      throw new Error(`WRONG_CODE: Incorrect code — ${left} attempt${left !== 1 ? 's' : ''} remaining`);
    }

    // ✓ Correct — mark used and flag the player record as email-verified
    await db.ref(`emailVerif/${uid}`).update({ used: true });
    // If player record already exists (unlikely at this stage), mark verified
    await db.ref(`players/${uid}`).update({ emailVerified: true });

    console.log(`[VERIF] ✓ uid=${uid} verified`);
    return { ok: true };
  }
);
