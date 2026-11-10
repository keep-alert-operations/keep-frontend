import { checkAuthSession, startSessionPolling } from "./authChecker.js";

const form = document.querySelector("#kc-form-login");
const submit = document.querySelector("#kc-login");
const password = document.querySelector("#password");
const eye = document.querySelector(".ap-eye");
const appearance = document.querySelector(".ap-appearance");

function updateAppearance() {
  appearance.querySelector("span").textContent =
    document.documentElement.dataset.theme === "dark"
      ? "Light mode"
      : "Dark mode";
}
updateAppearance();
appearance.hidden = false;
appearance.addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("keep-theme", next);
  } catch {
    // The selection still applies when browser storage is unavailable.
  }
  updateAppearance();
});

if (eye && password) {
  eye.hidden = false;
  eye.addEventListener("click", () => {
    const reveal = password.type === "password";
    password.type = reveal ? "text" : "password";
    eye.setAttribute("aria-pressed", String(reveal));
    eye.setAttribute(
      "aria-label",
      reveal ? eye.dataset.hide : eye.dataset.show,
    );
    eye.querySelector(".ap-eye-slash").toggleAttribute("hidden", !reveal);
  });
}

function ready() {
  if (!submit) return;
  submit.disabled = false;
  submit.removeAttribute("aria-busy");
  submit.querySelector(".ap-submit-label").textContent = "Sign in";
}
form?.addEventListener("submit", (event) => {
  if (submit.disabled) {
    event.preventDefault();
    return;
  }
  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");
  submit.querySelector(".ap-submit-label").textContent = "Signing in…";
});
window.addEventListener("pageshow", ready);

// Retain the installed Keycloak theme's cross-tab authentication checks.
startSessionPolling(document.body.dataset.ssoCheck);
if (document.body.dataset.authSession) {
  checkAuthSession(document.body.dataset.authSession);
}
