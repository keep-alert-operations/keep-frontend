// Apply appearance before paint. Credentials and identity never enter storage.
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("keep-theme") === "dark" ? "dark" : "light";
} catch {
  document.documentElement.dataset.theme = "light";
}
