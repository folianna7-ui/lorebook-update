# 📖 Lorebook Auto-Updater — SillyTavern Extension

Automatically scans your recent chat messages and creates/updates World Info (lorebook) entries using your configured AI.

---

## ✨ Features

- **Scan & Generate** — Reads your last N chat messages and existing lorebook entries, then asks the AI to suggest new or updated entries
- **Interactive Preview** — Review all suggestions before saving: edit content, change keywords, reorder via drag & drop, set target book per entry
- **Tabs & Filters** — Filter preview by New / Updated / Skipped
- **Per-Entry Control** — Apply individual entries or all at once; remove unwanted suggestions
- **Customizable Prompt** — Full control over the system prompt sent to the AI
- **Auto-Run** — Optionally trigger a scan automatically every X messages
- **Multi-Book Support** — Select multiple lorebooks to scan; AI will suggest updates for entries across all of them

---

## 📦 Installation

1. In SillyTavern, open **Extensions** → **Install Extension**
2. Paste the URL of this repository
3. Click **Install**

Or manually: copy the `SillyTavern-LoreboookUpdater` folder into:
```
SillyTavern/public/scripts/extensions/third-party/
```

---

## 🚀 Usage

1. Open **Extensions** panel → expand **Lorebook Auto-Updater**
2. Click **Refresh List** and select the lorebook(s) you want to update
3. Set the number of messages to scan (default: 20)
4. Click **🔍 Scan & Generate Entries**
5. Wait for the AI response — a preview popup will appear
6. Review, edit, drag-to-reorder, then click **✅ Apply to Lorebook**

---

## ⚙️ Settings

| Setting | Default | Description |
|---|---|---|
| Messages to scan | 20 | How many recent chat messages the AI analyzes |
| Auto-run | Off | Automatically scan every N new messages |
| Auto-run interval | 5 | Number of messages between auto-scans |
| System prompt | (built-in) | Full AI prompt controlling behavior |

---

## 🤖 AI Requirements

- Needs a working AI connection in SillyTavern (any supported API)
- Works best with capable models (GPT-4, Claude, Gemini, etc.)
- The AI must be able to output valid JSON — local RP models may struggle
- Recommended: increase max response tokens to 2000+

---

## 🔧 Tips

- **Prompt tuning**: The default prompt asks for JSON with `create`/`update`/`skip` actions. You can customize it to focus on specific topics (e.g., "Only track character relationships").
- **First run**: On an empty lorebook, the AI will create new entries for everything it finds interesting. On subsequent runs, it will also suggest updates.
- **Review carefully**: Always check AI suggestions before applying — especially updates to existing entries.

---

## 📝 License

MIT
