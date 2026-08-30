(function registerLongboxPwa() {
  if (!("serviceWorker" in navigator)) return;

  const SW_URL = "service-worker.js?v=2";

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(SW_URL)
      .then((reg) => {
        if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
        reg.update().catch(() => {});
      })
      .catch(() => {});

    let refreshing = false;
    const reloadOnce = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", reloadOnce);
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "LONGBOX_SW_UPDATED") reloadOnce();
    });
  });
})();
