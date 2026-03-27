// ============================================================
//  hw_ai.js — Homeworlds Arena AI  (3-ply minimax)
//  Strategy-driven with named play styles.
//  Exposes: window.HW_AI = { pickMove, pickSetup, pickStyle }
// ============================================================
(function () {
  window.HW_AI_VERSION = 'v6-styles';
  console.log('[HW AI] version:', window.HW_AI_VERSION, '| style will be:', '(picked at game start)');

  const COLORS = ['red','blue','yellow','green'];
  const SIZES  = [1,2,3];

  // ── Play styles ────────────────────────────────────────────
  // Each style biases setup + eval differently
  const STYLES = {
    consensus:  { weight:35, name:'Consensus'  },
    banker:     { weight:25, name:'Banker'     },
    fortress:   { weight:20, name:'Fortress'   },
    quickstart: { weight:10, name:'Quick Start'},
    pds:        { weight:10, name:'Planetary Defense'},
  };

  function pickStyle() {
    const roll = Math.random() * 100;
    let cum = 0;
    for (const [key, cfg] of Object.entries(STYLES)) {
      cum += cfg.weight;
      if (roll < cum) {
        console.log('[HW AI] style selected:', key, '(', cfg.name, ')');
        return key;
      }
    }
    return 'consensus';
  }

  // ── Helpers ────────────────────────────────────────────────
  function clone(st)         { return JSON.parse(JSON.stringify(st)); }
  function sysById(st, id)   { return st.systems.find(s => s.id === id) || null; }
  function getHW(st, p)      { return st.systems.find(s => s.isHomeworld === p) || null; }
  function sysSizes(sys)     { return new Set(sys.stars.map(s => s.size)); }

  function connected(a, b) {
    const sa = sysSizes(a), sb = sysSizes(b);
    for (const sz of sa) if (sb.has(sz)) return false;
    return true;
  }
  function largestOwn(sys, p) {
    const own = sys.ships.filter(s => s.owner === p);
    return own.length ? own.reduce((m,s) => s.size > m.size ? s : m) : null;
  }
  function bankHas(st, c) { return SIZES.some(sz => st.bank[c][sz] > 0); }

  // ── Win / loss ─────────────────────────────────────────────
  function isWin(st, p) {
    const opp = 3-p, hw = getHW(st, opp);
    if (!hw || hw.stars.length === 0) return true;
    return hw.ships.filter(s=>s.owner===opp).length === 0
        && hw.ships.filter(s=>s.owner===p).length > 0;
  }
  function isLoss(st, p) { return isWin(st, 3-p); }

  // ── Catastrophe helpers ────────────────────────────────────
  function cataEligible(st) {
    const list = [];
    st.systems.forEach(sys => {
      COLORS.forEach(c => {
        const n = sys.stars.filter(s=>s.color===c).length
                + sys.ships.filter(s=>s.color===c).length;
        if (n >= 4) list.push({ sysId:sys.id, color:c });
      });
    });
    return list;
  }
  function cataPressure(sys, c) {
    return sys.stars.filter(s=>s.color===c).length
         + sys.ships.filter(s=>s.color===c).length;
  }

  // ── Apply move ─────────────────────────────────────────────
  let _uid = 9000;
  function nid() { return ++_uid; }

  function applyMove(st, move, p) {
    const s = clone(st);
    switch (move.type) {
      case 'build': {
        const sys = sysById(s, move.sysId); if (!sys) break;
        const sz  = SIZES.find(z => s.bank[move.color][z] > 0); if (!sz) break;
        s.bank[move.color][sz]--;
        sys.ships.push({ id:nid(), color:move.color, size:sz, owner:p });
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
        const from = sysById(s, move.fromSysId), to = sysById(s, move.toSysId);
        if (!from||!to) break;
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
        s.systems.push({ id:nid(), name:'ai_sys_'+nid(), isHomeworld:null,
          discoveredBy:p, stars:[{color:move.starColor,size:move.starSize}], ships:[ship] });
        break;
      }
      case 'attack': {
        const sys = sysById(s, move.sysId); if (!sys) break;
        const tgt = sys.ships.find(sh => sh.id === move.targetId); if (!tgt) break;
        tgt.owner = p;
        break;
      }
      case 'catastrophe': {
        const sys = sysById(s, move.sysId); if (!sys) break;
        const c = move.color;
        sys.stars.filter(x=>x.color===c).forEach(x=>s.bank[x.color][x.size]++);
        sys.ships.filter(x=>x.color===c).forEach(x=>s.bank[x.color][x.size]++);
        sys.stars = sys.stars.filter(x=>x.color!==c);
        sys.ships = sys.ships.filter(x=>x.color!==c);
        if (!sys.isHomeworld) {
          if (sys.ships.length===0||sys.stars.length===0) {
            sys.stars.forEach(x=>s.bank[x.color][x.size]++);
            sys.ships.forEach(x=>s.bank[x.color][x.size]++);
            s.systems = s.systems.filter(sx=>sx.id!==sys.id);
          }
        } else if (sys.stars.length===0) {
          sys.ships.forEach(x=>s.bank[x.color][x.size]++);
          sys.ships = [];
        }
        break;
      }

      case 'sacrifice_chain': {
        // Execute sacrifice then chain of follow-up actions
        const sys  = sysById(s, move.sysId); if (!sys) break;
        const ship = sys.ships.find(sh=>sh.id===move.shipId); if (!ship) break;
        s.bank[ship.color][ship.size]++;
        sys.ships = sys.ships.filter(sh=>sh.id!==move.shipId);
        cleanSim(s);
        // Execute each chained action
        (move.actions||[]).forEach(action => {
          if (action.type==='move'||action.type==='attack') {
            // inline apply without full clone for performance
            if (action.type==='move') {
              const from = sysById(s,action.fromSysId);
              const to   = sysById(s,action.toSysId);
              if (from&&to) {
                const sh = from.ships.find(sh=>sh.id===action.shipId);
                if (sh) {
                  from.ships = from.ships.filter(x=>x.id!==sh.id);
                  to.ships.push(sh);
                  cleanSim(s);
                }
              }
            } else if (action.type==='attack') {
              const sys2 = sysById(s,action.sysId);
              if (sys2) {
                const tgt = sys2.ships.find(sh=>sh.id===action.targetId);
                if (tgt) tgt.owner = p;
              }
            }
          }
        });
        break;
      }
      
      case 'sacrifice': {
        const sys  = sysById(s, move.sysId); if (!sys) break;
        const ship = sys.ships.find(sh => sh.id === move.shipId); if (!ship) break;
        s.bank[ship.color][ship.size]++;
        sys.ships = sys.ships.filter(sh => sh.id !== move.shipId);
        cleanSim(s);
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

  // ── Build sacrifice chain moves ────────────────────────────
  // Returns compound move objects that sacrifice a ship and
  // execute N follow-up actions of that color
  function buildSacrificeChains(st, p, sacSys, sacShip) {
    const chains = [];
    const color  = sacShip.color;
    const count  = sacShip.size; // number of actions

    // Simulate state after sacrifice
    const stAfterSac = clone(st);
    const sacSysClone = sysById(stAfterSac, sacSys.id);
    stAfterSac.bank[color][sacShip.size]++;
    sacSysClone.ships = sacSysClone.ships.filter(sh => sh.id !== sacShip.id);
    cleanSim(stAfterSac);

    if (color === 'yellow') {
      // Generate all combinations of N move actions
      const moveSequences = generateMoveSequences(stAfterSac, p, count);
      moveSequences.forEach(seq => {
        chains.push({
          type: 'sacrifice_chain',
          sysId: sacSys.id,
          shipId: sacShip.id,
          sacColor: color,
          sacCount: count,
          actions: seq,
        });
      });
    }

    if (color === 'red') {
      // Generate all combinations of N attack actions
      const attackSequences = generateAttackSequences(stAfterSac, p, count);
      attackSequences.forEach(seq => {
        chains.push({
          type: 'sacrifice_chain',
          sysId: sacSys.id,
          shipId: sacShip.id,
          sacColor: color,
          sacCount: count,
          actions: seq,
        });
      });
    }

    return chains;
  }

  // Generate up to N move actions (yellow sacrifice)
  // Focuses on strategically valuable moves only to limit explosion
  function generateMoveSequences(st, p, n) {
    const opp   = 3-p;
    const oppHW = getHW(st, opp);
    const sequences = [];

    // Find all ships that can move
    const movable = [];
    st.systems.forEach(sys => {
      const ownHere = sys.ships.filter(s=>s.owner===p);
      const lastInHW = sys.isHomeworld===p && ownHere.length<=1;
      if (lastInHW) return;
      ownHere.forEach(ship => {
        st.systems.forEach(to => {
          if (to.id!==sys.id && connected(sys,to)) {
            // Priority filter: only moves toward opp HW or to mid systems
            const towardOpp = oppHW && connected(to, oppHW);
            const intoOppHW = to.isHomeworld===opp;
            const escape    = sys.isHomeworld===p; // escaping from HW
            const midSpread = !to.isHomeworld;
            if (towardOpp||intoOppHW||escape||midSpread) {
              movable.push({ fromSysId:sys.id, toSysId:to.id, shipId:ship.id });
            }
          }
        });
      });
    });

    if (movable.length === 0) return sequences;

    // For n=2: generate all pairs
    // For n=3: generate all triples (but cap at 20 to avoid explosion)
    if (n === 1) {
      movable.forEach(m => sequences.push([m]));
    } else if (n === 2) {
      movable.forEach((m1,i) => {
        // Apply first move, then find second move options
        const st2 = applyMove(st, {type:'move',...m1}, p);
        const movable2 = [];
        st2.systems.forEach(sys => {
          const ownHere = sys.ships.filter(s=>s.owner===p);
          const lastInHW = sys.isHomeworld===p && ownHere.length<=1;
          if (lastInHW) return;
          ownHere.forEach(ship => {
            st2.systems.forEach(to => {
              if (to.id!==sys.id && connected(sys,to)) {
                movable2.push({ fromSysId:sys.id, toSysId:to.id, shipId:ship.id });
              }
            });
          });
        });
        movable2.slice(0,8).forEach(m2 => sequences.push([m1, m2]));
      });
    } else if (n === 3) {
      // Cap combinations — only take top moves toward opp HW
      const topMoves = movable
        .filter(m => {
          const to = sysById(st, m.toSysId);
          return oppHW && (connected(to,oppHW) || to.isHomeworld===opp);
        })
        .slice(0, 6);
      const allMoves = movable.slice(0, 8);
      const firstMoves = topMoves.length > 0 ? topMoves : allMoves;

      firstMoves.forEach(m1 => {
        const st2 = applyMove(st, {type:'move',...m1}, p);
        allMoves.slice(0,6).forEach(m2 => {
          if (m2.shipId===m1.shipId && m2.fromSysId===m1.fromSysId) return;
          sequences.push([m1, m2, m2]); // simplified 3rd action
        });
      });
    }

    return sequences.slice(0, 25); // hard cap to prevent explosion
  }

  // Generate up to N attack actions (red sacrifice)
  function generateAttackSequences(st, p, n) {
    const sequences = [];
    const attacks = [];

    st.systems.forEach(sys => {
      const myBig = sys.ships.filter(s=>s.owner===p)
        .reduce((m,s)=>s.size>m?s.size:m, 0);
      if (myBig===0) return;
      sys.ships.filter(s=>s.owner!==p&&s.size<=myBig).forEach(enemy => {
        attacks.push({ sysId:sys.id, targetId:enemy.id });
      });
    });

    if (attacks.length===0) return sequences;

    if (n===1) {
      attacks.forEach(a => sequences.push([a]));
    } else if (n>=2) {
      attacks.forEach((a1,i) => {
        const st2 = applyMove(st, {type:'attack',...a1}, p);
        const attacks2 = [];
        st2.systems.forEach(sys => {
          const myBig = sys.ships.filter(s=>s.owner===p)
            .reduce((m,s)=>s.size>m?s.size:m,0);
          if (myBig===0) return;
          sys.ships.filter(s=>s.owner!==p&&s.size<=myBig).forEach(enemy => {
            attacks2.push({ sysId:sys.id, targetId:enemy.id });
          });
        });
        if (attacks2.length===0) {
          sequences.push([a1]);
        } else {
          attacks2.slice(0,4).forEach(a2 => sequences.push([a1,a2]));
        }
      });
    }

    return sequences.slice(0, 15);
  }

  // ── Move generator ─────────────────────────────────────────
  function generateMoves(st, p) {
    const moves = [];
    st.systems.forEach(sys => {
      const own = sys.ships.filter(s => s.owner === p);
      const powers = new Set();
      sys.stars.forEach(s => powers.add(s.color));
      own.forEach(s => powers.add(s.color));

      if (powers.has('green') && own.length > 0) {
        const seen = new Set();
        own.forEach(ship => {
          if (!seen.has(ship.color) && bankHas(st, ship.color)) {
            seen.add(ship.color);
            moves.push({ type:'build', sysId:sys.id, color:ship.color });
          }
        });
      }
      if (powers.has('blue')) {
        own.forEach(ship => {
          COLORS.forEach(c => {
            if (c !== ship.color && st.bank[c][ship.size] > 0)
              moves.push({ type:'trade', sysId:sys.id, shipId:ship.id, newColor:c });
          });
        });
      }
      if (powers.has('yellow')) {
        own.forEach(ship => {
          const lastInHW = sys.isHomeworld === p && own.length <= 1;
          if (lastInHW) return;
          st.systems.forEach(to => {
            if (to.id !== sys.id && connected(sys, to))
              moves.push({ type:'move', fromSysId:sys.id, toSysId:to.id, shipId:ship.id });
          });
          if (st.systems.length < 7) {
            const taken = sysSizes(sys);
            COLORS.forEach(sc => SIZES.forEach(sz => {
              if (!taken.has(sz) && st.bank[sc][sz] > 0)
                moves.push({ type:'discover', fromSysId:sys.id, shipId:ship.id, starColor:sc, starSize:sz });
            }));
          }
        });
      }
      if (powers.has('red')) {
        const big = largestOwn(sys, p);
        if (big) {
          sys.ships.filter(s=>s.owner!==p&&s.size<=big.size).forEach(enemy => {
            moves.push({ type:'attack', sysId:sys.id, shipId:big.id, targetId:enemy.id });
          });
        }
      }
      own.forEach(ship => {
        const lastInHW = sys.isHomeworld === p && own.length <= 1;
        if (lastInHW || ship.size < 2) return;
        // Simple sacrifice (existing)
        moves.push({ type:'sacrifice', sysId:sys.id, shipId:ship.id });

        // ── Sacrifice chains: expand into compound moves ──
        // Only for yellow (mobility) and red (attack) — most strategically valuable
        if (ship.color === 'yellow' || ship.color === 'red') {
          const chains = buildSacrificeChains(st, p, sys, ship);
          chains.forEach(chain => moves.push(chain));
        }
      });
    });
    cataEligible(st).forEach(({sysId,color}) =>
      moves.push({ type:'catastrophe', sysId, color }));
    moves.push({ type:'pass' });
    return moves;
  }

  // ── Move ordering ──────────────────────────────────────────
  function moveOrder(move, st, p) {
    const st1 = applyMove(st, move, p);
    if (isWin(st1, p))  return 1000;
    if (isLoss(st1, p)) return -500;
    switch (move.type) {
      case 'catastrophe': return 90;
      case 'attack':      return 80;
      case 'sacrifice':   return 70;
      case 'build':       return 50;
      case 'trade':       return 40;
      case 'discover':    return 30;
      case 'move':        return 20;
      case 'pass':        return 0;
      default:            return 10;
    }
  }

  // ── Evaluation ─────────────────────────────────────────────
  function evaluate(st, p, style) {
    const opp = 3-p;
    if (isWin(st, p))  return  10000;
    if (isLoss(st, p)) return -10000;

    style = style || 'consensus';
    let score = 0;
    const myHW  = getHW(st, p);
    const oppHW = getHW(st, opp);
    const turn  = st.currentTurn || 0;
    const early = turn < 8;

    const myColors = new Set(), oppColors = new Set();
    let myLarges=0, oppLarges=0, myYellows=0, oppYellows=0;
    const mySystems=new Set(), oppSystems=new Set();

    st.systems.forEach(sys => {
      const myS  = sys.ships.filter(s=>s.owner===p);
      const oppS = sys.ships.filter(s=>s.owner===opp);
      myS.forEach(s => {
        myColors.add(s.color);
        if(s.size===3) myLarges++;
        if(s.color==='yellow') myYellows++;
      });
      oppS.forEach(s => {
        oppColors.add(s.color);
        if(s.size===3) oppLarges++;
        if(s.color==='yellow') oppYellows++;
      });
      if(myS.length)  mySystems.add(sys.id);
      if(oppS.length) oppSystems.add(sys.id);

      // Raw material
      myS.forEach(s  => { score += s.size * s.size; });
      oppS.forEach(s => { score -= s.size * s.size; });

      // Spread
      if (!sys.isHomeworld && myS.length)  score += 3;
      if (!sys.isHomeworld && oppS.length) score -= 2;

      // ── Style: Banker — reward green at large stars ──
      if ((style==='banker') && !sys.isHomeworld) {
        const hasLarge = sys.stars.some(s=>s.size===3);
        if (hasLarge) {
          myS.filter(s=>s.color==='green').forEach(() => { score += 8; });
        }
        // Banker also rewards discovering large systems
        if (sys.stars.some(s=>s.size===3) && myS.length) score += 4;
      }

      // ── Style: Fortress — reward when smalls are scarce ──
      if (style==='fortress') {
        COLORS.forEach(c => {
          const smallsLeft = st.bank[c][1];
          if (smallsLeft === 0 && myColors.has(c)) score += 6; // fortress advantage kicks in
          if (smallsLeft <= 1 && myS.some(s=>s.color===c)) score += 3;
        });
      }

      // ── Style: QuickStart — reward yellow ship count + early mobility ──
      if (style==='quickstart') {
        myS.filter(s=>s.color==='yellow').forEach(s => { score += s.size * 4; });
        if (!sys.isHomeworld && myS.length && turn < 12) score += 5;
      }

      // ── Style: PDS — reward red ship presence + captures ──
      if (style==='pds') {
        myS.filter(s=>s.color==='red').forEach(s => { score += s.size * 5; });
      }

      // Doomsday positioning
      if (oppHW && sys.id!==oppHW.id && connected(sys,oppHW)) {
        const oppHWc = new Set(oppHW.stars.map(s=>s.color));
        myS.forEach(s => { if(oppHWc.has(s.color)) score += s.size * 8; });
        score += myS.length * 4;
      }

      // Ships IN opp HW
      if (sys.isHomeworld === opp) {
        myS.forEach(s => { score += s.size * 10; });
        if (myS.some(s=>s.size===3)) score += 20;
      }

      // Cata pressure on opp HW
      if (sys.isHomeworld === opp) {
        COLORS.forEach(c => {
          const p2 = cataPressure(sys, c);
          if (p2>=3) score += p2*20;
          else if (p2===2) score += 8;
        });
      }

      // Cata staging in mid
      if (!sys.isHomeworld) {
        COLORS.forEach(c => {
          const p2 = cataPressure(sys, c);
          if (p2>=3) score += p2*6;
        });
      }

      // Overpopulation trap
      if (!sys.isHomeworld) {
        COLORS.forEach(c => {
          const oc = oppS.filter(s=>s.color===c).length + sys.stars.filter(s=>s.color===c).length;
          if (oc===2 && myColors.has(c)) score += 12;
          if (oc===3 && myColors.has(c)) score += 30;
        });
      }

      // Bluebird mistake (RED FLAG 10)
      if (sys.isHomeworld === p && myS.length >= 2) {
        if (new Set(myS.map(s=>s.color)).size === 1) score -= 50;
      }

      // Demolition Fleet risk (RED FLAG 11)
      if (sys.isHomeworld === p) {
        const myLargeHere = myS.filter(s=>s.size===3);
        if (myLargeHere.length===1) {
          if (sys.stars.some(st2=>st2.color===myLargeHere[0].color)) score -= 40;
        }
        // Same-color stacking
        const colC = {};
        myS.forEach(s => { colC[s.color]=(colC[s.color]||0)+1; });
        Object.values(colC).forEach(cnt => { if(cnt>=2) score -= 8*(cnt-1); });
        sys.stars.forEach(star => {
          const same = myS.filter(s=>s.color===star.color).length;
          if (same>=1) score -= 6;
          if (same>=2) score -= 12;
        });
      }
    });

    // ── Own HW safety ──────────────────────────────────────
    if (myHW) {
      const myDef   = myHW.ships.filter(s=>s.owner===p);
      const bigDef  = myDef.length ? Math.max(...myDef.map(s=>s.size)) : 0;
      const invaders = myHW.ships.filter(s=>s.owner!==p);

      // RED FLAG 2
      if (invaders.length > 0) {
        const myRed = myDef.some(s=>s.color==='red');
        if (!myRed && invaders.length >= myDef.length) score -= 500;
        else score -= invaders.reduce((sum,s)=>sum+s.size*8,0);
      }

      // RED FLAG 4: no large at HW
      if (bigDef < 3) score -= 80;
      else score += bigDef * 8;

      score += myHW.stars.length * 10;

      // Paralysis
      if (myDef.length === 1) {
        const hwP = new Set();
        myHW.stars.forEach(s=>hwP.add(s.color));
        myDef.forEach(s=>hwP.add(s.color));
        const eff = new Set(hwP); eff.delete('yellow');
        if (!eff.has('green'))  score -= 20;
        if (!hwP.has('yellow')&&!myDef.some(s=>s.color==='yellow')) score -= 15;
        if (!eff.has('green')&&!eff.has('blue')) score -= 30;
      }
      // Hard paralysis override
      const hwAll = new Set();
      myHW.stars.forEach(s=>hwAll.add(s.color));
      myHW.ships.filter(s=>s.owner===p).forEach(s=>hwAll.add(s.color));
      if (myDef.length<=1) hwAll.delete('yellow');
      if (!hwAll.has('green')&&!hwAll.has('blue')) score -= 60;

      // RED FLAG 6: opp has red, I don't
      const myHasRed  = myColors.has('red');
      const oppHasRed = oppColors.has('red');
      if (oppHasRed && !myHasRed) {
        // PDS style is less penalized — they planned for this
        score -= style==='pds' ? 30 : 60;
      }
      if (myHasRed && !oppHasRed) score += 20;

      // Deterrent
      const myRedShip = st.systems.some(sys=>sys.ships.some(s=>s.owner===p&&s.color==='red'));
      if (myRedShip) score += style==='pds' ? 25 : 15;
      if (myHW.ships.some(s=>s.owner===p&&s.color==='red')) score += style==='pds' ? 18 : 10;

      // Opp near HW
      const oppNear = st.systems.some(sys=>
        sys.id!==myHW.id&&connected(sys,myHW)&&sys.ships.some(s=>s.owner===opp));
      if (oppNear && !myHasRed) score -= 25;
      if (oppNear &&  myHasRed) score += 8;

      // Invasion threat
      let threat = 0;
      st.systems.forEach(sys => {
        if (sys.id===myHW.id) return;
        const oppHere = sys.ships.filter(s=>s.owner===opp);
        if (connected(sys,myHW)) {
          threat += oppHere.reduce((sum,s)=>sum+s.size,0);
        } else {
          const through = st.systems.some(mid=>
            mid.id!==sys.id&&mid.id!==myHW.id&&connected(sys,mid)&&connected(mid,myHW));
          if (through) threat += oppHere.reduce((sum,s)=>sum+s.size*0.4,0);
        }
      });
      score -= threat * 3;

      const totalMine = st.systems.reduce((n,s)=>n+s.ships.filter(sh=>sh.owner===p).length,0);
      if (totalMine===1) score -= 15;
    }

    // ── Opp HW vulnerability ──────────────────────────────
    if (oppHW) {
      score -= oppHW.stars.length * 5;
      if (oppHW.stars.length===1) score += 35;
      const oppDef = oppHW.ships.filter(s=>s.owner===opp).length;
      if (oppDef===0) score += 30;
      const oppHasRedHW = oppHW.ships.some(s=>s.owner===opp&&s.color==='red')
                        || oppHW.stars.some(s=>s.color==='red');
      if (!oppHasRedHW) score += 15;
    }

    // RED FLAGS 7+8: large + yellow ship count
    score += (myLarges - oppLarges) * 15;
    score += (myYellows - oppYellows) * 8;

    // ── Bank economy / freeze ──────────────────────────────
    COLORS.forEach(c => {
      if (myColors.has(c) && !oppColors.has(c)) {
        score += early ? 5 : 10;
        if (c==='yellow') score += early ? 3 : 6;
        if (c==='red')    score += early ? 2 : 4;
        if (c==='green')  score += early ? 2 : 4;
      }
      if (!myColors.has(c) && oppColors.has(c)) score -= 6;
    });
    if (myColors.size===4) score += 8;

    // Mirroring (early game)
    if (early) {
      COLORS.forEach(c => { if(oppColors.has(c)&&myColors.has(c)) score += 4; });
    }

    // Bank scarcity
    COLORS.forEach(c => {
      const total = SIZES.reduce((sum,sz)=>sum+st.bank[c][sz],0);
      if (total===0&&myColors.has(c)&&!oppColors.has(c)) score += 8;
      if (total===1&&!myColors.has(c)) score -= 3;
      if (oppColors.has('green')) {
        SIZES.forEach(sz => {
          const rem = st.bank[c][sz];
          if (rem<=2) score -= 4;
          if (rem<=1) score -= 6;
        });
      }
    });

    // Who runs out first
    COLORS.forEach(c => {
      if (!myColors.has(c)||!oppColors.has(c)) return;
      const myC  = st.systems.reduce((n,sys)=>n+sys.ships.filter(s=>s.owner===p&&s.color===c).length+sys.stars.filter(s=>s.color===c).length,0);
      const oppC = st.systems.reduce((n,sys)=>n+sys.ships.filter(s=>s.owner===opp&&s.color===c).length+sys.stars.filter(s=>s.color===c).length,0);
      if (myC>oppC) score += 3;
      if (myC<oppC) score -= 3;
    });

    // Opp threat counter
    if (oppHW && myHW) {
      const oppHWc = new Set(oppHW.stars.map(s=>s.color));
      st.systems.forEach(sys => {
        if (connected(sys,myHW)) {
          sys.ships.filter(s=>s.owner===opp).forEach(s => {
            if (oppHWc.has(s.color)) score -= s.size*3;
          });
        }
      });
    }

    score += mySystems.size * 2;
    score -= oppSystems.size * 1;
    score += myColors.size  * 2;

    // ══════════════════════════════════════════════
    //  MID-GAME ADDITIONS
    // ══════════════════════════════════════════════

    // ── Build small green turn 2 rule ─────────────
    // Early game: if we have green access and only 1 ship, heavily reward building
    if (early && myHW) {
      const totalMine = st.systems.reduce((n,s)=>n+s.ships.filter(sh=>sh.owner===p).length,0);
      const hwPow = new Set();
      myHW.stars.forEach(s=>hwPow.add(s.color));
      myHW.ships.filter(s=>s.owner===p).forEach(s=>hwPow.add(s.color));
      if (totalMine === 1 && hwPow.has('green')) score += 20; // strongly reward building
    }

    // ── Instafreeze counter ────────────────────────
    // If opponent is monopolizing a color we have a HW star of,
    // we must trade our large ship to get that color or we lose it
    if (myHW && early) {
      myHW.stars.forEach(star => {
        const c = star.color;
        const smallsLeft = st.bank[c][1];
        const oppHasMultiple = st.systems.reduce((n,sys)=>
          n+sys.ships.filter(s=>s.owner===opp&&s.color===c).length,0) >= 2;
        const iHaveColor = myColors.has(c);
        // Opponent building up color of my HW star = danger
        if (oppHasMultiple && !iHaveColor && smallsLeft <= 1) {
          score -= 40; // red flag: about to get frozen out of own HW star color
        }
        if (oppHasMultiple && !iHaveColor) {
          score -= 20; // building toward freeze
        }
      });
    }

    // ── Get there first with the most ─────────────
    // Reward being in a system with bigger ships than opponent
    // Penalize opponent having bigger ship in a shared system
    st.systems.forEach(sys => {
      const myS   = sys.ships.filter(s=>s.owner===p);
      const oppS  = sys.ships.filter(s=>s.owner===opp);
      if (myS.length===0 || oppS.length===0) return; // no contest
      const myBig  = Math.max(...myS.map(s=>s.size));
      const oppBig = Math.max(...oppS.map(s=>s.size));
      if (myBig > oppBig)  score += 10; // I dominate this system
      if (myBig < oppBig)  score -= 15; // opponent dominates — RED FLAG 9
      if (myBig === oppBig) score -= 5; // contested — slight disadvantage (they moved in)
    });

    // ── Colony defense: evacuate vs fight ─────────
    // For each non-HW system where opponent has invaded:
    // Score whether we can fight (have red) or need to run (have yellow)
    st.systems.forEach(sys => {
      if (sys.isHomeworld) return;
      const myS   = sys.ships.filter(s=>s.owner===p);
      const oppS  = sys.ships.filter(s=>s.owner===opp);
      if (myS.length===0 || oppS.length===0) return;

      const myBig  = Math.max(...myS.map(s=>s.size));
      const oppBig = Math.max(...oppS.map(s=>s.size));
      const myRed  = myColors.has('red');
      const canFight    = myRed && myBig >= oppBig;
      const canEvacuate = sys.stars.some(s=>s.color==='yellow') ||
                          myS.some(s=>s.color==='yellow');
      const canBuildOut = sys.stars.some(s=>s.color==='green') ||
                          myS.some(s=>s.color==='green');

      if (!canFight && !canEvacuate && !canBuildOut) {
        score -= 25; // trapped — no options
      } else if (!canFight && canEvacuate) {
        score -= 8;  // can escape but losing the colony
      } else if (canFight) {
        score += 5;  // can contest
      }
    });

    // ── Simultaneous multi-colony invasion ─────────
    // Opponent has ships in 2+ of my systems = double-check situation
    // Very hard to deal with — penalize heavily
    const myOccupiedSystems = st.systems.filter(sys =>
      sys.ships.some(s=>s.owner===p) && sys.ships.some(s=>s.owner===opp)
    );
    if (myOccupiedSystems.length >= 2) score -= 30 * (myOccupiedSystems.length - 1);

    // ── Milking the cow detection ──────────────────
    // Opponent repeatedly rebuilding large ships of same color =
    // they have a large ship to trade + bank is refilling that color
    // Detect: opponent has 2+ large ships of same color
    COLORS.forEach(c => {
      const oppLargesOfColor = st.systems.reduce((n,sys)=>
        n+sys.ships.filter(s=>s.owner===opp&&s.color===c&&s.size===3).length,0);
      if (oppLargesOfColor >= 2) {
        score -= 20; // opponent is milking — material advantage building fast
      }
      // Also penalize if opp has large + mediums of same color (building up)
      const oppMedsOfColor = st.systems.reduce((n,sys)=>
        n+sys.ships.filter(s=>s.owner===opp&&s.color===c&&s.size>=2).length,0);
      if (oppMedsOfColor >= 3) score -= 15;
    });

    // ── Counterattack awareness ─────────────────────
    // When my HW is under threat, reward having threats elsewhere
    // so opponent has to split attention
    if (myHW) {
      const myHWUnderThreat = myHW.ships.some(s=>s.owner===opp) ||
        st.systems.some(sys=>sys.id!==myHW.id&&connected(sys,myHW)&&
          sys.ships.some(s=>s.owner===opp));
      if (myHWUnderThreat && oppHW) {
        // Do I have ships near opp HW? That's a counterattack threat
        const myNearOppHW = st.systems.some(sys=>
          sys.id!==oppHW.id && connected(sys,oppHW) && sys.ships.some(s=>s.owner===p));
        if (myNearOppHW) score += 18; // creating counter-threat buys time
        // Do I have ships IN opp HW? Even better
        if (oppHW.ships.some(s=>s.owner===p)) score += 25;
      }
    }

    // ── Green sacrifice skip-past-size (strengthen) ─
    // If opponent has large OR medium green, they can sacrifice
    // to skip a size entirely. We need to account for 2nd-to-last pieces.
    const oppGreenLarge  = st.systems.some(sys=>sys.ships.some(s=>s.owner===opp&&s.color==='green'&&s.size===3));
    const oppGreenMedium = st.systems.some(sys=>sys.ships.some(s=>s.owner===opp&&s.color==='green'&&s.size===2));
    if (oppGreenLarge || oppGreenMedium) {
      const skipCount = oppGreenLarge ? 3 : 2; // large sac = 3 actions, medium = 2
      COLORS.forEach(c => {
        SIZES.forEach(sz => {
          const rem = st.bank[c][sz];
          if (rem <= skipCount) {
            score -= 5; // opponent can clear this size in one sacrifice turn
          }
        });
      });
    }

    // ══════════════════════════════════════════════
    //  LATE GAME PATTERN DETECTORS
    // ══════════════════════════════════════════════

    // ── Helper: max red sacrifice power ───────────
    // R = largest red ship opponent has anywhere
    // (if no red ship but red star in HW, R=1)
    function redPower(player) {
      let r = 0;
      st.systems.forEach(sys => {
        sys.ships.filter(s=>s.owner===player&&s.color==='red')
          .forEach(s=>{ if(s.size>r) r=s.size; });
      });
      if (r===0) {
        // check for red HW star
        const hw = getHW(st, player);
        if (hw && hw.stars.some(s=>s.color==='red')) r=1;
      }
      return r;
    }

    // ── DETECTOR 1: Star Demolition Doomsday ──────
    // For each of my HW stars, check if opponent has
    // enough same-color pieces staged to catastrophe it
    if (myHW) {
      myHW.stars.forEach(star => {
        const c = star.color;

        // Count opp pieces of this color already IN my HW
        const inHW = myHW.ships.filter(s=>s.color===c).length
                   + (star.color===c ? 1 : 0); // star itself counts

        // Count opp pieces of this color 1 hop away
        let staged1Hop = 0;
        let oppYellowMax = 0;
        st.systems.forEach(sys => {
          if (sys.id===myHW.id) return;
          const oppHere = sys.ships.filter(s=>s.owner===opp);
          if (connected(sys, myHW)) {
            staged1Hop += oppHere.filter(s=>s.color===c).length;
            // Track largest yellow for sacrifice mobility
            oppHere.filter(s=>s.color==='yellow')
              .forEach(s=>{ if(s.size>oppYellowMax) oppYellowMax=s.size; });
          }
        });

        const totalPressure = inHW + staged1Hop;
        const neededForCata = 4 - inHW; // pieces still needed in HW

        // Imminent: already 3 pieces of this color at/near HW
        if (totalPressure >= 3) score -= 80;
        else if (totalPressure === 2) score -= 35;
        else if (totalPressure === 1) score -= 10;

        // Yellow sacrifice threat: can opp move neededForCata ships in one turn?
        if (oppYellowMax >= neededForCata && staged1Hop >= neededForCata) {
          score -= 120; // one yellow sacrifice = catastrophe = losing a star
        } else if (oppYellowMax >= neededForCata - 1 && staged1Hop >= neededForCata - 1) {
          score -= 50; // one move + one sacrifice away
        }

        // Reward: I have ships of this color staged to PREVENT opp building pressure
        // (blocking the bank)
        const myOfThisColor = st.systems.reduce((n,sys)=>
          n+sys.ships.filter(s=>s.owner===p&&s.color===c).length,0);
        if (myOfThisColor >= 2) score += 15; // I'm competing for this color = safer
      });
    }

    // ── DETECTOR 2: Direct Assault threat ─────────
    // Opponent can win by flooding my HW with large ships
    // Needs: R+1 larges staged + yellow(R+1) + red(R+L)
    if (myHW) {
      const myR = redPower(p);   // my red defense power
      const myL = myHW.ships.filter(s=>s.owner===p&&s.size===3).length; // my larges at home

      // Count opp large ships staged (in HW or 1 hop away)
      let oppLargesStaged = 0;
      let oppYellowStaged = 0;
      let oppRedStaged    = 0;

      st.systems.forEach(sys => {
        const oppHere = sys.ships.filter(s=>s.owner===opp);
        const isNear  = sys.id!==myHW.id && connected(sys, myHW);
        const isIn    = sys.isHomeworld === p; // already in my HW

        if (isNear || isIn) {
          oppLargesStaged += oppHere.filter(s=>s.size===3).length;
          oppYellowStaged  = Math.max(oppYellowStaged,
            ...oppHere.filter(s=>s.color==='yellow').map(s=>s.size), 0);
        }
        // Red can be anywhere — it gets sacrificed from any system
        oppHere.filter(s=>s.color==='red')
          .forEach(s=>{ if(s.size>oppRedStaged) oppRedStaged=s.size; });
      });

      const neededLarges   = myR + 1; // R+1 to overwhelm my red
      const neededYellow   = myR + 1; // size R+1 yellow
      const neededRed      = myR + myL; // size R+L red to capture all

      // Full direct assault ready
      if (oppLargesStaged >= neededLarges &&
          oppYellowStaged  >= neededYellow &&
          oppRedStaged     >= neededRed) {
        score -= 200; // opponent can execute direct assault NOW
      }
      // Missing one piece
      else if (oppLargesStaged >= neededLarges &&
               (oppYellowStaged >= neededYellow || oppRedStaged >= neededRed)) {
        score -= 80; // one piece away from direct assault
      }
      // Building toward it
      else if (oppLargesStaged >= neededLarges - 1) {
        score -= 30;
      }

      // Reward: I have enough red to repel current staged fleet
      if (myR >= oppLargesStaged) score += 20;
    }

    // ── DETECTOR 3: Green build catastrophe ───────
    // Opponent in my HW + green sacrifice = build 3 same-color ships = cata
    if (myHW) {
      myHW.stars.forEach(star => {
        const c = star.color;
        const oppInHW = myHW.ships.filter(s=>s.owner===opp&&s.color===c).length;
        if (oppInHW === 0) return; // no threat for this color

        // Opponent has a green ship somewhere to sacrifice
        const oppGreenSize = st.systems.reduce((mx,sys)=>
          Math.max(mx,...sys.ships.filter(s=>s.owner===opp&&s.color==='green').map(s=>s.size),0),0);

        if (oppGreenSize >= 2) {
          // How many of color C are in the bank?
          const bankOfC = SIZES.reduce((sum,sz)=>sum+st.bank[c][sz],0);
          const canBuildTo4 = oppInHW + oppGreenSize >= 4 && bankOfC >= (4 - oppInHW - 1);

          if (canBuildTo4) {
            score -= 150; // green sacrifice catastrophe is possible
          } else if (oppInHW >= 1 && bankOfC >= 2) {
            score -= 40; // building toward it
          }
        }
      });
    }

    // ── DETECTOR 4: Hyperspace bypass ─────────────
    // After opponent destroys one of my HW stars, my HW gains
    // new connections (connected to all systems of destroyed star's SIZE)
    // This can suddenly make my HW reachable from unexpected systems
    if (myHW && myHW.stars.length === 1) {
      // Already lost one star — HW is now connected to more systems
      const remainingStar = myHW.stars[0];
      // Systems that connect via the destroyed star's size
      // (any system NOT containing remainingStar.size is now connected)
      let newConnections = 0;
      st.systems.forEach(sys => {
        if (sys.id===myHW.id) return;
        if (!connected(sys, myHW)) return; // already connected normally
        // Count opp ships in newly reachable systems
        newConnections += sys.ships.filter(s=>s.owner===opp).length;
      });
      score -= newConnections * 8; // more opp ships reachable = more danger
    }

    // ── DETECTOR 5: Post-catastrophe bank refresh ──
    // If I trigger a catastrophe, pieces return to bank
    // Opponent might immediately rebuild the piece I just destroyed
    // Check: after eligible cata, would opp benefit from returned pieces?
    cataEligible(st).forEach(({sysId, color}) => {
      const sys = sysById(st, sysId);
      if (!sys) return;
      // Count pieces that would return to bank
      const returning = sys.stars.filter(s=>s.color===color).length
                      + sys.ships.filter(s=>s.color===color).length;
      // Would opponent benefit? If they lack this color and bank is low
      const bankBefore = SIZES.reduce((sum,sz)=>sum+st.bank[color][sz],0);
      if (!oppColors.has(color) && bankBefore + returning >= 2) {
        score -= 15; // opp gets first pick of returned pieces
      }
      // If it's my own HW star color that would return — very bad
      if (myHW && myHW.stars.some(s=>s.color===color)) {
        score -= 25;
      }
    });

    // ── DETECTOR 6: Complete swift victory ─────────
    // Don't destroy star 1 without star 2 ready
    // If I have pressure on one opp star, check if star 2 is also ready
    if (oppHW && oppHW.stars.length === 2) {
      oppHW.stars.forEach((star, idx) => {
        const c = star.color;
        const pressure = cataPressure(oppHW, c);
        if (pressure >= 3) {
          // I'm about to destroy star 1 — is star 2 also ready?
          const otherStar = oppHW.stars[1-idx];
          const otherC    = otherStar.color;
          const otherPressure = st.systems.reduce((sum,sys) => {
            if (sys.id===oppHW.id) return sum;
            if (!connected(sys,oppHW)) return sum;
            return sum + sys.ships.filter(s=>s.owner===p&&s.color===otherC).length;
          }, cataPressure(oppHW, otherC));

          if (otherPressure >= 2) {
            score += 40; // star 2 also being set up — good plan
          } else {
            score -= 20; // destroying star 1 gives opp free turn, star 2 not ready
          }
        }
      });
    }

    return score;
  }

  // ── 3-ply minimax ──────────────────────────────────────────
  let _recentHashes = [];

  function boardHash(st, p) {
    return st.systems.map(sys =>
      sys.id+':'+sys.ships.filter(s=>s.owner===p).map(s=>s.color[0]+s.size).sort().join(',')
    ).sort().join('|');
  }

  function minimax(st, depth, alpha, beta, maximizing, rootPlayer, style) {
    if (isWin(st, rootPlayer))  return  10000;
    if (isLoss(st, rootPlayer)) return -10000;
    if (depth===0) return evaluate(st, rootPlayer, style);

    const p = maximizing ? rootPlayer : 3-rootPlayer;
    const moves = generateMoves(st, p);
    moves.sort((a,b) => moveOrder(b,st,p) - moveOrder(a,st,p));

    if (maximizing) {
      let best = -Infinity;
      for (const move of moves) {
        const st2 = applyMove(st, move, p);
        const loopP = _recentHashes.includes(boardHash(st2,rootPlayer)) ? -25 : 0;
        const passP = move.type==='pass' ? (evaluate(st,rootPlayer,style)<-50 ? -2 : -15) : 0;
        const val = minimax(st2, depth-1, alpha, beta, false, rootPlayer, style) + loopP + passP;
        if (val>best) best=val;
        alpha = Math.max(alpha, best);
        if (beta<=alpha) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const move of moves) {
        const st2 = applyMove(st, move, p);
        const val = minimax(st2, depth-1, alpha, beta, true, rootPlayer, style);
        if (val<best) best=val;
        beta = Math.min(beta, best);
        if (beta<=alpha) break;
      }
      return best;
    }
  }

  function pickMove(G, aiPlayer, style) {
    style = style || 'consensus';

    // Defensive override: if losing badly, ignore style and play defensively
    const currentScore = evaluate(G, aiPlayer, style);
    const effectiveStyle = currentScore < -60 ? 'consensus' : style;

    const moves = generateMoves(G, aiPlayer);
    moves.sort((a,b) => moveOrder(b,G,aiPlayer) - moveOrder(a,G,aiPlayer));

    let bestMove  = moves[moves.length-1];
    let bestScore = -Infinity;

    for (const move of moves) {
      const st1 = applyMove(G, move, aiPlayer);
      if (isWin(st1, aiPlayer)) { _recentHashes=[]; return move; }
      const loopP = _recentHashes.includes(boardHash(st1,aiPlayer)) ? -25 : 0;
      const passP = move.type==='pass' ? (currentScore<-50 ? -2 : -15) : 0;
      const val = minimax(st1, 2, -Infinity, Infinity, false, aiPlayer, effectiveStyle)
                + loopP + passP;
      if (val>bestScore) { bestScore=val; bestMove=move; }
    }

    const chosen = applyMove(G, bestMove, aiPlayer);
    _recentHashes.push(boardHash(chosen, aiPlayer));
    if (_recentHashes.length>8) _recentHashes.shift();

    return bestMove;
  }

  // ── Setup advisor ──────────────────────────────────────────
  function pickSetup(bank, oppStars, style) {
    style = style || 'consensus';
    oppStars = oppStars || [];

    const oppStarColors = new Set(oppStars.map(s=>s.color));
    const oppStarSizes  = new Set(oppStars.map(s=>s.size));

    // ── Instafreeze (going 2nd): opp has small star of color X ──
    // Pick same color small + green ship to build last small and freeze them
    for (const oppStar of oppStars) {
      if (oppStar.size === 1 && bank[oppStar.color][1] > 0) {
        const c = oppStar.color;
        // Only instafreeze blue or green — most impactful
        if (c === 'blue' || c === 'green') {
          let star2 = null;
          for (const c2 of ['yellow','blue','green','red']) {
            for (const sz of [2,3,1]) {
              if (bank[c2][sz]>0 && sz!==1 && !(c2===c&&sz===1)) {
                star2 = { color:c2, size:sz }; break;
              }
            }
            if (star2) break;
          }
          if (star2) {
            const shipColor = bank['green'][3]>0 ? 'green'
                            : bank['yellow'][3]>0 ? 'yellow' : 'green';
            return { star1:{ color:c, size:1 }, star2, shipColor };
          }
        }
      }
    }

    // ── Style-based star size preferences ──
    // Banker: large stars (connect to large systems for investment)
    // Fortress: small stars (hard to invade late)
    // QuickStart/Consensus: medium stars
    // PDS: medium — red star preferred
    let sizePref;
    switch (style) {
      case 'banker':     sizePref = [3,2,1]; break;
      case 'fortress':   sizePref = [1,2,3]; break;
      case 'quickstart': sizePref = [2,3,1]; break;
      case 'pds':        sizePref = [2,3,1]; break;
      default:           sizePref = [2,3,1]; break; // consensus
    }

    // ── Star 1 color preference by style ──
    let star1Colors;
    switch (style) {
      case 'pds':
        // PDS: red star preferred as star1 (planetary defense system)
        star1Colors = ['red','blue','yellow','green'];
        break;
      default:
        // All others: blue star strongly preferred
        star1Colors = ['blue','yellow','green','red'];
        break;
    }

    // Pick star1
    let star1 = null;
    for (const c of star1Colors) {
      for (const sz of sizePref) {
        if (bank[c][sz]>0) { star1={ color:c, size:sz }; break; }
      }
      if (star1) break;
    }

    // ── Avoid same size as opponent (prevent Small Universe) ──
    // Unless Fortress (small stars = intentional connectivity)
    let star2SizePref = [...sizePref];
    if (style !== 'fortress' && oppStarSizes.size > 0) {
      // Prefer sizes NOT in opponent's stars
      star2SizePref.sort((a,b) => {
        const aMatch = oppStarSizes.has(a) ? 1 : 0;
        const bMatch = oppStarSizes.has(b) ? 1 : 0;
        return aMatch - bMatch; // non-matching sizes first
      });
    }

    // ── Star 2 color preference by style ──
    let star2Colors;
    switch (style) {
      case 'pds':
        // PDS star1 = red, star2 = blue
        star2Colors = ['blue','yellow','green','red'];
        break;
      case 'quickstart':
        // QuickStart: yellow star for mobility
        star2Colors = ['yellow','blue','green','red'];
        break;
      default:
        // Consensus/Banker/Fortress: yellow star (2024 consensus)
        // Avoid red star — YaiHar monopoly risk
        star2Colors = ['yellow','blue','green','red'];
        break;
    }

    // Pick star2: different size from star1
    let star2 = null;
    for (const c of star2Colors) {
      for (const sz of star2SizePref) {
        if (bank[c][sz]>0 && sz!==star1.size && !(c===star1.color&&sz===star1.size)) {
          star2={ color:c, size:sz }; break;
        }
      }
      if (star2) break;
    }
    // Hard fallback
    if (!star2) {
      for (const c of COLORS) {
        for (const sz of SIZES) {
          if (bank[c][sz]>0 && sz!==star1.size && !(c===star1.color&&sz===star1.size)) {
            star2={ color:c, size:sz }; break;
          }
        }
        if (star2) break;
      }
    }

    // ── Ship color by style ──
    const hwColors = new Set([star1.color, star2?.color]);
    let shipColor = null;

    switch (style) {
      case 'quickstart':
        // Yellow ship — move out immediately turn 2
        for (const c of ['yellow','green','red','blue']) {
          if (bank[c][3]>0) { shipColor=c; break; }
        }
        break;
      case 'pds':
        // Red ship — instant defense
        for (const c of ['red','green','yellow','blue']) {
          if (bank[c][3]>0) { shipColor=c; break; }
        }
        break;
      default:
        // Consensus/Banker/Fortress: green ship (sacrifice g3 later for shopping spree)
        // If green already covered by star, pick yellow for mobility
        if (!hwColors.has('green') && bank['green'][3]>0) {
          shipColor='green';
        } else if (!hwColors.has('yellow') && bank['yellow'][3]>0) {
          shipColor='yellow';
        } else {
          for (const c of ['green','yellow','red','blue']) {
            if (bank[c][3]>0) { shipColor=c; break; }
          }
        }
        break;
    }
    shipColor = shipColor || 'green';

    return { star1, star2, shipColor };
  }

  // ── Public API ─────────────────────────────────────────────
  window.HW_AI = { pickMove, pickSetup, pickStyle };

})();
