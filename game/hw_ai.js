// ============================================================
//  hw_ai.js — Homeworlds Arena AI  (2-ply minimax)
//  No dependencies on game_index.html functions.
//  Exposes: window.HW_AI.pickMove(G, aiPlayer) → move object
// ============================================================

(function () {

  const COLORS = ['red', 'blue', 'yellow', 'green'];

  // ── State helpers ──────────────────────────────────────────
  function clone(st)         { return JSON.parse(JSON.stringify(st)); }
  function sysById(st, id)   { return st.systems.find(s => s.id === id) || null; }
  function getHW(st, player) { return st.systems.find(s => s.isHomeworld === player) || null; }

  function sysSizes(sys) {
    return new Set(sys.stars.map(s => s.size));
  }
  function connected(s1, s2) {
    const a = sysSizes(s1), b = sysSizes(s2);
    for (const sz of a) if (b.has(sz)) return false;
    return true;
  }
  function largest(sys, player) {
    const own = sys.ships.filter(s => s.owner === player);
    return own.length ? own.reduce((m, s) => s.size > m.size ? s : m) : null;
  }
  function bankHas(st, color) {
    return [1, 2, 3].some(sz => st.bank[color][sz] > 0);
  }

  // ── Win / loss detection ───────────────────────────────────
  function isWin(st, player) {
    const opp   = 3 - player;
    const oppHW = getHW(st, opp);
    if (!oppHW)                    return true;   // HW destroyed
    if (oppHW.stars.length === 0)  return true;   // all stars catastrophed
    // Opponent has no ships of their own in their HW, but we do
    const oppOwn = oppHW.ships.filter(s => s.owner === opp).length;
    const myIn   = oppHW.ships.filter(s => s.owner === player).length;
    return oppOwn === 0 && myIn > 0;
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

  // ── Apply a move to a cloned state ─────────────────────────
  let _uid = 9000;
  function nid() { return ++_uid; }

  function applyMove(st, move, player) {
    const s = clone(st);
    switch (move.type) {

      case 'build': {
        const sys = sysById(s, move.sysId); if (!sys) break;
        const sz  = [1, 2, 3].find(z => s.bank[move.color][z] > 0); if (!sz) break;
        s.bank[move.color][sz]--;
        sys.ships.push({ id: nid(), color: move.color, size: sz, owner: player });
        break;
      }
      case 'trade': {
        const sys  = sysById(s, move.sysId);  if (!sys)  break;
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
        sys.stars.filter(st => st.color === c).forEach(st => s.bank[st.color][st.size]++);
        sys.ships.filter(sh => sh.color === c).forEach(sh => s.bank[sh.color][sh.size]++);
        sys.stars = sys.stars.filter(st => st.color !== c);
        sys.ships = sys.ships.filter(sh => sh.color !== c);
        if (!sys.isHomeworld) {
          if (sys.ships.length === 0 || sys.stars.length === 0) {
            sys.stars.forEach(st => s.bank[st.color][st.size]++);
            sys.ships.forEach(sh => s.bank[sh.color][sh.size]++);
            s.systems = s.systems.filter(sx => sx.id !== sys.id);
          }
        } else if (sys.stars.length === 0) {
          sys.ships.forEach(sh => s.bank[sh.color][sh.size]++);
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

    st.systems.forEach(sys => {
      const ownShips = sys.ships.filter(s => s.owner === player);
      if (ownShips.length === 0 && !sys.stars.some(() => false)) {
        // No own ships here — only catastrophe possible (checked below)
      }

      // Available powers: star colors + own ship colors
      const powers = new Set();
      sys.stars.forEach(s => powers.add(s.color));
      ownShips.forEach(s => powers.add(s.color));

      // BUILD — green: build smallest available of any own ship color
      if (powers.has('green') && ownShips.length > 0) {
        const seen = new Set();
        ownShips.forEach(ship => {
          if (!seen.has(ship.color) && bankHas(st, ship.color)) {
            seen.add(ship.color);
            moves.push({ type: 'build', sysId: sys.id, color: ship.color });
          }
        });
      }

      // TRADE — blue: swap own ship to a different color of same size
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

          // Discover new system (limit to avoid combinatorial explosion)
          const taken = sysSizes(sys);
          COLORS.forEach(starColor => {
            [1, 2, 3].forEach(starSize => {
              if (!taken.has(starSize) && st.bank[starColor][starSize] > 0) {
                moves.push({ type: 'discover', fromSysId: sys.id, shipId: ship.id, starColor, starSize });
              }
            });
          });
        });
      }

      // ATTACK — red
      if (powers.has('red')) {
        const big = largest(sys, player);
        if (big) {
          sys.ships
            .filter(s => s.owner !== player && s.size <= big.size)
            .forEach(enemy => {
              moves.push({ type: 'attack', sysId: sys.id, shipId: big.id, targetId: enemy.id });
            });
        }
      }
    });

    // CATASTROPHE — always available if eligible regardless of system
    eligibleCatastrophes(st).forEach(({ sysId, color }) => {
      moves.push({ type: 'catastrophe', sysId, color });
    });

    // Pass is always available
    moves.push({ type: 'pass' });
    return moves;
  }

  // ── Evaluation function ────────────────────────────────────
  function evaluate(st, aiPlayer) {
    const opp = 3 - aiPlayer;
    if (isWin(st, aiPlayer)) return  10000;
    if (isLoss(st, aiPlayer)) return -10000;

    let score = 0;

    // Ship power — size² weighting
    st.systems.forEach(sys => {
      sys.ships.forEach(ship => {
        const v = ship.size * ship.size;
        score += ship.owner === aiPlayer ? v : -v;
      });
    });

    const myHW  = getHW(st, aiPlayer);
    const oppHW = getHW(st, opp);

    // Own homeworld safety
    if (myHW) {
      score += myHW.ships.filter(s => s.owner === aiPlayer).length * 4;
      score += myHW.stars.length * 6;
    }

    // Pressure on opponent's homeworld
    if (oppHW) {
      score -= oppHW.ships.filter(s => s.owner === opp).length * 3;
      score += oppHW.ships.filter(s => s.owner === aiPlayer).length * 10;
      score -= oppHW.stars.length * 2;
    }

    // Color diversity (tech breadth)
    const myColors = new Set();
    st.systems.forEach(sys => sys.ships.filter(s => s.owner === aiPlayer).forEach(s => myColors.add(s.color)));
    score += myColors.size * 2;

    return score;
  }

  // ── 2-ply minimax ──────────────────────────────────────────
  //  Depth 1 = AI picks best immediate move
  //  Depth 2 = AI accounts for opponent's best response
  function pickMove(G, aiPlayer) {
    const opp   = 3 - aiPlayer;
    const moves = generateMoves(G, aiPlayer);

    let bestMove  = moves[moves.length - 1]; // fallback: pass
    let bestScore = -Infinity;

    for (const move of moves) {
      const st1 = applyMove(G, move, aiPlayer);

      // Immediate win → take it right away
      if (isWin(st1, aiPlayer)) return move;

      // Opponent's best response (ply 2)
      const oppMoves = generateMoves(st1, opp);
      let worstCase  = Infinity;
      for (const oppMove of oppMoves) {
        const st2 = applyMove(st1, oppMove, opp);
        const val = evaluate(st2, aiPlayer);
        if (val < worstCase) worstCase = val;
        // Alpha cut: opponent already found something worse than our current best
        if (worstCase <= bestScore) break;
      }

      if (worstCase > bestScore) {
        bestScore = worstCase;
        bestMove  = move;
      }
    }

    return bestMove;
  }

  // ── Public API ─────────────────────────────────────────────
  window.HW_AI = { pickMove };

})();
