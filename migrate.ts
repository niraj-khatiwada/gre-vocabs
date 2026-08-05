import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "fs";
import { basename, join } from "path";

// Initialize SQLite database
const db = new Database("vocab.sqlite", { create: true });

// Create schema
db.run(`
  CREATE TABLE IF NOT EXISTS vocab (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    ref TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'active' -- 'active' or 'completed'
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS session_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    vocab_id INTEGER NOT NULL,
    card_order INTEGER NOT NULL,
    status TEXT DEFAULT 'unseen', -- 'unseen', 'correct', 'incorrect'
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    FOREIGN KEY(vocab_id) REFERENCES vocab(id)
  );
`);

// Prepared statement with ON CONFLICT (UPSERT)
const upsertVocab = db.prepare(`
  INSERT INTO vocab (name, ref, text, created_at, updated_at)
  VALUES ($name, $ref, $text, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(name) DO UPDATE SET
    ref = excluded.ref,
    text = excluded.text,
    updated_at = CURRENT_TIMESTAMP
`);

const ROOT_DIR = ".";
const GRE_DIR = join(ROOT_DIR, "GRE");

function getFriendlyRefName(filePath: string): string {
  const fileName = basename(filePath, ".md");
  return fileName.replace(/\s+[a-f0-9]{32}$/i, "").trim();
}

const rootFiles = Array.from(new Bun.Glob("GRE*.md").scanSync(ROOT_DIR));
if (rootFiles.length === 0) {
  console.error("Error: Could not find the main GRE index markdown file.");
  process.exit(1);
}

const mainIndexFile = rootFiles[0];
console.log(`Found index file: ${mainIndexFile}`);

const indexContent = readFileSync(mainIndexFile, "utf-8");
const markdownLinkRegex = /\[([^\]]+)\]\((GRE\/[^\)]+\.md)\)/g;

const orderedPaths: string[] = [];
const processedPaths = new Set<string>();

let match;
while ((match = markdownLinkRegex.exec(indexContent)) !== null) {
  const decodedPath = decodeURIComponent(match[2]);
  if (!processedPaths.has(decodedPath)) {
    orderedPaths.push(decodedPath);
    processedPaths.add(decodedPath);
  }
}

if (existsSync(GRE_DIR)) {
  const allGreFiles = Array.from(new Bun.Glob("*.md").scanSync(GRE_DIR));
  for (const file of allGreFiles) {
    const fullRelativePath = join("GRE", file);
    if (!processedPaths.has(fullRelativePath)) {
      orderedPaths.push(fullRelativePath);
      processedPaths.add(fullRelativePath);
    }
  }
}

let processedCount = 0;

db.transaction(() => {
  for (const partPath of orderedPaths) {
    if (!existsSync(partPath)) {
      console.warn(`Warning: File not found -> ${partPath}`);
      continue;
    }

    const refName = getFriendlyRefName(partPath);
    const content = readFileSync(partPath, "utf-8");
    const entries = content.split(/\n(?=- \*\*)/);

    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      const headerMatch = trimmed.match(/^- \*\*([^*]+)\*\*/);
      if (!headerMatch) continue;

      const wordName = headerMatch[1].trim();

      upsertVocab.run({
        $name: wordName,
        $ref: refName,
        $text: trimmed,
      });

      processedCount++;
    }
  }
})();

console.log(`Successfully synced ${processedCount} words across all files.`);
