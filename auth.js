// ============================================================
//  AUTH.JS  —  Firebase Auth + player profile + tier system
// ============================================================

import { initializeApp }                from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, GoogleAuthProvider,
         signInWithPopup, signOut as fbSignOut,
         onAuthStateChanged }           from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getDatabase, ref, get,
         set, update }                  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
import { firebaseConfig }               from './firebase-config.js';

const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getDatabase(app);

// ── Tier system ──────────────────────────────────────────────
export const TIERS = [
  { name: 'Iron',         min:0,  max:4,        color:'#8a9bb0', bg:'rgba(138,155,176,0.12)' },
  { name: 'Bronze',       min:5,  max:9,        color:'#cd7f32', bg:'rgba(205,127,50,0.12)'  },
  { name: 'Silver',       min:10, max:14,       color:'#c0c0c0', bg:'rgba(192,192,192,0.12)' },
  { name: 'Gold',         min:15, max:19,       color:'#ffd700', bg:'rgba(255,215,0,0.12)'   },
  { name: 'Platinum',     min:20, max:24,       color:'#00d4ff', bg:'rgba(0,212,255,0.12)'   },
  { name: 'Emerald',      min:25, max:29,       color:'#22dd77', bg:'rgba(34,221,119,0.12)'  },
  { name: 'Diamond',      min:30, max:34,       color:'#b9f2ff', bg:'rgba(185,242,255,0.12)' },
  { name: 'Master',       min:35, max:39,       color:'#9b59b6', bg:'rgba(155,89,182,0.12)'  },
  { name: 'Grandmaster',  min:40, max:44,       color:'#ff6b35', bg:'rgba(255,107,53,0.12)'  },
  { name: 'Star Captain', min:45, max:Infinity, color:'#ffcc00', bg:'rgba(255,204,0,0.12)'   },
];

export function getTier(stars = 0) {
  return TIERS.find(t => stars >= t.min && stars <= t.max) || TIERS[0];
}
export function tierProgressPct(stars = 0) {
  const t = getTier(stars);
  const span = t.max === Infinity ? 5 : (t.max - t.min + 1);
  return Math.min(((stars - t.min) / span) * 100, 100);
}
export function calcStarAward(winnerStars, loserStars) {
  return getTier(loserStars).min > getTier(winnerStars).min ? 2 : 1;
}

// ── Username uniqueness ──────────────────────────────────────
export async function isUsernameTaken(username) {
  const snap = await get(ref(db, `usernames/${username.toLowerCase()}`));
  return snap.exists();
}
export async function claimUsername(uid, username) {
  if (await isUsernameTaken(username)) throw new Error('Username already taken');
  await set(ref(db, `usernames/${username.toLowerCase()}`), uid);
  await update(ref(db, `players/${uid}`), { name: username });
}
export async function changeUsername(uid, oldName, newName) {
  const oldKey = oldName.toLowerCase(), newKey = newName.toLowerCase();
  if (oldKey !== newKey) {
    if (await isUsernameTaken(newName)) throw new Error('Username already taken');
    await set(ref(db, `usernames/${oldKey}`), null);
    await set(ref(db, `usernames/${newKey}`), uid);
  }
  await update(ref(db, `players/${uid}`), { name: newName });
}

// ── Auth ─────────────────────────────────────────────────────
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  const snap   = await get(ref(db, `players/${result.user.uid}`));
  return { user: result.user, isNew: !snap.exists() };
}
export async function signOutUser() {
  await fbSignOut(auth);
  window.location.href = 'index.html';
}
export function requireAuth(redirect = 'index.html') {
  return new Promise(resolve => {
    const unsub = onAuthStateChanged(auth, async user => {
      unsub();
      if (!user) { window.location.href = redirect; return; }
      const snap = await get(ref(db, `players/${user.uid}`));
      resolve({ user, player: snap.val() });
    });
  });
}
export async function getPlayer(uid) {
  const snap = await get(ref(db, `players/${uid}`));
  return snap.val();
}
export async function createPlayer(user, username) {
  if (await isUsernameTaken(username)) throw new Error('Username already taken');
  const profile = {
    uid: user.uid, name: username, elo: 1200, stars: 0,
    wins: 0, losses: 0, advancedMode: false,
    avatarUrl: user.photoURL || '', avatarBase64: '',
    createdAt: Date.now(),
  };
  await set(ref(db, `players/${user.uid}`), profile);
  await set(ref(db, `usernames/${username.toLowerCase()}`), user.uid);
  return profile;
}
export async function updatePlayer(uid, fields) {
  await update(ref(db, `players/${uid}`), fields);
}
export function calcElo(winnerElo, loserElo, k = 32) {
  const exp = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const delta = Math.round(k * (1 - exp));
  return { winnerNew: winnerElo + delta, loserNew: Math.max(100, loserElo - delta), delta };
}
export function onAuthChange(cb) { return onAuthStateChanged(auth, cb); }
