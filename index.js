// Runs in the headless iframe (loads with the board, runs as long as the board is open).
// Its only job: when the user clicks the app's toolbar icon, open the search panel.
async function init() {
  await miro.board.ui.on("icon:click", async () => {
    await miro.board.ui.openPanel({ url: "app.html" });
  });
}

init();
