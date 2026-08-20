// ================================================
// NAJEEF QURAN API — FIREBASE AUTH MODULE
// ================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithRedirect,
  getRedirectResult,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBzLx9MVvPy5YV59F_a6FuIE8wv2ZZ6GQA",
  authDomain: "najeef-quran-api.firebaseapp.com",
  projectId: "najeef-quran-api",
  storageBucket: "najeef-quran-api.firebasestorage.app",
  messagingSenderId: "603740332753",
  appId: "1:603740332753:web:bfd1e968413726455e1bf0"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const EMAIL_STORAGE_KEY = "najeefQuranApi_emailForLink";

// ---------- Google Sign-In ----------
// Redirect flow is used instead of popup because popups get silently
// blocked by third-party cookie/storage partitioning in Chrome/Safari,
// which makes sign-in appear to hang with no redirect afterward.
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  await signInWithRedirect(auth, provider);
  // Browser navigates away here. Result is picked up by
  // completeGoogleRedirectSignIn() on the page the user lands back on.
}

// Call this on every page load (alongside completeMagicLinkSignIn) —
// completes the Google sign-in if this load is the return from a redirect.
export async function completeGoogleRedirectSignIn() {
  const result = await getRedirectResult(auth);
  return result ? result.user : null;
}

// ---------- Email Link (passwordless) ----------
export async function sendMagicLink(email) {
  const actionCodeSettings = {
    url: window.location.origin + "/index.html",
    handleCodeInApp: true
  };
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
  window.localStorage.setItem(EMAIL_STORAGE_KEY, email);
}

// Call this on every page load — completes the sign-in if the URL is a magic link
export async function completeMagicLinkSignIn() {
  if (!isSignInWithEmailLink(auth, window.location.href)) {
    return null;
  }

  let email = window.localStorage.getItem(EMAIL_STORAGE_KEY);

  if (!email) {
    email = window.prompt("Confirm your email to finish signing in:");
  }

  if (!email) return null;

  const result = await signInWithEmailLink(auth, email, window.location.href);
  window.localStorage.removeItem(EMAIL_STORAGE_KEY);

  // Clean the sign-in params out of the URL
  window.history.replaceState({}, document.title, window.location.pathname);

  return result.user;
}

// ---------- Session ----------
export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function logOut() {
  await signOut(auth);
}

export function getCurrentUser() {
  return auth.currentUser;
}

export async function getIdToken() {
  const user = auth.currentUser;
  if (!user) return null;
  return await user.getIdToken();
}
