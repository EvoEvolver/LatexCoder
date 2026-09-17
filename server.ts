import { fileURLToPath } from "node:url";

export { createPaperServer, safeRelativePath, startPaperServer } from "./src/server/app.ts";
import { startPaperServer } from "./src/server/app.ts";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paper = await startPaperServer();
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    paper.shutdown();
    paper.sockets.close();
    paper.server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
