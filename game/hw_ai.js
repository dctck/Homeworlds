// ============================================================
//  hw_ai.js — Homeworlds Arena AI  (2-ply minimax)
//  Strategy: spread ships, pressure opponent HW, set up
//  catastrophes, defend own HW with large ship.
//  Exposes: window.HW_AI.pickMove(G, aiPlayer)
// ============================================================

(function () {

  const COLORS = ['red', 'blue', 'yellow', 'green'];
  const SIZES  = [1, 2, 3];

  // ── State helpers ──────────────────────────────────────────
  function clone(st)         { return JSON.parse(JSON.stringify(st)); }
  function sysById(st, id)   { return st.systems.find(s => s.id === id) || null; }
  function getHW(st, player) { return st.systems.find(s => s.isHomeworld === player) || null; }

  function sysSizes(sys) { return new Set(sys.stars.map(s => s.size)); }

  function connected(s1, s2) {
    const a = sysSizes(s1), b = sysSizes(s2);
    for (const sz of a) if (b.has(sz)) return false;
    return true;
  }
  function largestShip(sys, player) {
    const own = sys.ships.filter(s => s.owner === player);
    return own.length ? own.reduce((m, s) => s.size > m.size ? s : m) : null;
  }
  function bankHas(st, color, size) {
    return size ? st.bank[color][size] > 0 : SIZES.some(sz => st.bank[color][sz] > 0);
  }

  // ── Win / loss detection ───────────────────────────────────
  function isWin(st, player) {
    const opp   = 3 - player;
    const oppHW = getHW(st, opp);
    if (!oppHW)                   return true;  // HW destroyed by catastrophe
    if (oppHW.stars.length === 0) return true;  // all stars gone
    const oppOwn = oppHW.ships.filter(s => s.owner === opp).length;
    const myIn   = oppHW.ships.filter(s => s.owner === player).length;
    return oppOwn === 0 && myIn > 0;            // captured all opponent ships in their HW
  }
  function isLoss(st, player) { return isWin(st, 3 - player); }

  // ── Catastrophe eligibility ────────────────────────────────
  function eligibleCatastrophes(st) {
    const list = [];
    st.systems.forEach(sys => {
      COLORS.forEach(color => {
        const n = sys.stars.filter(s => s.color === color).length
                + sys.ships.filter(s => s.color === color).length;
        if (n >= 4) list.push({ sysId: sys.id, color });
      });
    });
    return list;
  }

  // How many same-color pieces are in a system (catastrophe setup meter)
  function cataPressure(sys, color) {
    return sys.stars.filter(s => s.color === color).length
         + sys.ships.filter(s => s.color === color).length;
  }

  // ── Apply a move to a cloned state ─────────────────────────
  let _uid = 9000;
  function nid() { return ++_uid; }

  function applyMove(st, move, player) {
    const s = clone(st);
    switch (move.type) {

      case 'build': {
        const sys = sysById(s, move.sysId); if (!sys) break;
        const sz  = SIZES.find(z => s.bank[move.color][z] > 0); if (!sz) break;
        s.bank[move.color][sz]--;
        sys.ships.push({ id: nid(), color: move.color, size: sz, owner: player });
        break;
      }
      case 'trade': {
        const sys  = sysById(s, move.sysId); if (!sys) break;
        const ship = sys.ships.find(sh => sh.id === move.shipId); if (!ship) break;
        s.bank[ship.color][ship.size]++;
        s.bank[move.newColor][ship.size]--;
        ship.color = move.newColor;
        break;
      }
      case 'move': {
        const from = sysById(s, move.fromSysId);
        const to   = sysById(s, move.toSysId);
        if (!from || !to) break;
        const ship = from.ships.find(sh => sh.id === move.shipId); if (!ship) break;
        from.ships = from.ships.filter(sh => sh.id !== move.shipId);
        to.ships.push(ship);
        cleanSim(s);
        break;
      }
      case 'discover': {
        const from = sysById(s, move.fromSysId); if (!from) break;
        const ship = from.ships.find(sh => sh.id === move.shipId); if (!ship) break;
        if (s.bank[move.starColor][move.starSize] <= 0) break;
        s.bank[move.starColor][move.starSize]--;
        from.ships = from.ships.filter(sh => sh.id !== move.shipId);
        s.systems.push({
          id: nid(), name: 'ai_sys_' + nid(), isHomeworld: null,
          discoveredBy: player,
          stars: [{ color: move.starColor, size: move.starSize }],
          ships: [ship],
        });
        break;
      }
      case 'attack': {
        const sys    = sysById(s, move.sysId); if (!sys) break;
        const target = sys.ships.find(sh => sh.id === move.targetId); if (!target) break;
        target.owner = player;
        break;
      }
      case 'catastrophe': {
        const sys = sysById(s, move.sysId); if (!sys) break;
        const c   = move.color;
        sys.stars.filter(x => x.color === c).forEach(x => s.bank[x.color][x.size]++);
        sys.ships.filter(x => x.color === c).forEach(x => s.bank[x.color][x.size]++);
        sys.stars = sys.stars.filter(x => x.color !== c);
        sys.ships = sys.ships.filter(x => x.color !== c);
        if (!sys.isHomeworld) {
          if (sys.ships.length === 0 || sys.stars.length === 0) {
            sys.stars.forEach(x => s.bank[x.color][x.size]++);
            sys.ships.forEach(x => s.bank[x.color][x.size]++);
            s.systems = s.systems.filter(sx => sx.id !== sys.id);
          }
        } else if (sys.stars.length === 0) {
          sys.ships.forEach(x => s.bank[x.color][x.size]++);
          sys.ships = [];
        }
        break;
      }
      case 'pass': break;
    }
    return s;
  }

  function cleanSim(s) {
    s.systems = s.systems.filter(sys => {
      if (sys.isHomeworld) return true;
      if (sys.ships.length === 0) {
        sys.stars.forEach(st => s.bank[st.color][st.size]++);
        return false;
      }
      return true;
    });
  }

  // ── Move generator ─────────────────────────────────────────
  function generateMoves(st, player) {
    const moves = [];
    const opp   = 3 - player;
    const oppHW = getHW(st, opp);

    st.systems.forEach(sys => {
      const ownShips = sys.ships.filter(s => s.owner === player);

      // Powers available in this system
      const powers = new Set();
      sys.stars.forEach(s => powers.add(s.color));
      ownShips.forEach(s => powers.add(s.color));

      // BUILD — green
      if (powers.has('green') && ownShips.length > 0) {
        const seen = new Set();
        ownShips.forEach(ship => {
          if (!seen.has(ship.color) && bankHas(st, ship.color)) {
            seen.add(ship.color);
            moves.push({ type: 'build', sysId: sys.id, color: ship.color });
          }
        });
      }

      // TRADE — blue
      if (powers.has('blue')) {
        ownShips.forEach(ship => {
          COLORS.forEach(c => {
            if (c !== ship.color && st.bank[c][ship.size] > 0) {
              moves.push({ type: 'trade', sysId: sys.id, shipId: ship.id, newColor: c });
            }
          });
        });
      }

      // MOVE + DISCOVER — yellow
      if (powers.has('yellow')) {
        ownShips.forEach(ship => {
          const isLastInHW = sys.isHomeworld === player && ownShips.length <= 1;
          if (isLastInHW) return;

          // Move to existing connected system
          st.systems.forEach(toSys => {
            if (toSys.id !== sys.id && connected(sys, toSys)) {
              moves.push({ type: 'move', fromSysId: sys.id, toSysId: toSys.id, shipId: ship.id });
            }
          });

          // Discover — only if we don't already have 5+ systems (prune explosion)
          if (st.systems.length < 6) {
            const taken = sysSizes(sys);
            COLORS.forEach(starColor => {
              SIZES.forEach(starSize => {
                if (!taken.has(starSize) && st.bank[starColor][starSize] > 0) {
                  moves.push({ type: 'discover', fromSysId: sys.id, shipId: ship.id, starColor, starSize });
                }
              });
            });
          }
        });
      }

      // ATTACK — red
      if (powers.has('red')) {
        const big = largestShip(sys, player);
        if (big) {
          sys.ships
            .filter(s => s.owner !== player && s.size <= big.size)
            .forEach(enemy => {
              moves.push({ type: 'attack', sysId: sys.id, shipId: big.id, targetId: enemy.id });
            });
        }
      }
    });

    // CATASTROPHE — eligible regardless of system
    eligibleCatastrophes(st).forEach(({ sysId, color }) => {
      moves.push({ type: 'catastrophe', sysId, color });
    });

    moves.push({ type: 'pass' });
    return moves;
  }

  // ── Evaluation function ────────────────────────────────────
  // Encodes the strategy tips:
  // - Spread ships across systems
  // - Large ship defending own HW
  // - Ships adjacent to / inside opponent HW = high threat value
  // - Catastrophe pressure (3 same-color pieces building up)
  // - Color diversity (tech breadth)
  // - HW star safety
  function evaluate(st, aiPlayer) {
    const opp = 3 - aiPlayer;
    if (isWin(st, aiPlayer)) return  10000;
    if (isLoss(st, aiPlayer)) return -10000;

    let score = 0;

    const myHW  = getHW(st, aiPlayer);
    const oppHW = getHW(st, opp);

    // Count systems occupied per player
    const mySystems  = new Set();
    const oppSystems = new Set();

    st.systems.forEach(sys => {
      const myShips  = sys.ships.filter(s => s.owner === aiPlayer);
      const oppShips = sys.ships.filter(s => s.owner === opp);

      // Raw ship power — size² weighted
      myShips.forEach(s  => { score += s.size * s.size; });
      oppShips.forEach(s => { score -= s.size * s.size; });

      if (myShips.length)  mySystems.add(sys.id);
      if (oppShips.length) oppSystems.add(sys.id);

      // ── Spread bonus: reward ships being in mid systems ──
      if (!sys.isHomeworld && myShips.length > 0)  score += 3;
      if (!sys.isHomeworld && oppShips.length > 0) score -= 2;

      // ── Threat: my ships adjacent to (or already in) opponent HW ──
      if (oppHW && sys.id !== oppHW.id && connected(sys, oppHW) && myShips.length > 0) {
        score += myShips.reduce((sum, s) => sum + s.size * 4, 0); // big ships near opp HW = high threat
      }
      // My ships already IN opponent's HW
      if (sys.isHomeworld === opp && myShips.length > 0) {
        score += myShips.reduce((sum, s) => sum + s.size * 8, 0);
      }

      // ── Catastrophe pressure in opponent's HW ──
      if (sys.isHomeworld === opp) {
        COLORS.forEach(c => {
          const p = cataPressure(sys, c);
          if (p >= 3) score += p * 15; // very close to catastrophe → big bonus
          else if (p === 2) score += 6;
        });
      }
      // Catastrophe pressure in mid systems (staging)
      if (!sys.isHomeworld) {
        COLORS.forEach(c => {
          const p = cataPressure(sys, c);
          if (p >= 3) score += p * 5;
        });
      }
    });

    // ── Own HW safety ──────────────────────────────────────
    if (myHW) {
      const myDefenders = myHW.ships.filter(s => s.owner === aiPlayer);
      const bigDefender = myDefenders.length
        ? Math.max(...myDefenders.map(s => s.size)) : 0;
      score += bigDefender * 6;        // reward having a large ship at home
      score += myHW.stars.length * 8;  // losing a star is very bad

      // Penalize enemy ships in my HW
      const invaders = myHW.ships.filter(s => s.owner !== aiPlayer);
      score -= invaders.reduce((sum, s) => sum + s.size * 6, 0);
    }

    // ── Opponent HW star vulnerability ──────────────────────
    if (oppHW) {
      score -= oppHW.stars.length * 4;
      // Reward if opponent has no defenders at home
      const oppDefenders = oppHW.ships.filter(s => s.owner === opp).length;
      if (oppDefenders === 0) score += 20;
    }

    // ── Spread diversity bonus ─────────────────────────────
    score += mySystems.size  * 2;
    score -= oppSystems.size * 1;

    // ── Color (tech) diversity ─────────────────────────────
    const myColors = new Set();
    st.systems.forEach(sys =>
      sys.ships.filter(s => s.owner === aiPlayer).forEach(s => myColors.add(s.color))
    );
    score += myColors.size * 3;
    // Blue is especially valuable early — trade access
    if (myColors.has('blue'))   score += 3;
    if (myColors.has('yellow')) score += 2; // mobility
    if (myColors.has('red'))    score += 2; // attack ready

    return score;
  }

  // ── 2-ply minimax with alpha-beta ─────────────────────────
  function pickMove(G, aiPlayer) {
    const opp   = 3 - aiPlayer;
    const moves = generateMoves(G, aiPlayer);

    let bestMove  = moves[moves.length - 1]; // fallback: pass
    let bestScore = -Infinity;

    for (const move of moves) {
      const st1 = applyMove(G, move, aiPlayer);
      if (isWin(st1, aiPlayer)) return move; // immediate win

      // Opponent's best response
      const oppMoves  = generateMoves(st1, opp);
      let worstCase   = Infinity;

      for (const oppMove of oppMoves) {
        const st2 = applyMove(st1, oppMove, opp);
        const val = evaluate(st2, aiPlayer);
        if (val < worstCase) worstCase = val;
        if (worstCase <= bestScore) break; // alpha cut
      }

      if (worstCase > bestScore) {
        bestScore = worstCase;
        bestMove  = move;
      }
    }

    return bestMove;
  }

  // ── Setup advisor ──────────────────────────────────────────
  // Returns { star1, star2, shipColor } for AI homeworld setup.
  // Strategy:
  //   - Blue star is essential (trade access at HW)
  //   - Second star: different size from blue, prefer green (build) or red (defend)
  //   - Ship: large (size 3), prefer yellow (mobility) or green (build right away)
  function pickSetup(bank) {
    // Find a blue star — prefer size 3, fallback to any size
    let star1 = null;
    for (const sz of [3, 2, 1]) {
      if (bank['blue'][sz] > 0) { star1 = { color: 'blue', size: sz }; break; }
    }
    // Fallback if no blue available
    if (!star1) {
      for (const c of ['green', 'yellow', 'red']) {
        for (const sz of [3, 2, 1]) {
          if (bank[c][sz] > 0) { star1 = { color: c, size: sz }; break; }
        }
        if (star1) break;
      }
    }

    // Pick star2: different size from star1, prefer green then red then yellow
    let star2 = null;
    const preferredColors = ['green', 'red', 'yellow', 'blue'];
    for (const c of preferredColors) {
      for (const sz of [3, 2, 1]) {
        if (sz !== star1.size && bank[c][sz] > 0
            && !(c === star1.color && sz === star1.size)) {
          star2 = { color: c, size: sz };
          break;
        }
      }
      if (star2) break;
    }

    // Ship: size 3, prefer yellow (move out fast) then green (build)
    let shipColor = null;
    for (const c of ['yellow', 'green', 'blue', 'red']) {
      if (bank[c][3] > 0) { shipColor = c; break; }
    }
    shipColor = shipColor || 'red'; // last resort

    return { star1, star2, shipColor };
  }

  // ── Public API ─────────────────────────────────────────────
  window.HW_AI = { pickMove, pickSetup };

})();