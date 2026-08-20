import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync } from "fs";

const dbPath =
  Bun.env.NODE_ENV === "production" ? "/app/data/vocab.sqlite" : "vocab.sqlite";

if (!existsSync(dbPath)) {
  console.log(`Database file not found at ${dbPath}. Executing migrate.ts...`);

  const migration = Bun.spawnSync(["bun", "./migrate.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  });

  if (migration.exitCode !== 0) {
    console.error("Migration failed! Halting startup.");
    process.exit(1);
  }

  console.log("Migration finished successfully.");
}

const db = new Database(dbPath);

// Initialize Schema Additions
db.run(`
  CREATE TABLE IF NOT EXISTS vocab_mastery (
    vocab_id INTEGER PRIMARY KEY,
    box INTEGER DEFAULT 1, -- 1: Learning, 2: Reviewing, 3: Learned
    next_review_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(vocab_id) REFERENCES vocab(id)
  );
`);

try {
  db.run(`ALTER TABLE session_cards ADD COLUMN attempted INTEGER DEFAULT 0`);
} catch {
  // already ran
}

// Fisher-Yates Shuffle Helper
function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const PORT = 8080;

Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Serve Local Images from GRE/ folder
    if (pathname.match(/\.(png|jpg|jpeg|gif|webp)$/i)) {
      // Strip leading slash to prevent join() from treat it as root path
      const relativePath = decodeURIComponent(pathname).replace(/^\//, "");
      const imagePath = join(process.cwd(), `/GRE/${relativePath}`);

      console.log(imagePath);

      const file = Bun.file(imagePath);
      if (await file.exists()) {
        return new Response(file);
      }

      return new Response("Image not found", { status: 404 });
    }

    // API: Vocabulary Search
    if (pathname === "/api/search" && req.method === "GET") {
      const query = url.searchParams.get("q") || "";
      if (!query.trim()) return Response.json([]);

      const results = db
        .prepare(
          `
        SELECT id, name, ref, text
        FROM vocab
        WHERE name LIKE ? OR text LIKE ?
        LIMIT 20
      `,
        )
        .all(`%${query}%`, `%${query}%`);

      return Response.json(results);
    }

    // API: Get List of Sessions with Mastery Stats
    if (pathname === "/api/sessions" && req.method === "GET") {
      const sessions = db
        .prepare(
          `
        SELECT
          s.id,
          s.created_at,
          s.status,
          COUNT(sc.id) as total_cards,
          SUM(CASE WHEN sc.attempted = 1 THEN 1 ELSE 0 END) as attempted_cards,
          SUM(CASE WHEN sc.status = 'correct' THEN 1 ELSE 0 END) as correct_cards
        FROM sessions s
        LEFT JOIN session_cards sc ON s.id = sc.session_id
        GROUP BY s.id
        ORDER BY s.id DESC
      `,
        )
        .all();

      const masteryStats = db
        .prepare(
          `
        SELECT
          SUM(CASE WHEN COALESCE(vm.box, 1) = 1 THEN 1 ELSE 0 END) as learning,
          SUM(CASE WHEN vm.box = 2 THEN 1 ELSE 0 END) as reviewing,
          SUM(CASE WHEN vm.box = 3 THEN 1 ELSE 0 END) as learned,
          COUNT(v.id) as total
        FROM vocab v
        LEFT JOIN vocab_mastery vm ON v.id = vm.vocab_id
      `,
        )
        .get();

      return Response.json({ sessions, masteryStats });
    }

    // API: Delete Session
    const deleteSessionMatch = pathname.match(/^\/api\/sessions\/(\d+)$/);
    if (deleteSessionMatch && req.method === "DELETE") {
      const sessionId = Number(deleteSessionMatch[1]);

      db.transaction(() => {
        db.prepare("DELETE FROM session_cards WHERE session_id = ?").run(
          sessionId,
        );
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);

        // Check if any sessions remain
        const count = db
          .prepare("SELECT COUNT(*) as count FROM sessions")
          .get() as { count: number };

        // Clear all global mastery states if no sessions exist
        if (count.count === 0) {
          db.prepare("DELETE FROM vocab_mastery").run();
        }
      })();

      return Response.json({ success: true });
    }

    // API: Resync Missing Words into Active Sessions
    if (pathname === "/api/sessions/resync" && req.method === "POST") {
      const activeSessions = db
        .prepare("SELECT id FROM sessions WHERE status = 'active'")
        .all() as { id: number }[];
      let totalAdded = 0;

      db.transaction(() => {
        for (const session of activeSessions) {
          const missingVocab = db
            .prepare(
              `
            SELECT v.id
            FROM vocab v
            WHERE v.id NOT IN (
              SELECT vocab_id FROM session_cards WHERE session_id = ?
            )
          `,
            )
            .all(session.id) as { id: number }[];

          if (missingVocab.length > 0) {
            const maxOrderRow = db
              .prepare(
                `
              SELECT COALESCE(MAX(card_order), -1) as max_order
              FROM session_cards
              WHERE session_id = ?
            `,
              )
              .get(session.id) as { max_order: number };

            let startOrder = maxOrderRow.max_order + 1;
            const shuffledMissing = shuffle([...missingVocab]);

            const insertCard = db.prepare(`
              INSERT INTO session_cards (session_id, vocab_id, card_order, status)
              VALUES ($session_id, $vocab_id, $card_order, 'unseen')
            `);

            shuffledMissing.forEach((item, index) => {
              insertCard.run({
                $session_id: session.id,
                $vocab_id: item.id,
                $card_order: startOrder + index,
              });
              totalAdded++;
            });
          }
        }
      })();

      return Response.json({ success: true, added_cards: totalAdded });
    }

    // API: Reset All Progress
    if (pathname === "/api/sessions/reset" && req.method === "POST") {
      db.transaction(() => {
        db.prepare("DELETE FROM session_cards").run();
        db.prepare("DELETE FROM sessions").run();
        db.prepare("DELETE FROM vocab_mastery").run();
      })();
      return Response.json({ success: true });
    }

    // API: Start a New Session
    if (pathname === "/api/sessions" && req.method === "POST") {
      if (pathname === "/api/sessions" && req.method === "POST") {
        const activeVocab = db
          .prepare(
            `
          SELECT v.id, COALESCE(vm.box, 1) as box
          FROM vocab v
          LEFT JOIN vocab_mastery vm ON v.id = vm.vocab_id
          WHERE COALESCE(vm.box, 1) < 3
        `,
          )
          .all() as { id: number; box: number }[];

        if (activeVocab.length === 0) {
          return Response.json(
            { message: "All words have been mastered!" },
            { status: 200 },
          );
        }

        const box1 = shuffle(activeVocab.filter((v) => v.box === 1));
        const box2 = shuffle(activeVocab.filter((v) => v.box === 2));
        const shuffledVocab = shuffle([...box1, ...box2]);

        let sessionId = 0;
        db.transaction(() => {
          const res = db
            .prepare("INSERT INTO sessions (status) VALUES ('active')")
            .run();
          sessionId = Number(res.lastInsertRowid);

          const insertCard = db.prepare(`
            INSERT INTO session_cards (session_id, vocab_id, card_order, status)
            VALUES ($session_id, $vocab_id, $card_order, 'unseen')
          `);

          shuffledVocab.forEach((item, index) => {
            insertCard.run({
              $session_id: sessionId,
              $vocab_id: item.id,
              $card_order: index,
            });
          });
        })();

        return Response.json({ id: sessionId });
      }
    }

    // API: Get Next Unseen Card in Session
    const cardMatch = pathname.match(/^\/api\/sessions\/(\d+)\/next$/);
    if (cardMatch && req.method === "GET") {
      const sessionId = Number(cardMatch[1]);

      const nextCard = db
        .prepare(
          `
        SELECT sc.id as session_card_id, v.id as vocab_id, v.name, v.text, v.ref
        FROM session_cards sc
        JOIN vocab v ON sc.vocab_id = v.id
        WHERE sc.session_id = ? AND sc.status = 'unseen'
        ORDER BY sc.card_order ASC
        LIMIT 1
      `,
        )
        .get(sessionId) as {
        session_card_id: number;
        vocab_id: number;
        name: string;
        text: string;
        ref: string;
      } | null;

      const stats = db
        .prepare(
          `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN attempted = 1 THEN 1 ELSE 0 END) as attempted,
          SUM(CASE WHEN status = 'correct' THEN 1 ELSE 0 END) as correct
        FROM session_cards
        WHERE session_id = ?
      `,
        )
        .get(sessionId);

      let options: string[] = [];
      if (nextCard) {
        const distractors = db
          .prepare(
            `
          SELECT name FROM vocab WHERE id != ? ORDER BY RANDOM() LIMIT 3
        `,
          )
          .all(nextCard.vocab_id) as { name: string }[];

        options = shuffle([nextCard.name, ...distractors.map((d) => d.name)]);
      }

      return Response.json({ card: nextCard || null, stats, options });
    }

    // API: Answer Card & Update Mastery Boxes
    const answerMatch = pathname.match(/^\/api\/cards\/(\d+)\/answer$/);
    if (answerMatch && req.method === "POST") {
      const sessionCardId = Number(answerMatch[1]);
      const { answer } = (await req.json()) as {
        answer: "correct" | "incorrect";
      };

      db.transaction(() => {
        db.prepare("UPDATE session_cards SET attempted = 1 WHERE id = ?").run(
          sessionCardId,
        );

        const card = db
          .prepare(
            `
          SELECT session_id, vocab_id FROM session_cards WHERE id = ?
        `,
          )
          .get(sessionCardId) as { session_id: number; vocab_id: number };

        if (answer === "correct") {
          db.prepare(
            "UPDATE session_cards SET status = 'correct' WHERE id = ?",
          ).run(sessionCardId);
        } else {
          const maxOrder = db
            .prepare(
              `SELECT COALESCE(MAX(card_order), -1) as max_order FROM session_cards WHERE session_id = ?`,
            )
            .get(card.session_id) as { max_order: number };
          db.prepare(
            "UPDATE session_cards SET status = 'unseen', card_order = ? WHERE id = ?",
          ).run(maxOrder.max_order + 1, sessionCardId);
        }

        const existingMastery = db
          .prepare(
            `
          SELECT box FROM vocab_mastery WHERE vocab_id = ?
        `,
          )
          .get(card.vocab_id) as { box: number } | null;

        let newBox = 1;
        if (answer === "correct") {
          const currentBox = existingMastery ? existingMastery.box : 1;
          newBox = Math.min(currentBox + 1, 3);
        } else {
          newBox = 1;
        }

        db.prepare(
          `
          INSERT INTO vocab_mastery (vocab_id, box, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(vocab_id) DO UPDATE SET
            box = excluded.box,
            updated_at = CURRENT_TIMESTAMP
        `,
        ).run(card.vocab_id, newBox);

        const remaining = db
          .prepare(
            `
          SELECT COUNT(*) as count FROM session_cards WHERE session_id = ? AND status = 'unseen'
        `,
          )
          .get(card.session_id) as { count: number };

        if (remaining.count === 0) {
          db.prepare(
            "UPDATE sessions SET status = 'completed' WHERE id = ?",
          ).run(card.session_id);
        }
      })();

      return Response.json({ success: true });
    }

    if (pathname === "/") {
      return new Response(HTML_CONTENT, {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Flashcard App running at http://localhost:${PORT}`);
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GRE Vocabulary Practice</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --border: #334155;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; }

    .container { width: 100%; max-width: 650px; }
    header { text-align: center; margin-bottom: 2rem; }
    h1 { font-size: 2.2rem; margin-bottom: 0.5rem; }
    p.subtitle { color: var(--muted); }

    .btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 0.75rem 1.25rem;
      font-size: 0.95rem;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--text); }
    .btn-secondary:hover { background: var(--border); }
    .btn-danger { background: transparent; border: 1px solid var(--danger); color: var(--danger); padding: 0.4rem 0.8rem; }
    .btn-danger:hover { background: var(--danger); color: white; }

    /* Mastery Tracker Bar */
    .mastery-tracker {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.75rem;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem;
      margin-bottom: 1.5rem;
      text-align: center;
    }
    .mastery-box .count { font-size: 1.5rem; font-weight: bold; }
    .mastery-box.learning .count { color: var(--danger); }
    .mastery-box.reviewing .count { color: var(--warning); }
    .mastery-box.learned .count { color: var(--success); }
    .mastery-box .label { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; margin-top: 0.2rem; }

    /* Dashboard */
    .dashboard { display: flex; flex-direction: column; gap: 1rem; }
    .action-bar { display: flex; justify-content: space-between; align-items: center; }
    .button-group { display: flex; gap: 0.5rem; }
    .session-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .session-item {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .session-item:hover { border-color: var(--primary); }
    .badge { padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; background: var(--border); }
    .badge.completed { background: var(--success); color: #000; }

    /* Card Practice View */
    .card-view { display: none; flex-direction: column; gap: 1.25rem; margin-top: 1rem; }
    .card-header { display: flex; justify-content: space-between; align-items: center; color: var(--muted); }
    .mode-toggle { display: flex; gap: 0.5rem; background: var(--card-bg); padding: 0.2rem; border-radius: 8px; border: 1px solid var(--border); }
    .mode-btn { background: transparent; border: none; color: var(--muted); padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
    .mode-btn.active { background: var(--primary); color: white; }

    .flashcard {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.5rem 1.5rem;
      min-height: 320px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3);
      width: 100%;
      overflow-x: hidden;
    }
    .word { font-size: 2.5rem; font-weight: 700; margin-bottom: 1rem; color: #fff; }
    .markdown-content {
      text-align: left;
      width: 100%;
      margin-top: 1.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      line-height: 1.6;
      word-wrap: break-word;
      overflow-wrap: break-word;
      font-size: 1.2rem;
    }
    .markdown-content img { max-width: 100%; height: auto; border-radius: 8px; margin: 1rem 0; }

    .actions { display: flex; gap: 1rem; justify-content: center; width: 100%; margin-top: 1rem; }
    .btn-right { background: var(--success); flex: 1; }
    .btn-wrong { background: var(--danger); flex: 1; }

    /* Quiz Option Grid */
    .quiz-options { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; width: 100%; margin-top: 1rem; }
    .quiz-opt-btn {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 1rem;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      text-align: center;
      word-wrap: break-word;
    }
    .quiz-opt-btn:hover { border-color: var(--primary); }

    /* Completion View */
    .completion-view { display: none; text-align: center; padding: 3rem 1rem; }
    .score { font-size: 3rem; font-weight: bold; color: var(--success); margin: 1rem 0; }

    /* Search & Modals */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(4px);
      z-index: 100;
      justify-content: center;
      align-items: flex-start;
      padding-top: 5rem;
    }
    .modal-content {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 100%;
      max-width: 600px;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);
      max-height: 80vh;
      overflow-y: auto;
    }
    .search-input {
      width: 100%;
      padding: 0.8rem 1rem;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 8px;
      font-size: 1.1rem;
    }
    .search-input:focus { outline: none; border-color: var(--primary); }
    .search-results { display: flex; flex-direction: column; gap: 0.5rem; }
    .result-item {
      padding: 0.8rem 1rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .result-item:hover { border-color: var(--primary); }

    /* Loading Spinner */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid var(--border);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      margin: 2rem auto;
    }
    .spinner-sm {
      width: 16px; height: 16px;
      border-width: 2px;
      display: inline-block;
      vertical-align: middle;
      margin-right: 0.4rem;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>GRE Vocabulary Flashcards</h1>
      <p class="subtitle">Spaced retention & practice deck</p>
    </header>

    <!-- Home View -->
    <div id="view-home" class="dashboard">
      <div class="mastery-tracker">
        <div class="mastery-box learning">
          <div id="count-learning" class="count">0</div>
          <div class="label">Learning</div>
        </div>
        <div class="mastery-box reviewing">
          <div id="count-reviewing" class="count">0</div>
          <div class="label">Reviewing</div>
        </div>
        <div class="mastery-box learned">
          <div id="count-learned" class="count">0</div>
          <div class="label">Learned</div>
        </div>
      </div>

      <div class="action-bar">
        <h2>Sessions</h2>
        <div class="button-group">
          <button class="btn btn-danger" onclick="resetAll()">Reset All</button>
          <button class="btn btn-secondary" onclick="openSearchModal()">🔍 Search</button>
          <button class="btn btn-secondary" onclick="resyncSessions()">🔄 Resync</button>
          <button class="btn" onclick="startNewSession()">+ New Session</button>
        </div>
      </div>
      <div id="session-list" class="session-list"><div class="spinner"></div></div>
    </div>

    <!-- Practice View -->
    <div id="view-practice" class="card-view">
      <div class="card-header">
        <button class="btn btn-secondary" onclick="showHome()">← Exit</button>
        <span id="progress-text">0/0</span>
        <div class="mode-toggle">
          <button id="mode-flashcard" class="mode-btn active" onclick="setMode('flashcard')">Flashcard</button>
          <button id="mode-quiz" class="mode-btn" onclick="setMode('quiz')">Multiple Choice</button>
        </div>
      </div>

      <div class="flashcard">
        <div id="card-prompt-label" style="display:none; color: var(--muted); font-size:0.9rem; margin-bottom: 0.5rem;">Select the matching vocabulary word:</div>
        <div id="card-word" class="word">Loading...</div>

        <!-- Markdown Definition -->
        <div id="card-answer" class="markdown-content" style="display: none;"></div>

        <!-- Multiple Choice Options -->
        <div id="quiz-container" class="quiz-options" style="display: none;"></div>

        <!-- Reveal Button -->
        <button id="btn-reveal" class="btn" style="margin-top: 1rem;" onclick="revealCard()">Reveal Answer</button>
      </div>

      <div id="answer-actions" class="actions" style="display: none;">
        <button class="btn btn-wrong" onclick="answerCard('incorrect')">Wrong 👎</button>
        <button class="btn btn-right" onclick="answerCard('correct')">Right 👍</button>
      </div>
    </div>

    <!-- Completion View -->
    <div id="view-complete" class="completion-view">
      <h2>Session Completed! 🎉</h2>
      <div id="final-score" class="score">0%</div>
      <p id="final-stats" style="color: var(--muted); margin-bottom: 2rem;"></p>
      <button class="btn" onclick="showHome()">Return to Dashboard</button>
    </div>
  </div>

  <!-- Search Modal -->
  <div id="modal-search" class="modal-overlay" onclick="closeSearchModal(event)">
    <div class="modal-content" onclick="event.stopPropagation()">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h3>Search Vocabulary</h3>
        <button class="btn btn-secondary" style="padding: 0.3rem 0.8rem;" onclick="closeSearchModal()">Esc</button>
      </div>
      <input type="text" id="search-query" class="search-input" placeholder="Type a word..." oninput="handleSearch(this.value)" autofocus />
      <div id="search-results-list" class="search-results"></div>
    </div>
  </div>

  <!-- Word Detail Modal -->
  <div id="modal-word-detail" class="modal-overlay" onclick="closeWordModal(event)">
    <div class="modal-content" onclick="event.stopPropagation()">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span id="detail-ref" class="badge">Part 1</span>
        <button class="btn btn-secondary" style="padding: 0.3rem 0.8rem;" onclick="closeWordModal()">Close</button>
      </div>
      <h2 id="detail-word-title" style="font-size: 2rem; margin-top: 0.5rem;">Word</h2>
      <div id="detail-markdown" class="markdown-content" style="border-top: 1px solid var(--border); margin-top: 0.5rem;"></div>
    </div>
  </div>

  <script>
    let currentSessionId = null;
    let currentCard = null;
    let currentOptions = [];
    let practiceMode = 'flashcard';

    async function loadSessions() {
      const listEl = document.getElementById('session-list');
      listEl.innerHTML = '<div class="spinner"></div>';

      const res = await fetch('/api/sessions');
      const data = await res.json();

      document.getElementById('count-learning').innerText = data.masteryStats.learning || 0;
      document.getElementById('count-reviewing').innerText = data.masteryStats.reviewing || 0;
      document.getElementById('count-learned').innerText = data.masteryStats.learned || 0;

      if (data.sessions.length === 0) {
        listEl.innerHTML = '<p style="color: var(--muted); text-align: center;">No sessions started yet.</p>';
        return;
      }

      listEl.innerHTML = data.sessions.map(s => \`
        <div class="session-item">
          <div style="cursor: pointer; flex: 1;" onclick="openSession(\${s.id})">
            <strong>Session #\${s.id}</strong>
            <div style="font-size: 0.85rem; color: var(--muted)">\${new Date(s.created_at).toLocaleString()}</div>
          </div>
          <div style="display: flex; gap: 1rem; align-items: center;">
            <span>\${s.attempted_cards} / \${s.total_cards}</span>
            <span class="badge \${s.status === 'completed' ? 'completed' : ''}">\${s.status}</span>
            <button class="btn btn-danger" onclick="confirmDeleteSession(\${s.id}, event)">🗑️</button>
          </div>
        </div>
      \`).join('');
    }

    async function confirmDeleteSession(sessionId, event) {
      event.stopPropagation();
      if (confirm(\`Are you sure you want to delete Session #\${sessionId}?\`)) {
        event.target.disabled = true;
        await fetch(\`/api/sessions/\${sessionId}\`, { method: 'DELETE' });
        location.reload();
      }
    }

    async function resyncSessions() {
      const btn = event.target;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner spinner-sm"></span>Syncing...';
      try {
        const res = await fetch('/api/sessions/resync', { method: 'POST' });
        const data = await res.json();
        alert(\`Resynced! Added \${data.added_cards} new card(s) across active sessions.\`);
        loadSessions();
      } finally {
        btn.disabled = false;
        btn.innerHTML = '🔄 Resync';
      }
    }

    async function resetAll() {
      if (!confirm('Are you sure you want to delete ALL sessions and progress? This cannot be undone.')) return;
      const btn = event.target;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner spinner-sm"></span>Resetting...';
      try {
        await fetch('/api/sessions/reset', { method: 'POST' });
        location.reload();
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Reset All';
      }
    }

    async function startNewSession() {
      const btn = event.target;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner spinner-sm"></span>Creating...';
      try {
        const res = await fetch('/api/sessions', { method: 'POST' });
        const data = await res.json();
        openSession(data.id);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '+ New Session';
      }
    }

    async function openSession(id) {
      currentSessionId = id;
      document.getElementById('view-home').style.display = 'none';
      document.getElementById('view-complete').style.display = 'none';
      document.getElementById('view-practice').style.display = 'flex';
      fetchNextCard();
    }

    function setMode(mode) {
      practiceMode = mode;
      document.getElementById('mode-flashcard').classList.toggle('active', mode === 'flashcard');
      document.getElementById('mode-quiz').classList.toggle('active', mode === 'quiz');
      renderCardUI();
    }

    async function fetchNextCard() {
      document.getElementById('card-answer').style.display = 'none';
      document.getElementById('answer-actions').style.display = 'none';
      document.getElementById('btn-reveal').style.display = 'none';
      document.getElementById('quiz-container').style.display = 'none';
      document.getElementById('card-word').style.display = 'block';
      document.getElementById('card-word').innerText = 'Loading...';

      const res = await fetch(\`/api/sessions/\${currentSessionId}/next\`);
      const data = await res.json();

      document.getElementById('progress-text').innerText = \`\${data.stats.attempted}/\${data.stats.total}\`;

      if (!data.card) {
        showCompletion(data.stats);
        return;
      }

      currentCard = data.card;
      currentOptions = data.options;
      renderCardUI();
    }

    function renderCardUI() {
      if (!currentCard) return;

      const wordEl = document.getElementById('card-word');
      const answerEl = document.getElementById('card-answer');

      // Always update the word first
      wordEl.innerText = currentCard.name;
      wordEl.style.display = 'block';

      if (practiceMode === 'flashcard') {
        try {
          const fullMarkdown = currentCard.text + "\\n  <div style='margin-top: 1rem;' /> Reference: " + currentCard.ref;
          answerEl.innerHTML = marked.parse(fullMarkdown);
        } catch(e) {
          answerEl.innerText = currentCard.text;
        }

        document.getElementById('card-prompt-label').style.display = 'none';
        document.getElementById('quiz-container').style.display = 'none';
        document.getElementById('btn-reveal').style.display = 'inline-block';
        answerEl.style.display = 'none';
        document.getElementById('answer-actions').style.display = 'none';
      } else {
        // Multiple Choice Mode: Filter out spoiler lines & cut off content after 🧠 if followed by ---
        let lines = currentCard.text.split('\\n');
        let filteredLines = [];
        let sawBrainEmoji = false;

        for (const line of lines) {
          const trimmed = line.trim();

          // Cut off everything after the brain emoji section if a divider line is hit
          if (sawBrainEmoji && /^---+$/.test(trimmed)) {
            break;
          }

          if (trimmed.startsWith('🧠')) {
            sawBrainEmoji = true;
            continue;
          }

          // 1. Remove header line: "- **word**"
          if (trimmed.startsWith('- **')) continue;

          // 2. Remove Part of Speech lines: "noun", "adjective", "verb", "adverb"
          const cleanPos = trimmed.replace(/[*_]/g, '').toLowerCase();
          if (['noun', 'adjective', 'verb', 'adverb'].includes(cleanPos)) continue;

          // 3. Remove Synonym / Antonym spoiler lines: "syn:", "sync:", "ant:"
          if (/^(syn|sync|ant)\\s*:/i.test(trimmed)) continue;

          filteredLines.push(line);
        }

        let quizText = filteredLines.join('\\n');

        // Blank out exact word occurrences (case-insensitive)
        const wordRegex = new RegExp(\`\\\\b\${currentCard.name}\\\\b\`, 'gi');
        quizText = quizText.replace(wordRegex, '_____');

        answerEl.innerHTML = marked.parse(quizText);

        document.getElementById('card-prompt-label').style.display = 'block';
        document.getElementById('card-word').style.display = 'none';
        document.getElementById('btn-reveal').style.display = 'none';
        document.getElementById('card-answer').style.display = 'block';
        document.getElementById('answer-actions').style.display = 'none';

        const quizContainer = document.getElementById('quiz-container');
        quizContainer.style.display = 'grid';
        quizContainer.innerHTML = currentOptions.map(opt => {
          const safeOpt = opt.replace(/'/g, "\\\\'");
          return \`<button class="quiz-opt-btn" onclick="checkQuizAnswer('\${safeOpt}')">\${opt}</button>\`;
        }).join('');
      }
    }

    function checkQuizAnswer(selectedWord) {
      revealCard();
      if (selectedWord === currentCard.name) {
        alert("Correct! 🎉");
      } else {
        alert(\`Incorrect. The correct word was: \${currentCard.name}\`);
      }
    }

    function revealCard() {
      const answerEl = document.getElementById('card-answer');
      try {
        const fullMarkdown = currentCard.text + "\\n <div style='margin-top: 1rem;' /> Reference: " + currentCard.ref;
        answerEl.innerHTML = marked.parse(fullMarkdown);
      } catch(e) {
        answerEl.innerText = currentCard.text;
      }

      document.getElementById('btn-reveal').style.display = 'none';
      document.getElementById('card-word').style.display = 'block';
      document.getElementById('quiz-container').style.display = 'none';
      answerEl.style.display = 'block';
      showAnswerActions();
    }

    function showAnswerActions() {
      const actions = document.getElementById('answer-actions');
      actions.querySelectorAll('button').forEach(b => { b.disabled = false; });
      actions.style.display = 'flex';
    }

    async function answerCard(answer) {
      if (!currentCard) return;
      const actions = document.getElementById('answer-actions');
      actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
      await fetch(\`/api/cards/\${currentCard.session_card_id}/answer\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer })
      });
      await fetchNextCard();
    }

    function showCompletion(stats) {
      document.getElementById('view-practice').style.display = 'none';
      document.getElementById('view-complete').style.display = 'block';
      const percentage = Math.round((stats.correct / stats.total) * 100) || 0;
      document.getElementById('final-score').innerText = \`\${percentage}%\`;
      document.getElementById('final-stats').innerText = \`Score: \${stats.correct} correct out of \${stats.total} total cards.\`;
    }

    function showHome() {
      document.getElementById('view-home').style.display = 'flex';
      document.getElementById('view-practice').style.display = 'none';
      document.getElementById('view-complete').style.display = 'none';
      loadSessions();
    }

    /* Search UI Functions */
    function openSearchModal() {
      document.getElementById('modal-search').style.display = 'flex';
      const input = document.getElementById('search-query');
      input.value = '';
      input.focus();
      document.getElementById('search-results-list').innerHTML = '';
    }

    function closeSearchModal() {
      document.getElementById('modal-search').style.display = 'none';
    }

    let searchTimeout = null;
    function handleSearch(query) {
      clearTimeout(searchTimeout);
      const resultsList = document.getElementById('search-results-list');
      if (!query.trim()) {
        resultsList.innerHTML = '';
        return;
      }
      resultsList.innerHTML = '<div class="spinner" style="margin: 1rem auto;"></div>';
      searchTimeout = setTimeout(async () => {
        const res = await fetch(\`/api/search?q=\${encodeURIComponent(query)}\`);
        const results = await res.json();

        if (results.length === 0) {
          resultsList.innerHTML = '<p style="color: var(--muted); text-align: center; padding: 1rem;">No matching words found.</p>';
          return;
        }

        resultsList.innerHTML = results.map(item => \`
          <div class="result-item" onclick="openWordDetail(\${JSON.stringify(item).replace(/"/g, '&quot;')})">
            <strong>\${item.name}</strong>
            <span class="badge">\${item.ref}</span>
          </div>
        \`).join('');
      }, 200);
    }

    function openWordDetail(wordData) {
      document.getElementById('detail-word-title').innerText = wordData.name;
      document.getElementById('detail-ref').innerText = wordData.ref;
      document.getElementById('detail-markdown').innerHTML = marked.parse(wordData.text);
      document.getElementById('modal-word-detail').style.display = 'flex';
    }

    function closeWordModal() {
      document.getElementById('modal-word-detail').style.display = 'none';
    }

    loadSessions();
  </script>
</body>
</html>
`;
