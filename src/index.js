import { requireApiKey } from "./lib/env.js";
import { createApp } from "./app.js";

const app = createApp({ apiKey: requireApiKey() });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.error(`youtube-mcp-server listening on port ${PORT}, endpoint: /mcp`);
});
