/* ==========================================================
   Hub bridge — reports results up to the ChanceITstudio games hub.
   No-ops when the game is opened standalone (not in an iframe), so it's
   safe to ship in both cases. Contract: see the hub repo's CONTRACT.md.
   ========================================================== */
(function () {
  if (window.parent === window) return;            // not embedded → no-op
  const GAME_ID = "bullseye";
  function send(type, payload) {
    parent.postMessage(
      { src: "chanceit-game", v: 1, gameId: GAME_ID, type, payload },
      "*"                                            // hub validates origin on receive
    );
  }
  window.HubBridge = {
    ready: () => send("ready"),
    score: (p) => send("score", p),
    event: (name, details) => send("event", { name, ...(details || {}) }),
  };
  HubBridge.ready();
})();