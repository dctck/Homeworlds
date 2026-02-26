// ============================================================
//  AUTH.JS
//  Wraps Firebase Auth + player profile management.
//  Import this on every page that needs auth.
//
//  Usage:
//    import { requireAuth, getPlayer, signOut } from './auth.js';
//    const player = await requireAuth(); // redirects to index if not logged in
// ============================================================

import { initializeApp }                          from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, GoogleAuthProvider,
         signInWithPopup, signOut as fbSignOut,
         onAuthStateChanged }                      from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getDatabase, ref, get, set, update }      from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
import { firebaseConfig }                          from './firebase-config.js';

// ── Init ─────────────────────────────────────────────────────
const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getDatabase(app);

// ── Sign in with Google ──────────────────────────────────────
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  await ensurePlayer(result.user);
  return result.user;
}

// ── Sign out ─────────────────────────────────────────────────
export async function signOut() {
  await fbSignOut(auth);
  window.location.href = '/Homeworlds/index.html';
}

// ── Get current auth user (null if not signed in) ────────────
export function currentUser() {
  return auth.currentUser;
}

// ── Require auth — redirect to landing if not signed in ──────
// Returns a Promise<playerProfile> once auth state is known.
export function requireAuth(redirectTo = '/Homeworlds/index.html') {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub();
      if (!user) {
        window.location.href = redirectTo;
        return;
      }
      try {
        const player = await getPlayer(user.uid);
        resolve(player);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ── Player profile ───────────────────────────────────────────

/** Read a player's profile from the DB */
export async function getPlayer(uid) {
  const snap = await get(ref(db, `players/${uid}`));
  return snap.exists() ? snap.val() : null;
}

/** Create player profile on first login if it doesn't exist */
export async function ensurePlayer(user) {
  const r    = ref(db, `players/${user.uid}`);
  const snap = await get(r);
  if (!snap.exists()) {
    const defaultName = user.displayName || user.email?.split('@')[0] || 'Pilot';
    await set(r, {
      uid:          user.uid,
      name:         defaultName,
      elo:          1200,
      wins:         0,
      losses:       0,
      advancedMode: false,
      avatarUrl:    user.photoURL || '',
      createdAt:    Date.now(),
    });
  }
  return (await get(r)).val();
}

/** Update specific fields on a player profile */
export async function updatePlayer(uid, fields) {
  await update(ref(db, `players/${uid}`), fields);
}

// ── ELO calculation ──────────────────────────────────────────
export function calcElo(winnerElo, loserElo, kFactor = 32) {
  const expected = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const delta    = Math.round(kFactor * (1 - expected));
  return {
    winnerNew: winnerElo + delta,
    loserNew:  Math.max(100, loserElo - delta),
    delta,
  };
}

// ── Auth state change helper ─────────────────────────────────
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}
