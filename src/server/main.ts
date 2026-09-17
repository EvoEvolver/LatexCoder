import { fileURLToPath } from "node:url";

import { startPaperServer } from "./app.ts";

export { createPaperServer, safeRelativePath, startPaperServer } from "./app.ts";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paper = await startPaperServer();
  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    paper.shutdown();
    paper.sockets.close();
    paper.server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
