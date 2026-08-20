/* ================================================
   NAJEEF QURAN API — SHARED BEHAVIOR
   Nav menu, scroll-reveal, button ripple, toasts
   ================================================ */

(function () {
  "use strict";

  /* ---------- Hamburger menu (shared across every page) ---------- */
  function initMenu() {
    const burgerBtn = document.getElementById("burgerBtn");
    const navLinks = document.getElementById("navLinks");
    const navOverlay = document.getElementById("navOverlay");
    if (!burgerBtn || !navLinks || !navOverlay) return;

    function toggleMenu(open) {
      burgerBtn.classList.toggle("open", open);
      navLinks.classList.toggle("open", open);
      navOverlay.classList.toggle("open", open);
      burgerBtn.setAttribute("aria-expanded", String(open));
      document.body.classList.toggle("menu-locked", open);
    }

    burgerBtn.addEventListener("click", () => toggleMenu(!navLinks.classList.contains("open")));
    navOverlay.addEventListener("click", () => toggleMenu(false));
    navLinks.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => toggleMenu(false))
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") toggleMenu(false);
    });
  }

  /* ---------- Scroll reveal ---------- */
  function initReveal() {
    const targets = document.querySelectorAll(
      ".hero, .facts-block .fact-row, .endpoint, .key-row, .cta-block, .auth-strip, .overview-stat, .manage-head, .login-panel"
    );
    if (!targets.length) return;

    if (!("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("in-view"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry, i) => {
          if (entry.isIntersecting) {
            const el = entry.target;
            el.style.transitionDelay = Math.min(i * 40, 200) + "ms";
            el.classList.add("in-view");
            io.unobserve(el);
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
    );

    targets.forEach((el) => {
      el.classList.add("reveal");
      io.observe(el);
    });
  }

  /* ---------- Button ripple + press feedback ---------- */
  function initRipple() {
    const selector =
      ".btn-primary, .btn-ghost, .btn-google, .btn-email-send, .btn-create-full, .btn-small-create, .cta-link, .btn-copy, .modal-done, .view-tab";

    document.addEventListener("click", (e) => {
      const btn = e.target.closest(selector);
      if (!btn || btn.disabled) return;

      const circle = document.createElement("span");
      circle.className = "ripple";
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      circle.style.width = circle.style.height = size + "px";
      circle.style.left = e.clientX - rect.left - size / 2 + "px";
      circle.style.top = e.clientY - rect.top - size / 2 + "px";

      const prevPos = getComputedStyle(btn).position;
      if (prevPos === "static") btn.style.position = "relative";
      btn.classList.add("ripple-host");
      btn.appendChild(circle);
      circle.addEventListener("animationend", () => circle.remove());
    });
  }

  /* ---------- Page load transition ---------- */
  function initPageTransition() {
    document.documentElement.classList.add("page-ready");
  }

  /* ---------- Copy buttons on <pre><code> blocks ---------- */
  function initCodeCopy() {
    document.querySelectorAll("pre > code").forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (pre.querySelector(".code-copy-btn")) return;
      pre.style.position = "relative";
      const btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.type = "button";
      btn.textContent = "Copy";
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(codeEl.textContent);
          btn.textContent = "Copied";
          btn.classList.add("copied");
          setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("copied");
          }, 1400);
        } catch (err) {
          btn.textContent = "Select & copy";
        }
      });
      pre.appendChild(btn);
    });
  }

  /* ---------- Docs: active quicknav link while scrolling ---------- */
  function initQuicknavActive() {
    const links = document.querySelectorAll(".quicknav a");
    const sections = document.querySelectorAll(".endpoint[id]");
    if (!links.length || !sections.length || !("IntersectionObserver" in window)) return;

    const map = new Map();
    links.forEach((a) => map.set(a.getAttribute("href").slice(1), a));

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const link = map.get(entry.target.id);
          if (!link) return;
          link.classList.toggle("active", entry.isIntersecting);
        });
      },
      { rootMargin: "-100px 0px -70% 0px" }
    );

    sections.forEach((s) => io.observe(s));
  }

  document.addEventListener("DOMContentLoaded", () => {
    initPageTransition();
    initMenu();
    initReveal();
    initRipple();
    initCodeCopy();
    initQuicknavActive();
  });
})();
