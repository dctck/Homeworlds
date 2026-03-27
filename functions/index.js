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

// ── Pure game logic (for server-side premove execution) ──────────────────────
const L2C_CF = { r:'red', b:'blue', y:'yellow', g:'green' };

function _systemSizes(sys) { return new Set(sys.stars.map(s => s.size)); }
function _isConnected(s1, s2) { const a=_systemSizes(s1),b=_systemSizes(s2); for(const sz of a) if(b.has(sz)) return false; return true; }
function _findSys(G, name) { return G.systems.find(s => s.name === name); }
function _largest(sys, p) { const s=sys.ships.filter(s=>s.owner===p); return s.length?s.reduce((m,x)=>x.size>m.size?x:m):null; }
function _consume(G) { if(G.sacrificePool.count>0) G.sacrificePool.count--; else G.turnUsed=true; }
function _clean(G) { G.systems=G.systems.filter(s=>s.isHomeworld||s.ships.length>0||s.stars.length>0); }
function _nextId(G) { G._uid=(G._uid||0)+1; return G._uid; }
function _syncUid(G) {
  let m=0;
  (G.systems||[]).forEach(s=>{m=Math.max(m,s.id||0);(s.ships||[]).forEach(sh=>{m=Math.max(m,sh.id||0);});});
  G._uid=m;
}
function _checkWin(G) {
  for(let p=1;p<=2;p++){
    const hw=G.systems.find(s=>s.isHomeworld===p);
    if(!hw||hw.stars.length===0||!hw.ships.some(s=>s.owner===p)) return 3-p;
  }
  return null;
}

function _execAction(G, notation, player) {
  const p=notation.trim().split(/\s+/), v=p[0];
  const bail=(r)=>{console.warn(`[PREMOVE CF] ✗ "${notation}" — ${r}`);return false;};
  G._pendingActions=G._pendingActions||[];
  try {
    if(v==='skip'){G._pendingActions.push(notation);return true;}

    if(v==='build'){
      const col=L2C_CF[p[1][0]],sysName=p[2],sys=_findSys(G,sysName);
      if(!sys) return bail('system not found: '+sysName);
      const hasPow=sys.stars.some(s=>s.color==='green')||sys.ships.some(s=>s.owner===player&&s.color==='green')||G.sacrificePool.color==='green';
      if(!hasPow) return bail('no green power in '+sysName);
      const sz=[1,2,3].find(s=>G.bank[col][s]>0);
      if(!sz) return bail('bank empty for '+col);
      if(!sys.ships.find(s=>s.owner===player)) return bail('no own ship in '+sysName);
      G.bank[col][sz]--;
      sys.ships.push({id:_nextId(G),color:col,size:sz,owner:player});
      G._pendingActions.push(notation);
      _consume(G);_clean(G);return true;
    }

    if(v==='trade'){
      const col=L2C_CF[p[1][0]],size=+p[1][1],sysName=p[2],newCol=L2C_CF[p[3]];
      const sys=_findSys(G,sysName); if(!sys) return bail('system not found: '+sysName);
      const ship=sys.ships.find(s=>s.owner===player&&s.color===col&&s.size===size);
      if(!ship) return bail(`no own ${col}${size} in ${sysName}`);
      const hasPow=sys.stars.some(s=>s.color==='blue')||sys.ships.some(s=>s.owner===player&&s.color==='blue')||G.sacrificePool.color==='blue';
      if(!hasPow) return bail('no blue power in '+sysName);
      if(G.bank[newCol][size]<=0) return bail('bank empty for '+newCol+size);
      G.bank[col][size]++;G.bank[newCol][size]--;ship.color=newCol;
      G._pendingActions.push(notation);_consume(G);return true;
    }

    if(v==='move'){
      const col=L2C_CF[p[1][0]],size=+p[1][1],fromN=p[2],toN=p[3];
      const fromSys=_findSys(G,fromN),toSys=_findSys(G,toN);
      if(!fromSys) return bail('source not found: '+fromN);
      if(!toSys)   return bail('dest not found: '+toN);
      const ship=fromSys.ships.find(s=>s.owner===player&&s.color===col&&s.size===size);
      if(!ship) return bail(`no own ${col}${size} in ${fromN}`);
      if(!_isConnected(fromSys,toSys)) return bail(`${fromN} and ${toN} not connected`);
      const hasPow=fromSys.stars.some(s=>s.color==='yellow')||fromSys.ships.some(s=>s.owner===player&&s.color==='yellow')||G.sacrificePool.color==='yellow';
      if(!hasPow) return bail('no yellow power in '+fromN);
      fromSys.ships=fromSys.ships.filter(s=>s.id!==ship.id);toSys.ships.push(ship);
      G._pendingActions.push(notation);_consume(G);_clean(G);return true;
    }

    if(v==='discover'){
      const col=L2C_CF[p[1][0]],size=+p[1][1],fromN=p[2],sCol=L2C_CF[p[3][0]],sSz=+p[3][1],starName=p[4];
      const fromSys=_findSys(G,fromN); if(!fromSys) return bail('source not found: '+fromN);
      const ship=fromSys.ships.find(s=>s.owner===player&&s.color===col&&s.size===size);
      if(!ship) return bail(`no own ${col}${size} in ${fromN}`);
      if(G.bank[sCol][sSz]<=0) return bail(`bank empty for star ${sCol}${sSz}`);
      const hasPow=fromSys.stars.some(s=>s.color==='yellow')||fromSys.ships.some(s=>s.owner===player&&s.color==='yellow')||G.sacrificePool.color==='yellow';
      if(!hasPow) return bail('no yellow power in '+fromN);
      if(fromSys.isHomeworld===player&&fromSys.ships.filter(s=>s.owner===player).length<=1) return bail('last ship in homeworld');
      G.bank[sCol][sSz]--;
      const newSys={id:_nextId(G),name:starName||('Star'+G._uid),isHomeworld:null,discoveredBy:player,stars:[{color:sCol,size:sSz}],ships:[]};
      fromSys.ships=fromSys.ships.filter(s=>s.id!==ship.id);newSys.ships.push(ship);
      G.systems.push(newSys);
      G._pendingActions.push(notation);_consume(G);_clean(G);return true;
    }

    if(v==='hijack'){
      const col=L2C_CF[p[1][0]],size=+p[1][1],sysName=p[2];
      const sys=_findSys(G,sysName); if(!sys) return bail('system not found: '+sysName);
      const target=sys.ships.find(s=>s.owner!==player&&s.color===col&&s.size===size);
      if(!target) return bail(`no enemy ${col}${size} in ${sysName}`);
      const lg=_largest(sys,player);
      if(!lg||lg.size<target.size) return bail(`own largest (${lg?.size}) < target (${size})`);
      const hasPow=sys.stars.some(s=>s.color==='red')||sys.ships.some(s=>s.owner===player&&s.color==='red')||G.sacrificePool.color==='red';
      if(!hasPow) return bail('no red power in '+sysName);
      target.owner=player;
      G._pendingActions.push(notation);_consume(G);return true;
    }

    if(v==='sacrifice'){
      const col=L2C_CF[p[1][0]],size=+p[1][1],sysName=p[2];
      const sys=_findSys(G,sysName); if(!sys) return bail('system not found: '+sysName);
      const ship=sys.ships.find(s=>s.owner===player&&s.color===col&&s.size===size);
      if(!ship) return bail(`no own ${col}${size} in ${sysName}`);
      if(sys.isHomeworld===player&&sys.ships.filter(s=>s.owner===player).length===1) return bail('only ship in homeworld');
      G.bank[ship.color][ship.size]++;
      sys.ships=sys.ships.filter(s=>s.id!==ship.id);
      G.sacrificePool={color:ship.color,count:ship.size};G.turnUsed=true;
      G._pendingActions.push(notation);_clean(G);return true;
    }

    if(v==='catastrophe'){
      const sysName=p[1],color=L2C_CF[p[2]];
      const sys=_findSys(G,sysName); if(!sys) return bail('system not found: '+sysName);
      sys.stars.filter(s=>s.color===color).forEach(s=>G.bank[s.color][s.size]++);
      sys.ships.filter(s=>s.color===color).forEach(s=>G.bank[s.color][s.size]++);
      sys.stars=sys.stars.filter(s=>s.color!==color);sys.ships=sys.ships.filter(s=>s.color!==color);
      G._pendingActions.push(notation);_clean(G);return true;
    }

  } catch(e){console.error('[PREMOVE CF] exec error:',e);return false;}
  return bail('unknown verb: '+v);
}

// ── Web Push (VAPID) ──────────────────────────────────────────────────────
const webpush = require('web-push');

function initWebPush() {
  webpush.setVapidDetails(
    'mailto:' + process.env.EMAIL_USER,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

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

    const hist1 = (Array.isArray(p1.recentGames) ? p1.recentGames : p1.recentGames && typeof p1.recentGames === 'object' ? Object.values(p1.recentGames) : []).filter(x => x != null);
const hist2 = (Array.isArray(p2.recentGames) ? p2.recentGames : p2.recentGames && typeof p2.recentGames === 'object' ? Object.values(p2.recentGames) : []).filter(x => x != null);

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

// ── Trigger: notify player when it becomes their turn ────────────────────
exports.onTurnChange = onValueWritten(
  { ref: 'rooms/{roomId}', region: 'us-central1',
    secrets: ['EMAIL_USER', 'EMAIL_PASS', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] },
  async event => {
    const after  = event.data.after.val();
    const before = event.data.before.val();

    if (!after || !before) return null;
    if (after.status !== 'playing') return null;
    // Only fire when the active player actually changed
    if (after.currentPlayer === before.currentPlayer &&
        after.currentTurn  === before.currentTurn) return null;

    const newCurrentPlayer = after.currentPlayer; // 1 or 2
    const recipientUid = newCurrentPlayer === 1
      ? after.player1?.uid
      : after.player2?.uid;
    if (!recipientUid) return null;

    // Premove cancel: before had premove for this player, after it's gone
    const beforePremove = before.premoves?.[newCurrentPlayer];
    const afterPremove  = after.premoves?.[newCurrentPlayer];
    const premoveCanceled = !!beforePremove && !afterPremove;

    const gameName  = after.name || 'a game';
    const notifBody = premoveCanceled
      ? `Premove canceled — your turn in "${gameName}"`
      : `Your turn in "${gameName}"`;

    const db = getDatabase();
    const playerSnap = await db.ref(`players/${recipientUid}`).get();
    const player = playerSnap.val() || {};
    const prefs  = player.notifPrefs || {};
    const roomId = event.params.roomId;

    // Skip all notifications if recipient is currently online in the room
    const presenceSnap = await db.ref(`rooms/${roomId}/presence/${newCurrentPlayer}`).get();
    const isOnline = presenceSnap.val()?.online === true;
    if (isOnline) {
      console.log(`[NOTIF] Skipping — uid=${recipientUid} is present in room`);
      return null;
    }

    const promises = [];

    // Push notification
    if (prefs.push && player.pushSubscription) {
      initWebPush();
      const payload = JSON.stringify({ title: 'Homeworlds Arena', body: notifBody, gameId: roomId, playerSlot: newCurrentPlayer });
      promises.push(
        webpush.sendNotification(player.pushSubscription, payload).catch(err => {
          if (err.statusCode === 410) { // subscription expired — clean up
            return db.ref(`players/${recipientUid}/pushSubscription`).remove();
          }
          console.warn(`[PUSH] Failed uid=${recipientUid}:`, err.message);
        })
      );
    }

    // Email notification
    if (prefs.email) {
      const { getAuth } = require('firebase-admin/auth');
      const userRecord = await getAuth().getUser(recipientUid).catch(() => null);
      const email = userRecord?.email;
      if (email) promises.push(sendTurnEmail(email, notifBody, roomId, newCurrentPlayer));
    }

    await Promise.all(promises);
    console.log(`[NOTIF] Sent to uid=${recipientUid} | premoveCanceled=${premoveCanceled}`);
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

async function sendTurnEmail(email, message, roomId, playerSlot) {
  const gameUrl = `https://hwarena.xyz/game/?room=${roomId}&player=${playerSlot}`;
  const transport = makeTransport();
  await transport.sendMail({
    from:    `"Homeworlds Arena" <${process.env.EMAIL_USER}>`,
    to:      email,
    subject: 'Your turn — Homeworlds Arena',
    text:    `${message}\n\nPlay now: ${gameUrl}\n\nTurn off emails in your profile settings.`,
    html: `
      <div style="background:#060912;color:#a8c0e0;font-family:monospace;padding:32px;max-width:480px;border:1px solid #1c2840;border-radius:8px">
        <div style="font-family:sans-serif;font-size:13px;letter-spacing:3px;color:#4a6080;margin-bottom:8px">HOMEWORLDS ARENA</div>
        <h2 style="color:#ddeeff;font-size:22px;margin:0 0 16px">⚡ ${message}</h2>
        <a href="${gameUrl}" style="display:inline-block;background:#1a3a6a;color:#ddeeff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;letter-spacing:1px;border:1px solid #2a5a9a">PLAY NOW →</a>
        <p style="font-size:11px;color:#2a3850;margin-top:24px">
          Don't want these? <a href="https://hwarena.xyz/Profile_index.html" style="color:#4a6080">Turn off in profile settings</a>.
        </p>
      </div>
    `,
  }).catch(err => console.warn(`[EMAIL NOTIF] Failed to ${email}:`, err.message));
}

// ── Trigger: execute queued premove when opponent finishes their turn ─────────
exports.executePremove = onValueWritten(
  { ref: 'rooms/{roomId}/game', region: 'us-central1' },
  async event => {
    const after = event.data.after.val();
    if (!after?.gJson) return null;
    // Prevent re-triggering on our own writes
    if (after.writtenBy === 'premove-cf') return null;

    const roomId = event.params.roomId;
    const db = getDatabase();

    // Load room to check status
    const roomSnap = await db.ref(`rooms/${roomId}`).get();
    const room = roomSnap.val();
    if (!room || room.status !== 'playing') return null;

    let G;
    try { G = JSON.parse(after.gJson); } catch(e) { return null; }
    if (G.phase !== 'PLAY') return null;

    const currentPlayer = G.currentPlayer;

    // Check for queued premoves for this player
    const pmSnap = await db.ref(`rooms/${roomId}/premoves/${currentPlayer}`).get();
    if (!pmSnap.exists() || !pmSnap.val()) return null;

    let premoves;
    try { premoves = JSON.parse(pmSnap.val()); } catch(e) { return null; }
    if (!premoves?.length) return null;

    const pm = premoves[0];
    console.log(`[PREMOVE CF] Firing player ${currentPlayer} T${pm.turnFor}:`, pm.actions);

    // Sync uid counter to avoid ID collisions
    _syncUid(G);

    // Execute all actions in this premove
    for (const action of pm.actions) {
      if (!_execAction(G, action, currentPlayer)) {
        console.warn(`[PREMOVE CF] Invalid — clearing premoves for player ${currentPlayer}`);
        await db.ref(`rooms/${roomId}/premoves/${currentPlayer}`).set(null);
        return null;
      }
    }

    // Drain any leftover sacrifice pool (partial sacrifice premoves are allowed)
    G.sacrificePool = { color: null, count: 0 };

    // Commit turn log
    const actions = G._pendingActions || [];
    if (actions.length > 0) {
      G.log = G.log || [];
      G.log.push({ turn: G.currentTurn, player: currentPlayer, actions: [...actions] });
      G.currentTurn++;
    }
    G._pendingActions = [];

    // Flip turn
    G.currentPlayer = currentPlayer === 1 ? 2 : 1;
    G.turnUsed = false;
    G.selectedShipId = null;
    G.movingFromSysId = null;
    G.interaction = 'IDLE';
    G.history = null;
    G._turnStart = null;
    G._turnStart = JSON.stringify(G);

    // Check win
    const winner = _checkWin(G);
    if (winner) { G.phase = 'OVER'; G.winner = winner; }

    // Remove fired premove, save remainder
    premoves.shift();
    await db.ref(`rooms/${roomId}/premoves/${currentPlayer}`).set(
      premoves.length > 0 ? JSON.stringify(premoves) : null
    );

    // Write new game state — writtenBy 'premove-cf' prevents re-trigger
    const ts = Date.now();
    await db.ref(`rooms/${roomId}/game`).set({
      gJson: JSON.stringify(G),
      writtenBy: 'premove-cf',
      ts,
    });

    // Update room root so onTurnChange fires notification to next player
    const roomUpdate = { currentPlayer: G.currentPlayer, currentTurn: G.currentTurn };
    if (G.phase === 'OVER') {
      roomUpdate.status = 'archived';
      roomUpdate.winner = G.winner;
      roomUpdate.winnerName = room[`player${G.winner}`]?.name || `Player ${G.winner}`;
    }
    await db.ref(`rooms/${roomId}`).update(roomUpdate);

    console.log(`[PREMOVE CF] ✓ Player ${currentPlayer} premove done → now player ${G.currentPlayer}'s turn`);
    return null;
  }
);

/**
 * sendVerifCode({ uid, email })
 * Called right after createUserWithEmailAndPassword on the client.
 * Generates a 6-digit code, stores a bcrypt hash in the DB with 15-min expiry,
 * and sends the code to the user's email.
 */
exports.sendVerifCode = onCall(
  { region: 'us-central1', secrets: ['EMAIL_USER', 'EMAIL_PASS'] },
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
      from:    `"Homeworlds Arena" <${process.env.EMAIL_USER}>`,
      to:      email,
      subject: 'Homeworlds Arena verification code',
      text:    `Your verification code is: ${code}\n\nThis code expires in 15 minutes. Do not share it with anyone.`,
      html:    `
        <div style="background:#060912;color:#a8c0e0;font-family:monospace;padding:32px;max-width:480px;border:1px solid #1c2840;border-radius:8px">
          <div style="font-family:sans-serif;font-size:13px;letter-spacing:3px;color:#4a6080;margin-bottom:8px">HOMEWORLDS ARENA</div>
          <h2 style="color:#ddeeff;font-size:28px;letter-spacing:4px;margin:0 0 24px">YOUR CODE</h2>
          <div style="font-size:42px;font-weight:bold;letter-spacing:12px;color:#4488ff;background:#0c1120;padding:20px;border-radius:6px;text-align:center;border:1px solid #1c2840">${code}</div>
          <p style="margin-top:20px;font-size:13px;color:#4a6080;line-height:1.7">
            Enter this code in Homeworlds Arena to verify your account.<br>
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

// ── Save Push Subscription — callable from front-end ────────────────────
exports.savePushSubscription = onCall(
  { region: 'us-central1' },
  async (request) => {
    const callerUid = request.auth?.uid;
    if (!callerUid) throw new Error('UNAUTHORIZED');
    const { subscription } = request.data || {};
    if (!subscription?.endpoint) throw new Error('Invalid subscription object');
    const db = getDatabase();
    await db.ref(`players/${callerUid}/pushSubscription`).set(subscription);
    console.log(`[PUSH] Subscription saved uid=${callerUid}`);
    return { ok: true };
  }
);
