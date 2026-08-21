// ================================================
// NAJEEF QURAN API — FIREBASE AUTH MODULE
// ================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
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

// ---------- Google Identity Services (One Tap + inline button) ----------
// This replaces the old signInWithRedirect flow. GIS runs in a floating
// overlay / inline button on top of the current page — no navigation away
// and back, so there's nothing that can get "stuck" mid-redirect.
const GOOGLE_CLIENT_ID = "603740332753-7cdsq60g9c9n6bkn3d8ihb4od6ad7ha2.apps.googleusercontent.com";

let gisLoadPromise = null;
function loadGoogleIdentityScript() {
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Couldn't load Google Sign-In."));
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

// Exchanges the ID token GIS hands back (from One Tap or the button) for a
// real Firebase session. onAuthStateChanged fires from this automatically.
// On failure, dispatches a "gis-auth-error" event on window so the page can
// surface a message without needing its own try/catch around GIS's callback.
async function handleGoogleCredential(response) {
  try {
    const credential = GoogleAuthProvider.credential(response.credential);
    await signInWithCredential(auth, credential);
  } catch (err) {
    window.dispatchEvent(new CustomEvent("gis-auth-error", { detail: err }));
  }
}

let gisInitialized = false;
async function ensureGisInitialized() {
  await loadGoogleIdentityScript();
  if (gisInitialized) return;
  window.google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true
  });
  gisInitialized = true;
}

// Call once per page load. Shows the floating One Tap prompt automatically
// if the browser/user is eligible. Safe to call even if it ends up not
// showing anything (already dismissed recently, no eligible session, etc.)
// — that's normal Google behavior, not an error.
export async function initGoogleOneTap() {
  try {
    await ensureGisInitialized();
    window.google.accounts.id.prompt();
  } catch (err) {
    console.warn("One Tap unavailable:", err);
  }
}

// Renders an actual "Sign in with Google" button inside the given element.
// Use this as the manual login CTA wherever a locked/logged-out action is.
export async function renderGoogleButton(elementId, options = {}) {
  await ensureGisInitialized();
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = "";
  window.google.accounts.id.renderButton(el, {
    theme: "outline",
    size: "large",
    shape: "pill",
    text: "signin_with",
    width: 280,
    ...options
  });
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
