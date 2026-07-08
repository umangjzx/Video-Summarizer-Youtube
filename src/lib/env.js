import { config as loadEnv } from "dotenv";
import fs from "fs";

// Supports both `.env` (standard) and the older `main.env` this project started with,
// so existing local setups keep working without renaming anything.
const envPath = fs.existsSync(".env") ? ".env" : fs.existsSync("main.env") ? "main.env" : undefined;
if (envPath) loadEnv({ path: envPath, quiet: true });

export function requireApiKey() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.error(
      "FATAL: YOUTUBE_API_KEY is not set. Put it in a .env file (YOUTUBE_API_KEY=...) or export it in your shell."
    );
    process.exit(1);
  }
  return key;
}
