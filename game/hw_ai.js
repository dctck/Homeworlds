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
      case 'sacrifice': {
        const sys  = sysById(s, move.sysId); if (!sys) break;
        const ship = sys.ships.find(sh => sh.id === move.shipId); if (!ship) break;
        s.bank[ship.color][ship.size]++;
        sys.ships = sys.ships.filter(sh => sh.id !== move.shipId);
        cleanSim(s);
        // Simulate using sac actions as moves of that color
        // (simplified: score the resulting position with sac pool active)
        s._sacPool = { color: ship.color, count: ship.size };
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

      // SACRIFICE — give up a ship for multiple actions
      ownShips.forEach(ship => {
        const isLastInHW = sys.isHomeworld === player && ownShips.length <= 1;
        if (isLastInHW) return;
        // Only worth sacrificing size 2 or 3
        if (ship.size < 2) return;
        moves.push({ type: 'sacrifice', sysId: sys.id, shipId: ship.id,
                     sacColor: ship.color, sacCount: ship.size });
      });

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
    if (isWin(st, aiPlayer))  return  10000;
    if (isLoss(st, aiPlayer)) return -10000;

    let score = 0;
    const myHW  = getHW(st, aiPlayer);
    const oppHW = getHW(st, opp);
    const mySystems  = new Set();
    const oppSystems = new Set();

    // ── Precompute color sets ──────────────────────────────
    const myColors  = new Set();
    const oppColors = new Set();
    st.systems.forEach(sys => {
      sys.ships.filter(s => s.owner === aiPlayer).forEach(s => myColors.add(s.color));
      sys.ships.filter(s => s.owner === opp).forEach(s => oppColors.add(s.color));
    });

    // ── Per-system scoring ─────────────────────────────────
    st.systems.forEach(sys => {
      const myShips  = sys.ships.filter(s => s.owner === aiPlayer);
      const oppShips = sys.ships.filter(s => s.owner === opp);

      if (myShips.length)  mySystems.add(sys.id);
      if (oppShips.length) oppSystems.add(sys.id);

      // Raw ship power — size² weighted
      myShips.forEach(s  => { score += s.size * s.size; });
      oppShips.forEach(s => { score -= s.size * s.size; });

      // Spread bonus
      if (!sys.isHomeworld && myShips.length)  score += 3;
      if (!sys.isHomeworld && oppShips.length) score -= 2;

      // ── Doomsday positioning ───────────────────────────
      if (oppHW && sys.id !== oppHW.id && connected(sys, oppHW)) {
        const oppHWColors = new Set(oppHW.stars.map(s => s.color));
        myShips.forEach(s => {
          if (oppHWColors.has(s.color)) score += s.size * 8;
        });
        score += myShips.length * 4;
      }

      // Ships IN opponent HW
      if (sys.isHomeworld === opp) {
        myShips.forEach(s => { score += s.size * 10; });
        const bigInvader = myShips.reduce((m, s) => s.size > m ? s.size : m, 0);
        if (bigInvader >= 3) score += 20;
      }

      // ── Catastrophe pressure in opp HW ────────────────
      if (sys.isHomeworld === opp) {
        COLORS.forEach(c => {
          const p = cataPressure(sys, c);
          if (p >= 3) score += p * 20;
          else if (p === 2) score += 8;
        });
      }

      // Cata staging in mid systems
      if (!sys.isHomeworld) {
        COLORS.forEach(c => {
          const p = cataPressure(sys, c);
          if (p >= 3) score += p * 6;
        });
      }

      // ── Overpopulation TRAP ────────────────────────────
      // Opponent has 2 same-color pieces in a system + we have that color = move in
      if (!sys.isHomeworld) {
        COLORS.forEach(c => {
          const oppCount = sys.ships.filter(s => s.owner === opp && s.color === c).length
                         + sys.stars.filter(s => s.color === c).length;
          if (oppCount === 2 && myColors.has(c)) score += 12; // we can complete the cata
          if (oppCount === 3 && myColors.has(c)) score += 25; // one move from cata
        });
      }

      // ── Own HW: same-color stacking penalty ───────────
      if (sys.isHomeworld === aiPlayer) {
        const colorCounts = {};
        sys.ships.filter(s => s.owner === aiPlayer).forEach(s => {
          colorCounts[s.color] = (colorCounts[s.color] || 0) + 1;
        });
        Object.values(colorCounts).forEach(count => {
          if (count >= 2) score -= 8 * (count - 1);
        });
        sys.stars.forEach(star => {
          const sameColorShips = sys.ships.filter(s => s.color === star.color).length;
          if (sameColorShips >= 1) score -= 6;
          if (sameColorShips >= 2) score -= 12;
        });
      }

      // ── Investment: green at large star ───────────────
      if (!sys.isHomeworld) {
        const hasLargeStar = sys.stars.some(s => s.size === 3);
        if (hasLargeStar) {
          myShips.filter(s => s.color === 'green').forEach(() => { score += 4; });
        }
      }
    });

    // ── Own HW safety ──────────────────────────────────────
    if (myHW) {
      const myDefenders  = myHW.ships.filter(s => s.owner === aiPlayer);
      const bigDefender  = myDefenders.length
        ? Math.max(...myDefenders.map(s => s.size)) : 0;
      score += bigDefender * 8;
      score += myHW.stars.length * 10;

      // Enemy ships in my HW
      myHW.ships.filter(s => s.owner !== aiPlayer).forEach(s => {
        score -= s.size * 8;
      });

      // ── Paralysis detection ──────────────────────────
      if (myDefenders.length === 1) {
        const hwPowers = new Set();
        myHW.stars.forEach(s => hwPowers.add(s.color));
        myDefenders.forEach(s => hwPowers.add(s.color));
        if (!hwPowers.has('green'))  score -= 20;
        if (!hwPowers.has('yellow')) score -= 15;
        if (!hwPowers.has('green') && !hwPowers.has('yellow')) score -= 30;
      }

      // ── Deterrent principle: red access at HW ─────────
      // Red ship AT HW (physical, can't be taken) = strong deterrent
      const redShipAtHW = myHW.ships.some(s => s.owner === aiPlayer && s.color === 'red');
      const redStarAtHW = myHW.stars.some(s => s.color === 'red');
      const hasRedAccess = redShipAtHW || redStarAtHW;

      // Check if opponent has ships 1 hop from my HW
      const oppNearMyHW = st.systems.some(sys =>
        sys.id !== myHW.id &&
        connected(sys, myHW) &&
        sys.ships.some(s => s.owner === opp)
      );
      if (oppNearMyHW && !hasRedAccess) score -= 20; // no deterrent, opponent nearby
      if (oppNearMyHW && hasRedAccess)  score += 8;  // deterrent working
      if (redShipAtHW) score += 8; // physical red ship = best deterrent

      // ── Paralysis override — trumps all red bonuses ───
      const hwPowersAll = new Set();
      myHW.stars.forEach(s => hwPowersAll.add(s.color));
      myHW.ships.filter(s => s.owner === aiPlayer).forEach(s => hwPowersAll.add(s.color));
      const isParalyzed = !hwPowersAll.has('green') && !hwPowersAll.has('yellow');
      if (isParalyzed) score -= 60;

      // ── HW invasion threat ────────────────────────────
      // Count opponent ships that could reach my HW in 1-2 moves
      let invasionThreat = 0;
      st.systems.forEach(sys => {
        if (sys.id === myHW.id) return;
        const oppHere = sys.ships.filter(s => s.owner === opp);
        if (connected(sys, myHW)) {
          // 1 hop away
          invasionThreat += oppHere.reduce((sum, s) => sum + s.size, 0);
        } else {
          // 2 hops away — check if any connected system connects to myHW
          const connToMyHW = st.systems.some(mid =>
            mid.id !== sys.id && mid.id !== myHW.id &&
            connected(sys, mid) && connected(mid, myHW)
          );
          if (connToMyHW) invasionThreat += oppHere.reduce((sum, s) => sum + s.size * 0.4, 0);
        }
      });
      score -= invasionThreat * 3;

      // Total ship count guard
      const totalMyShips = st.systems.reduce((n, s) =>
        n + s.ships.filter(sh => sh.owner === aiPlayer).length, 0);
      if (totalMyShips === 1) score -= 15;
    }

    // ── Opponent HW vulnerability ──────────────────────────
    if (oppHW) {
      score -= oppHW.stars.length * 5;
      const oppDefenders = oppHW.ships.filter(s => s.owner === opp).length;
      if (oppDefenders === 0) score += 25;
      if (oppHW.stars.length === 1) score += 30;

      // Check if opponent lacks red near their HW = easier to invade
      const oppRedAtHW = oppHW.ships.some(s => s.owner === opp && s.color === 'red')
                      || oppHW.stars.some(s => s.color === 'red');
      if (!oppRedAtHW) score += 12; // no deterrent = safe to invade
    }

    // ── Bank economy ───────────────────────────────────────
    // Freeze-out scoring
    COLORS.forEach(c => {
      if (myColors.has(c) && !oppColors.has(c)) {
        score += 10;
        if (c === 'yellow') score += 6;
        if (c === 'red')    score += 4;
        if (c === 'green')  score += 4;
      }
      if (!myColors.has(c) && oppColors.has(c)) score -= 5;
    });
    if (myColors.size === 4) score += 8;

    // ── Bank scarcity + skip threat ────────────────────────
    COLORS.forEach(c => {
      const bankBySize = SIZES.map(sz => st.bank[c][sz]);
      const total = bankBySize.reduce((a, b) => a + b, 0);

      if (total === 0 && myColors.has(c) && !oppColors.has(c)) score += 8;
      if (total === 1 && !myColors.has(c)) score -= 3;

      // Green sacrifice skip threat:
      // If opponent has medium or large green, they can sacrifice to skip a size.
      // Penalize being 2nd-to-last on any size if opponent has green.
      const oppHasGreen = oppColors.has('green');
      if (oppHasGreen) {
        SIZES.forEach((sz, i) => {
          const remaining = st.bank[c][sz];
          if (remaining <= 2) score -= 4; // opponent may skip past this size
          if (remaining <= 1) score -= 6; // very close to being skipped
        });
      }

      // Abandoning a system returns star to bank — check if that helps opponent
      // (handled implicitly by move generator pruning last-ship-in-system moves)
    });

    // ── "If I do nothing" threat counter ──────────────────
    // Approximate opponent's best immediate move score as a threat signal.
    // If opponent can win immediately, that's already caught by isLoss.
    // Here we penalize positions where opponent has many high-value options.
    if (oppHW) {
      const oppHWColors = new Set(oppHW.stars.map(s => s.color));
      let oppThreatScore = 0;
      st.systems.forEach(sys => {
        const oppShipsHere = sys.ships.filter(s => s.owner === opp);
        // Opponent ships of HW star colors near my HW = immediate threat
        if (myHW && connected(sys, myHW)) {
          oppShipsHere.forEach(s => {
            if (oppHW.stars.some(st2 => st2.color === s.color)) oppThreatScore += s.size * 3;
          });
        }
      });
      score -= oppThreatScore;
    }

    // ── Who runs out of room first ─────────────────────────
    // If both players building same color, check who hits overpopulation sooner
    COLORS.forEach(c => {
      if (!myColors.has(c) || !oppColors.has(c)) return;
      const myCount  = st.systems.reduce((n, sys) =>
        n + sys.ships.filter(s => s.owner === aiPlayer && s.color === c).length
          + sys.stars.filter(s => s.color === c).length, 0);
      const oppCount = st.systems.reduce((n, sys) =>
        n + sys.ships.filter(s => s.owner === opp && s.color === c).length
          + sys.stars.filter(s => s.color === c).length, 0);
      // 3 = overpopulation threshold in any single system
      // If we have more pieces of this color spread out, we're safer
      if (myCount > oppCount) score += 3;
      if (myCount < oppCount) score -= 3;
    });

    // ── Spread diversity ───────────────────────────────────
    score += mySystems.size * 2;
    score -= oppSystems.size * 1;
    score += myColors.size  * 3;

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

  // ── Learning weights (localStorage) ───────────────────────
  // Signatures: 'build_home','build_mid','move_toward_opp',
  //             'attack_opp_hw','catastrophe_opp_hw','discover','sacrifice','trade'
  let _weights = {};
  try { _weights = JSON.parse(localStorage.getItem('hw_ai_weights') || '{}'); } catch(e) {}

  let _movesThisGame = []; // track move sigs this game

  function moveSignature(move, st, player) {
    const opp    = 3 - player;
    const oppHW  = getHW(st, opp);
    const myHW   = getHW(st, player);
    const sys    = sysById(st, move.sysId || move.fromSysId);

    // ── Situation context ──────────────────────────────────
    const turn = st.currentTurn || 0;
    const phase = turn < 8 ? 'early' : turn < 20 ? 'mid' : 'late';

    let myPow = 0, oppPow = 0;
    st.systems.forEach(s => s.ships.forEach(sh => {
      if (sh.owner === player) myPow += sh.size * sh.size;
      else oppPow += sh.size * sh.size;
    }));
    const posture = myPow > oppPow + 3 ? 'winning'
                  : myPow < oppPow - 3 ? 'losing' : 'even';

    const oppHWStars     = oppHW?.stars?.length ?? 2;
    const oppHWDefenders = oppHW?.ships?.filter(s => s.owner === opp).length ?? 1;
    const hwPressure     = oppHWStars <= 1    ? 'critical'
                         : oppHWDefenders === 0 ? 'exposed' : 'normal';

    const myHWInvaders = myHW?.ships?.filter(s => s.owner !== player).length ?? 0;
    const myHWDanger   = myHWInvaders > 0 ? 'danger' : 'safe';

    // ── Color economy context ──────────────────────────────
    const myColors  = new Set();
    const oppColors = new Set();
    st.systems.forEach(s => {
      s.ships.filter(sh => sh.owner === player).forEach(sh => myColors.add(sh.color));
      s.ships.filter(sh => sh.owner !== player).forEach(sh => oppColors.add(sh.color));
    });

    switch (move.type) {

      case 'build': {
        const atHome = sys?.isHomeworld === player;
        // Building a color opponent lacks = freeze bonus context
        const freezes = !oppColors.has(move.color) && myColors.has(move.color);
        // Taking last bank piece of this color
        const bankTotal = SIZES.reduce((sum, sz) => sum + st.bank[move.color][sz], 0);
        const takesLast = bankTotal === 1;
        if (freezes)   return `build_freeze_${move.color}_${phase}`;
        if (takesLast) return `build_last_${move.color}_${phase}`;
        return `build_${atHome ? 'home' : 'mid'}_${phase}_${posture}`;
      }

      case 'trade': {
        const freezes = !oppColors.has(move.newColor);
        // Detect paralysis trade: trading away last green/yellow ship
        // when HW has no green/yellow star = self-imprisonment
        const hwStarColors = new Set((myHW?.stars || []).map(s => s.color));
        const ship = sys?.ships?.find(s => s.id === move.shipId);
        const losingGreen  = ship?.color === 'green' && !hwStarColors.has('green');
        const losingYellow = ship?.color === 'yellow' && !hwStarColors.has('yellow');
        const onlyShip = sys?.ships?.filter(s => s.owner === player).length === 1;
        if (onlyShip && (losingGreen || losingYellow)) return `trade_paralysis_${phase}`;
        return `trade_${freezes ? 'freeze' : 'normal'}_${phase}`;
      }

      case 'discover': {
        // Discover a large star = investment potential
        const bigStar = move.starSize === 3;
        return `discover_${bigStar ? 'large' : 'small'}_${phase}_${posture}`;
      }

      case 'sacrifice': {
        // Green sacrifice near large star = investment cash-in
        const ship = sys?.ships?.find(s => s.id === move.shipId);
        const hasLargeStar = sys?.stars?.some(s => s.size === 3);
        if (ship?.color === 'green' && hasLargeStar) return `sacrifice_invest_${phase}`;
        // Sacrifice near opp HW = tactical
        const nearOppHW = oppHW && sys && connected(sys, oppHW);
        return `sacrifice_${nearOppHW ? 'tactical' : 'general'}_${phase}_${posture}_${hwPressure}`;
      }

      case 'attack': {
        const atOppHW = sys?.isHomeworld === opp;
        // Check if this capture gives us color monopoly
        const target = sys?.ships?.find(s => s.id === move.targetId);
        const captureFreeze = target && !oppColors.has(target.color);
        if (captureFreeze) return `attack_freeze_${phase}`;
        return `attack_${atOppHW ? 'opp_hw' : 'mid'}_${posture}_${myHWDanger}`;
      }

      case 'catastrophe': {
        const atOppHW = sys?.isHomeworld === opp;
        // Destroying last star = win path
        const winsNow  = atOppHW && oppHWStars <= 1;
        if (winsNow) return 'cata_win_now';
        return `cata_${atOppHW ? 'opp_hw' : 'mid'}_${hwPressure}_${phase}`;
      }

      case 'move': {
        const toSys = sysById(st, move.toSysId);
        const ship  = sys?.ships?.find(s => s.id === move.shipId);
        // Doomsday positioning: moving ship of opp HW star color to 1-hop position
        const oppHWColors  = new Set((oppHW?.stars || []).map(s => s.color));
        const isDoomsdayMove = ship && oppHWColors.has(ship.color)
                             && oppHW && toSys && connected(toSys, oppHW)
                             && toSys.id !== oppHW.id;
        if (isDoomsdayMove) return `move_doomsday_${phase}_${hwPressure}`;
        if (toSys?.isHomeworld === opp)               return `move_into_opp_hw_${posture}`;
        if (oppHW && toSys && connected(toSys, oppHW)) return `move_toward_opp_${phase}_${posture}`;
        if (toSys?.isHomeworld === player)             return `move_retreat_${myHWDanger}`;
        return `move_other_${phase}`;
      }

      default: return 'pass';
    }
  }

  function learnedBonus(sig) {
    return (_weights[sig] || 0) * 2; // scale weight into score points
  }

  function recordMove(sig) {
    _movesThisGame.push(sig);
  }

  function onGameEnd(aiWon) {
    const delta = aiWon ? 0.4 : -0.25;
    _movesThisGame.forEach(sig => {
      _weights[sig] = Math.max(-10, Math.min(10, (_weights[sig] || 0) + delta));
    });
    try { localStorage.setItem('hw_ai_weights', JSON.stringify(_weights)); } catch(e) {}
    _movesThisGame = [];
  }

  // Patch evaluate to include learned weights
  const _baseEvaluate = evaluate;
  function evaluateWithLearning(st, aiPlayer) {
    return _baseEvaluate(st, aiPlayer);
    // weights applied at pickMove level, not here
  }

  // Patch pickMove to record move sigs
  const _basePick = pickMove;
  function pickMoveWithLearning(G, aiPlayer) {
    const opp   = 3 - aiPlayer;
    const moves = generateMoves(G, aiPlayer);
    let bestMove  = moves[moves.length - 1];
    let bestScore = -Infinity;

    for (const move of moves) {
      const st1 = applyMove(G, move, aiPlayer);
      if (isWin(st1, aiPlayer)) { recordMove(moveSignature(move, G, aiPlayer)); return move; }

      const sig    = moveSignature(move, G, aiPlayer);
      const bonus  = learnedBonus(sig);
      const oppMoves = generateMoves(st1, opp);
      let worstCase  = Infinity;
      for (const oppMove of oppMoves) {
        const st2 = applyMove(st1, oppMove, opp);
        const val = evaluate(st2, aiPlayer);
        if (val < worstCase) worstCase = val;
        if (worstCase <= bestScore) break;
      }
      const total = worstCase + bonus;
      if (total > bestScore) { bestScore = total; bestMove = move; }
    }

    recordMove(moveSignature(bestMove, G, aiPlayer));
    return bestMove;
  }

  // ── Public API ─────────────────────────────────────────────
  window.HW_AI = { pickMove: pickMoveWithLearning, pickSetup, onGameEnd };

})();