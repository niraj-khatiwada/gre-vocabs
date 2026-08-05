import { Database } from "bun:sqlite";
import { join } from "path";

const db = new Database("vocab.sqlite");

// Helper: Fisher-Yates Shuffle
function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const PORT = 3000;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Static Assets: Serve images located inside GRE/
    if (pathname.match(/\.(png|jpg|jpeg|gif|webp)$/i)) {
      const imagePath = join(
        process.cwd(),
        "GRE",
        decodeURIComponent(pathname),
      );
      const file = Bun.file(imagePath);
      if (await file.exists()) {
        return new Response(file);
      }
      return new Response("Image not found", { status: 404 });
    }

    // API: Get List of All Sessions
    if (pathname === "/api/sessions" && req.method === "GET") {
      const sessions = db
        .prepare(
          `
        SELECT
          s.id,
          s.created_at,
          s.status,
          COUNT(sc.id) as total_cards,
          SUM(CASE WHEN sc.status != 'unseen' THEN 1 ELSE 0 END) as completed_cards,
          SUM(CASE WHEN sc.status = 'correct' THEN 1 ELSE 0 END) as correct_cards
        FROM sessions s
        LEFT JOIN session_cards sc ON s.id = sc.session_id
        GROUP BY s.id
        ORDER BY s.id DESC
      `,
        )
        .all();
      return Response.json(sessions);
    }

    // API: Start a New Session
    if (pathname === "/api/sessions" && req.method === "POST") {
      const allVocab = db.prepare("SELECT id FROM vocab").all() as {
        id: number;
      }[];
      if (allVocab.length === 0) {
        return Response.json(
          { error: "No vocabulary words found in database." },
          { status: 400 },
        );
      }

      const shuffledVocab = shuffle([...allVocab]);

      let sessionId: number = 0;
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
        .get(sessionId);

      const stats = db
        .prepare(
          `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status != 'unseen' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'correct' THEN 1 ELSE 0 END) as correct,
          SUM(CASE WHEN status = 'incorrect' THEN 1 ELSE 0 END) as incorrect
        FROM session_cards
        WHERE session_id = ?
      `,
        )
        .get(sessionId);

      return Response.json({ card: nextCard || null, stats });
    }

    // API: Answer Card (Right or Wrong)
    const answerMatch = pathname.match(/^\/api\/cards\/(\d+)\/answer$/);
    if (answerMatch && req.method === "POST") {
      const sessionCardId = Number(answerMatch[1]);
      const { answer } = (await req.json()) as {
        answer: "correct" | "incorrect";
      };

      db.prepare("UPDATE session_cards SET status = ? WHERE id = ?").run(
        answer,
        sessionCardId,
      );

      // Check if session completed
      const card = db
        .prepare("SELECT session_id FROM session_cards WHERE id = ?")
        .get(sessionCardId) as { session_id: number };
      const remaining = db
        .prepare(
          "SELECT COUNT(*) as count FROM session_cards WHERE session_id = ? AND status = 'unseen'",
        )
        .get(card.session_id) as { count: number };

      if (remaining.count === 0) {
        db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(
          card.session_id,
        );
      }

      return Response.json({ success: true });
    }

    // Serve HTML Dashboard Frontend
    if (pathname === "/") {
      return new Response(HTML_CONTENT, {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Flashcard App running at http://localhost:${PORT}`);

// Inline Frontend HTML/CSS/JS
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GRE Flashcards</title>
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
      padding: 0.8rem 1.5rem;
      font-size: 1rem;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--text); }
    .btn-secondary:hover { background: var(--border); }

    /* Dashboard */
    .dashboard { display: flex; flex-direction: column; gap: 1.5rem; }
    .action-bar { display: flex; justify-content: space-between; align-items: center; }
    .session-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .session-item {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
    }
    .session-item:hover { border-color: var(--primary); }
    .badge { padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; background: var(--border); }
    .badge.completed { background: var(--success); color: #000; }

    /* Card View */
    .card-view { display: none; flex-direction: column; gap: 1.5rem; }
    .card-header { display: flex; justify-content: space-between; align-items: center; color: var(--muted); }
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
    }
    .word { font-size: 2.5rem; font-weight: 700; margin-bottom: 1rem; color: #fff; }
    .markdown-content {
      text-align: left;
      width: 100%;
      margin-top: 1.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      line-height: 1.6;
    }
    .markdown-content img { max-width: 100%; height: auto; border-radius: 8px; margin: 1rem 0; }

    .actions { display: flex; gap: 1rem; justify-content: center; }
    .btn-right { background: var(--success); flex: 1; }
    .btn-wrong { background: var(--danger); flex: 1; }

    /* Completion View */
    .completion-view { display: none; text-align: center; padding: 3rem 1rem; }
    .score { font-size: 3rem; font-weight: bold; color: var(--success); margin: 1rem 0; }
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
      <div class="action-bar">
        <h2>Practice Sessions</h2>
        <button class="btn" onclick="startNewSession()">+ New Session</button>
      </div>
      <div id="session-list" class="session-list"></div>
    </div>

    <!-- Practice View -->
    <div id="view-practice" class="card-view">
      <div class="card-header">
        <button class="btn btn-secondary" onclick="showHome()">← Exit</button>
        <span id="progress-text">0/0</span>
        <span id="ref-tag" class="badge">Part 1</span>
      </div>

      <div class="flashcard">
        <div id="card-word" class="word">Loading...</div>
        <button id="btn-reveal" class="btn" onclick="revealCard()">Reveal Answer</button>
        <div id="card-answer" class="markdown-content" style="display: none;"></div>
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

  <script>
    let currentSessionId = null;
    let currentCard = null;

    async function loadSessions() {
      const res = await fetch('/api/sessions');
      const sessions = await res.json();
      const listEl = document.getElementById('session-list');

      if (sessions.length === 0) {
        listEl.innerHTML = '<p style="color: var(--muted); text-align: center;">No sessions started yet.</p>';
        return;
      }

      listEl.innerHTML = sessions.map(s => \`
        <div class="session-item" onclick="openSession(\${s.id})">
          <div>
            <strong>Session #\${s.id}</strong>
            <div style="font-size: 0.85rem; color: var(--muted)">\${new Date(s.created_at).toLocaleString()}</div>
          </div>
          <div style="display: flex; gap: 1rem; align-items: center;">
            <span>\${s.completed_cards} / \${s.total_cards}</span>
            <span class="badge \${s.status === 'completed' ? 'completed' : ''}">\${s.status}</span>
          </div>
        </div>
      \`).join('');
    }

    async function startNewSession() {
      const res = await fetch('/api/sessions', { method: 'POST' });
      const data = await res.json();
      openSession(data.id);
    }

    async function openSession(id) {
      currentSessionId = id;
      document.getElementById('view-home').style.display = 'none';
      document.getElementById('view-complete').style.display = 'none';
      document.getElementById('view-practice').style.display = 'flex';
      fetchNextCard();
    }

    async function fetchNextCard() {
      // Reset card UI
      document.getElementById('card-answer').style.display = 'none';
      document.getElementById('answer-actions').style.display = 'none';
      document.getElementById('btn-reveal').style.display = 'inline-block';

      const res = await fetch(\`/api/sessions/\${currentSessionId}/next\`);
      const data = await res.json();

      document.getElementById('progress-text').innerText = \`\${data.stats.completed}/\${data.stats.total}\`;

      if (!data.card) {
        showCompletion(data.stats);
        return;
      }

      currentCard = data.card;
      document.getElementById('card-word').innerText = currentCard.name;
      document.getElementById('ref-tag').innerText = currentCard.ref;

      // Parse markdown text using marked.js
      document.getElementById('card-answer').innerHTML = marked.parse(currentCard.text);
    }

    function revealCard() {
      document.getElementById('btn-reveal').style.display = 'none';
      document.getElementById('card-answer').style.display = 'block';
      document.getElementById('answer-actions').style.display = 'flex';
    }

    async function answerCard(answer) {
      if (!currentCard) return;
      await fetch(\`/api/cards/\${currentCard.session_card_id}/answer\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer })
      });
      fetchNextCard();
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

    // Initial Load
    loadSessions();
  </script>
</body>
</html>
`;
